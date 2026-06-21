/**
 * Poll API Routes
 * REST API for poll template management and poll sending via API keys
 */
import express from "express";
import { db } from "../lib/db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import { resolveSessionForUser } from "../lib/sessions.js";

const router = express.Router();

// Helper: Authenticate via Bearer token API key (same as server.js)
async function authenticateApiKey(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: "Missing or invalid Authorization header. Use: Bearer <apiKey>", status: 401 };

  const apiKey = match[1];
  const keyData = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.apiKey, apiKey));

  if (!keyData.length || !keyData[0].isActive) {
    return { error: "Invalid or revoked API key", status: 401 };
  }

  try {
    await db.update(schema.apiKeys).set({ lastUsed: new Date() }).where(eq(schema.apiKeys.id, keyData[0].id));
  } catch (e) {}

  return { userId: keyData[0].userId, apiKeyId: keyData[0].id, sessionId: keyData[0].sessionId };
}

/**
 * POST /api/polls/create
 * Create a poll template
 * Headers: Authorization: Bearer <apiKey>
 * Body: { name, question, options: ["opt1", "opt2"], allowMultipleAnswers: false }
 */
router.post("/create", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });

    const { name, question, options, allowMultipleAnswers } = req.body;
    const userId = auth.userId;

    if (!name || !question || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ success: false, error: "name, question, and at least 2 options are required" });
    }

    const variables = JSON.stringify({
      pollOptions: options.filter(o => o && o.trim()),
      allowMultipleAnswers: allowMultipleAnswers === true,
    });

    const result = await db.insert(schema.templates).values({
      userId,
      name,
      type: "poll",
      content: question,
      variables,
    }).returning();

    res.json({ success: true, data: { templateId: result[0].id, name, question, options } });
  } catch (error) {
    console.error("[API Polls] create error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/polls
 * List poll templates for the authenticated user
 * Headers: Authorization: Bearer <apiKey>
 */
router.get("/", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });

    const polls = await db.select().from(schema.templates)
      .where(and(eq(schema.templates.userId, auth.userId), eq(schema.templates.type, "poll")));

    const data = polls.map(p => {
      let parsedVars = {};
      try { parsedVars = JSON.parse(p.variables || '{}'); } catch (e) {}
      return {
        id: p.id,
        name: p.name,
        question: p.content,
        options: parsedVars.pollOptions || [],
        allowMultipleAnswers: !!parsedVars.allowMultipleAnswers,
        isActive: p.isActive,
        createdAt: p.createdAt,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error("[API Polls] list error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/polls/send
 * Send a poll to a single phone number
 * Headers: Authorization: Bearer <apiKey>
 * Body: { sessionId, phone, templateId } OR { sessionId, phone, question, options: [], allowMultipleAnswers }
 */
router.post("/send", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });

    const { sessionId, phone, templateId, question, options, allowMultipleAnswers } = req.body;
    const userId = auth.userId;

    // Resolve session: body > apiKey default > shared admin session
    let resolvedSessionId = sessionId ? parseInt(sessionId) : null;
    if (!resolvedSessionId && auth.sessionId) {
      resolvedSessionId = auth.sessionId;
    }
    if (!resolvedSessionId) {
      const resolved = await resolveSessionForUser({ userId, isAdmin: false, providedSessionId: null });
      if (resolved.error) {
        return res.status(400).json({ success: false, error: resolved.error });
      }
      resolvedSessionId = resolved.sessionId;
    }

    if (!resolvedSessionId) {
      return res.status(400).json({
        success: false,
        error: "sessionId is required. Either pass it in the request body, or link your API key to a WhatsApp session at /developer/api-keys"
      });
    }
    if (!phone) return res.status(400).json({ success: false, error: "phone is required" });

    let pollQuestion = question;
    let pollOptions = Array.isArray(options) ? options.filter(o => o && o.trim()) : [];
    let pollAllowMultiple = allowMultipleAnswers === true;

    // If templateId provided, load from template
    if (templateId) {
      const tpl = await db.select().from(schema.templates)
        .where(and(eq(schema.templates.id, parseInt(templateId)), eq(schema.templates.userId, userId)));
      if (!tpl.length) return res.status(404).json({ success: false, error: "Poll template not found" });
      pollQuestion = tpl[0].content;
      let vars = {};
      try { vars = JSON.parse(tpl[0].variables || '{}'); } catch (e) {}
      pollOptions = vars.pollOptions || [];
      pollAllowMultiple = !!vars.allowMultipleAnswers;
    }

    if (!pollQuestion) return res.status(400).json({ success: false, error: "question is required (or use templateId)" });
    if (pollOptions.length < 2) return res.status(400).json({ success: false, error: "At least 2 options are required" });

    // Verify session ownership (or shared session)
    const sessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, parseInt(resolvedSessionId)));
    if (!sessions.length || (sessions[0].userId !== userId && !sessions[0].isShared)) {
      return res.status(403).json({ success: false, error: "Session not found or unauthorized" });
    }

    // Check credits
    const creditCheck = await checkCredits(userId, "poll_message", 1);
    if (!creditCheck.allowed) {
      return res.status(402).json({ success: false, error: creditCheck.message });
    }

    const interactiveData = {
      options: pollOptions,
      allowMultipleAnswers: pollAllowMultiple,
    };

    const result = await req.waManager.sendMessage(
      parseInt(resolvedSessionId),
      phone,
      pollQuestion,
      "poll",
      null,
      interactiveData
    );

    await chargeCredits(userId, "poll_message", 1, `API poll sent to ${phone}`);

    res.json({
      success: true,
      data: {
        messageId: result?.id?._serialized || result?.id,
        phone,
        question: pollQuestion,
        options: pollOptions,
        allowMultipleAnswers: pollAllowMultiple,
      },
    });
  } catch (error) {
    console.error("[API Polls] send error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/polls/send-bulk
 * Send a poll to multiple contacts
 * Headers: Authorization: Bearer <apiKey>
 * Body: { sessionId, templateId, phones: ["91...", "91..."] } OR { sessionId, question, options, phones }
 */
router.post("/send-bulk", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });

    const { sessionId, templateId, question, options, phones, allowMultipleAnswers, gapSeconds = 30 } = req.body;
    const userId = auth.userId;

    // Resolve session: body > apiKey default > shared admin session
    let resolvedSessionId = sessionId ? parseInt(sessionId) : null;
    if (!resolvedSessionId && auth.sessionId) {
      resolvedSessionId = auth.sessionId;
    }
    if (!resolvedSessionId) {
      const resolved = await resolveSessionForUser({ userId, isAdmin: false, providedSessionId: null });
      if (resolved.error) {
        return res.status(400).json({ success: false, error: resolved.error });
      }
      resolvedSessionId = resolved.sessionId;
    }

    if (!resolvedSessionId) {
      return res.status(400).json({
        success: false,
        error: "sessionId is required. Either pass it in the request body, or link your API key to a WhatsApp session at /developer/api-keys"
      });
    }
    if (!Array.isArray(phones) || phones.length === 0) return res.status(400).json({ success: false, error: "phones array is required" });

    let pollQuestion = question;
    let pollOptions = Array.isArray(options) ? options.filter(o => o && o.trim()) : [];
    let pollAllowMultiple = allowMultipleAnswers === true;

    if (templateId) {
      const tpl = await db.select().from(schema.templates)
        .where(and(eq(schema.templates.id, parseInt(templateId)), eq(schema.templates.userId, userId)));
      if (!tpl.length) return res.status(404).json({ success: false, error: "Poll template not found" });
      pollQuestion = tpl[0].content;
      let vars = {};
      try { vars = JSON.parse(tpl[0].variables || '{}'); } catch (e) {}
      pollOptions = vars.pollOptions || [];
      pollAllowMultiple = !!vars.allowMultipleAnswers;
    }

    if (!pollQuestion) return res.status(400).json({ success: false, error: "question is required (or use templateId)" });
    if (pollOptions.length < 2) return res.status(400).json({ success: false, error: "At least 2 options are required" });

    // Check credits
    const creditCheck = await checkCredits(userId, "poll_message", phones.length);
    if (!creditCheck.allowed) {
      return res.status(402).json({ success: false, error: creditCheck.message });
    }

    const interactiveData = {
      options: pollOptions,
      allowMultipleAnswers: pollAllowMultiple,
    };

    const results = [];
    for (let i = 0; i < phones.length; i++) {
      try {
        await req.waManager.sendMessage(
          parseInt(resolvedSessionId),
          phones[i],
          pollQuestion,
          "poll",
          null,
          interactiveData
        );
        results.push({ phone: phones[i], status: "sent" });
      } catch (err) {
        results.push({ phone: phones[i], status: "failed", error: err.message });
      }
      if (i < phones.length - 1) {
        await new Promise(r => setTimeout(r, gapSeconds * 1000));
      }
    }

    const sentCount = results.filter(r => r.status === "sent").length;
    await chargeCredits(userId, "poll_message", sentCount, `API bulk poll: ${sentCount} sent`);

    res.json({ success: true, data: { total: phones.length, sent: sentCount, failed: phones.length - sentCount, results } });
  } catch (error) {
    console.error("[API Polls] send-bulk error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/polls/results
 * Get poll vote results from lead data
 * Headers: Authorization: Bearer <apiKey>
 * Query: ?pollName=optionalFilter
 */
router.get("/results", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });

    const userId = auth.userId;
    const pollNameFilter = (req.query.pollName || "").toLowerCase().trim();

    // Get all leads for this user that have poll vote data
    const leads = await db.select().from(schema.leads).where(eq(schema.leads.userId, userId));

    const results = [];
    for (const lead of leads) {
      let leadData = {};
      try { leadData = lead.data ? JSON.parse(lead.data) : {}; } catch (e) {}
      const pollVotes = leadData.pollVotes || [];

      for (const vote of pollVotes) {
        if (pollNameFilter && !(vote.pollName || "").toLowerCase().includes(pollNameFilter)) continue;
        results.push({
          leadId: lead.id,
          leadName: lead.name,
          phone: lead.phone,
          pollName: vote.pollName,
          selectedOptions: vote.selectedOptions,
          votedAt: vote.votedAt,
        });
      }
    }

    // Aggregate by poll name
    const aggregates = {};
    for (const r of results) {
      if (!aggregates[r.pollName]) aggregates[r.pollName] = {};
      for (const opt of r.selectedOptions) {
        aggregates[r.pollName][opt] = (aggregates[r.pollName][opt] || 0) + 1;
      }
    }

    res.json({
      success: true,
      data: {
        totalVotes: results.length,
        votes: results,
        aggregates,
      },
    });
  } catch (error) {
    console.error("[API Polls] results error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
