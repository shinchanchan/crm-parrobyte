import express from "express";
import { db } from "../lib/db.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { resolveSessionForUser, getSharedSession } from "../lib/sessions.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";

const router = express.Router();

function normalizePhone(phone, countryCode) {
  if (!phone) return null;
  if (phone.includes("@lid") || phone.includes("@c.us") || phone.includes("@g.us")) {
    return phone;
  }
  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("0")) {
    digits = digits.substring(1);
  }
  if (digits.length === 10) {
    digits = (countryCode || "91") + digits;
  }
  return digits + "@c.us";
}

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Query leads
    let leadsQuery;
    if (isAdmin) {
      leadsQuery = await db.select().from(schema.leads);
    } else {
      // Non-admin users only see their own leads (strict isolation)
      leadsQuery = await db.select().from(schema.leads).where(eq(schema.leads.userId, userId));
    }

    // Build contact lookup map (phone+userId → contact name) for voter name enrichment
    const contactLookups = [];
    for (const lead of leadsQuery) {
      if (lead.phone) {
        contactLookups.push({ userId: lead.userId, phone: lead.phone });
      }
    }
    const contactNameMap = new Map();
    if (contactLookups.length) {
      try {
        const allPhones = [...new Set(contactLookups.map(c => c.phone))];
        // Query contacts for matching phones (scoped by userId for non-admin, all for admin)
        const contactRows = isAdmin
          ? await db.select().from(schema.contacts).where(inArray(schema.contacts.phone, allPhones))
          : await db.select().from(schema.contacts)
              .where(and(
                eq(schema.contacts.userId, userId),
                inArray(schema.contacts.phone, allPhones)
              ));
        for (const c of contactRows) {
          contactNameMap.set(`${c.userId}_${c.phone}`, c.name);
        }
      } catch (e) {
        // Contact lookup failed — proceed without enrichment
      }
    }

    // Extract poll votes from lead data
    let allVotes = [];
    for (const lead of leadsQuery) {
      let leadData = {};
      try { leadData = lead.data ? JSON.parse(lead.data) : {}; } catch (e) {}
      const pollVotes = leadData.pollVotes || [];

      // Use contact name if available, otherwise fallback to lead name
      const contactKey = `${lead.userId}_${lead.phone}`;
      const displayName = contactNameMap.get(contactKey) || lead.name || lead.phone;

      for (const vote of pollVotes) {
        allVotes.push({
          leadId: lead.id,
          leadName: displayName,
          phone: lead.phone,
          source: lead.source,
          status: lead.status,
          pollName: vote.pollName || "Poll",
          selectedOptions: vote.selectedOptions || [],
          votedAt: vote.votedAt,
        });
      }
    }

    // Sort by votedAt desc (newest first)
    allVotes.sort((a, b) => new Date(b.votedAt || 0) - new Date(a.votedAt || 0));

    // Get unique poll names for filter dropdown
    const pollNames = [...new Set(allVotes.map(v => v.pollName).filter(Boolean))];

    // Apply filters from query
    const search = (req.query.search || "").toLowerCase().trim();
    const pollFilter = req.query.poll || "";
    const optionFilter = req.query.option || "";

    let filteredVotes = allVotes;

    if (search) {
      filteredVotes = filteredVotes.filter(v =>
        (v.leadName || "").toLowerCase().includes(search) ||
        (v.phone || "").toLowerCase().includes(search) ||
        (v.pollName || "").toLowerCase().includes(search) ||
        (v.selectedOptions || []).some(o => o.toLowerCase().includes(search))
      );
    }

    if (pollFilter) {
      filteredVotes = filteredVotes.filter(v => v.pollName === pollFilter);
    }

    if (optionFilter) {
      filteredVotes = filteredVotes.filter(v =>
        (v.selectedOptions || []).some(o => o.toLowerCase() === optionFilter.toLowerCase())
      );
    }

    // Aggregates
    const aggregates = {};
    for (const v of filteredVotes) {
      if (!aggregates[v.pollName]) aggregates[v.pollName] = {};
      for (const opt of v.selectedOptions) {
        aggregates[v.pollName][opt] = (aggregates[v.pollName][opt] || 0) + 1;
      }
    }

    // Pagination
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = parseInt(req.query.perPage) || 20;
    const total = filteredVotes.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * perPage;
    const paginatedVotes = filteredVotes.slice(start, start + perPage);

    // Page range
    let startPage = Math.max(1, safePage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
    const pageRange = [];
    for (let i = startPage; i <= endPage; i++) pageRange.push(i);

    // Fetch sessions + templates for the "Send Message to Voters" modal
    // Admin sees all sessions; non-admin sees own + shared
    let sessionsQuery;
    if (isAdmin) {
      sessionsQuery = await db.select().from(schema.whatsappSessions);
    } else {
      sessionsQuery = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.userId, userId));
    }
    const sharedSession = await getSharedSession();
    const availableSessions = [];
    const seenIds = new Set();
    for (const s of sessionsQuery) {
      if (seenIds.has(s.id)) continue;
      seenIds.add(s.id);
      const status = req.waManager ? req.waManager.getSessionStatus(s.id, s.userId) : { status: s.status };
      // A session is available if it's connected in memory OR marked connected in DB
      // (send endpoint auto-reconnects if client is missing)
      const isConnected = status.status === 'connected' || s.status === 'connected';
      if (isConnected) {
        const reconnectingLabel = status.status !== 'connected' && status.status !== 'connecting' ? ' — click to reconnect' : '';
        availableSessions.push({ ...s, realtimeStatus: status.status, label: `${s.sessionName} (${s.phoneNumber || 'User ' + s.userId})${reconnectingLabel}` });
      }
    }
    if (sharedSession && !seenIds.has(sharedSession.id)) {
      const status = req.waManager ? req.waManager.getSessionStatus(sharedSession.id, sharedSession.userId) : { status: sharedSession.status };
      const isConnected = status.status === 'connected' || sharedSession.status === 'connected';
      if (isConnected) {
        const reconnectingLabel = status.status !== 'connected' && status.status !== 'connecting' ? ' — click to reconnect' : '';
        availableSessions.push({ ...sharedSession, realtimeStatus: status.status, label: `${sharedSession.sessionName} (Admin - ${sharedSession.phoneNumber})${reconnectingLabel}` });
      }
    }
    // Templates: admin sees all, non-admin sees own
    let templatesQuery;
    if (isAdmin) {
      templatesQuery = await db.select().from(schema.templates);
    } else {
      templatesQuery = await db.select().from(schema.templates)
        .where(eq(schema.templates.userId, userId));
    }

    const templates = templatesQuery;

    // Collect all unique options across all polls for filter chips
    const allOptions = [...new Set(allVotes.flatMap(v => v.selectedOptions).filter(Boolean))];

    res.render("pages/pollResults/index", {
      title: "Poll Results - ParroByte CRM",
      votes: paginatedVotes,
      aggregates,
      pollNames,
      allOptions,
      search,
      pollFilter,
      optionFilter,
      isAdmin,
      sessions: availableSessions,
      availableSessions,
      templates,
      pagination: {
        page: safePage,
        perPage,
        total,
        totalPages,
        pageRange,
        hasPrev: safePage > 1,
        hasNext: safePage < totalPages,
      },
    });
  } catch (error) {
    console.error("Poll results error:", error);
    req.flash("error", "Failed to load poll results");
    res.redirect("/dashboard");
  }
});

// Send WhatsApp messages to selected poll voters
router.post("/send-messages", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { voterIds, sessionId, message, templateId, messageType } = req.body;

    if (!voterIds || !voterIds.length) {
      req.flash("error", "No voters selected");
      return res.redirect("/polls");
    }

    // Resolve session
    const resolved = await resolveSessionForUser({ userId, isAdmin, providedSessionId: sessionId });
    if (resolved.error) {
      req.flash("error", resolved.error);
      return res.redirect("/polls");
    }
    const resolvedSessionId = resolved.sessionId;

    // Verify session in memory
    const sessionCheck = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, resolvedSessionId));
    if (!sessionCheck.length) {
      req.flash("error", "Session not found");
      return res.redirect("/polls");
    }
    const memStatus = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
    if (memStatus.status !== "connected") {
      try {
        await req.waManager.reconnectSession(resolvedSessionId);
        await new Promise(r => setTimeout(r, 3000));
        const reconnected = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
        if (reconnected.status !== "connected") throw new Error("Reconnect failed");
      } catch (e) {
        req.flash("error", "WhatsApp session is disconnected. Please reconnect it.");
        return res.redirect("/polls");
      }
    }

    // Fetch voter leads
    // Parse voterIds — can be JSON string from hidden input or array
    let voterIdList = [];
    if (typeof voterIds === 'string' && voterIds.startsWith('[')) {
      try { voterIdList = JSON.parse(voterIds).map(Number).filter(id => !isNaN(id) && id > 0); } catch (e) { voterIdList = []; }
    } else if (Array.isArray(voterIds)) {
      voterIdList = voterIds.map(Number).filter(id => !isNaN(id) && id > 0);
    } else if (voterIds) {
      const n = Number(voterIds);
      if (!isNaN(n) && n > 0) voterIdList = [n];
    }
    if (!voterIdList.length) {
      req.flash("error", "No valid voters selected");
      return res.redirect("/polls");
    }
    const voterLeads = isAdmin
      ? await db.select().from(schema.leads).where(inArray(schema.leads.id, voterIdList))
      : await db.select().from(schema.leads).where(and(
          inArray(schema.leads.id, voterIdList),
          eq(schema.leads.userId, userId)
        ));

    // Get message content
    let finalMessage = message || "";
    let msgType = messageType || "text";
    let mediaUrl = null;
    if (templateId) {
      const templateRows = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, parseInt(templateId)));
      if (templateRows.length && (templateRows[0].userId === userId || isAdmin)) {
        finalMessage = templateRows[0].content;
        msgType = templateRows[0].type || "text";
        mediaUrl = templateRows[0].mediaUrl || null;
      }
    }

    if (!finalMessage.trim()) {
      req.flash("error", "Message cannot be empty");
      return res.redirect("/polls");
    }

    // Check credits
    const creditService = msgType === "poll" ? "poll_message" : "send_message";
    const creditCheck = await checkCredits(userId, creditService, voterLeads.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/polls");
    }

    const results = [];
    for (let i = 0; i < voterLeads.length; i++) {
      const lead = voterLeads[i];
      if (!lead.phone) continue;
      try {
        const normalizedPhone = normalizePhone(lead.phone, lead.countryCode);
        await req.waManager.sendMessage(resolvedSessionId, normalizedPhone, finalMessage, msgType, mediaUrl);
        results.push({ phone: lead.phone, status: "success" });
      } catch (err) {
        results.push({ phone: lead.phone, status: "failed", error: err.message });
      }
      if (i < voterLeads.length - 1) {
        await new Promise(r => setTimeout(r, 30000));
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    let deductedCredits = 0;
    if (successCount > 0) {
      try {
        const creditService = msgType === "poll" ? "poll_message" : "send_message";
        const creditResult = await chargeCredits(req, creditService, successCount, `Sent messages to ${successCount} poll voter(s)`);
        deductedCredits = creditResult.deducted || 0;
      } catch (creditErr) {
        req.flash("error", `Messages sent but credit deduction failed: ${creditErr.message}`);
      }
    }
    req.flash("success", `Sent to ${successCount} voters, ${results.filter(r => r.status === "failed").length} failed (₹${deductedCredits} credits deducted)`);
    res.redirect("/polls");
  } catch (error) {
    console.error("Send to voters error:", error);
    req.flash("error", "Failed to send messages to voters");
    res.redirect("/polls");
  }
});

// Delete a specific poll vote from a lead (remove from lead.data.pollVotes)
router.post("/delete-vote", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { leadId, votedAt } = req.body;

    if (!leadId || !votedAt) {
      req.flash("error", "Missing vote details");
      return res.redirect("/polls");
    }

    const leadRows = await db.select().from(schema.leads).where(eq(schema.leads.id, parseInt(leadId)));
    if (!leadRows.length || (leadRows[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/polls");
    }

    const lead = leadRows[0];
    let leadData = {};
    try { leadData = lead.data ? JSON.parse(lead.data) : {}; } catch (e) { leadData = {}; }

    if (!Array.isArray(leadData.pollVotes)) {
      req.flash("error", "No poll votes found");
      return res.redirect("/polls");
    }

    const beforeCount = leadData.pollVotes.length;
    leadData.pollVotes = leadData.pollVotes.filter(v => v.votedAt !== votedAt);
    const afterCount = leadData.pollVotes.length;

    if (afterCount === beforeCount) {
      req.flash("error", "Vote not found");
      return res.redirect("/polls");
    }

    // If no more poll votes, delete the entire lead (it was created just for poll votes)
    if (afterCount === 0 && lead.source === "poll_vote") {
      await db.delete(schema.leads).where(eq(schema.leads.id, lead.id));
      req.flash("success", "Poll voter deleted — no remaining votes");
    } else {
      await db.update(schema.leads)
        .set({ data: JSON.stringify(leadData), updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
      req.flash("success", "Poll vote deleted");
    }
    res.redirect("/polls");
  } catch (error) {
    console.error("Delete poll vote error:", error);
    req.flash("error", "Failed to delete poll vote");
    res.redirect("/polls");
  }
});

// Bulk delete selected poll voter leads
router.post("/delete-leads", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { voterIds } = req.body;

    let voterIdList = [];
    if (typeof voterIds === 'string' && voterIds.startsWith('[')) {
      try { voterIdList = JSON.parse(voterIds).map(Number).filter(id => !isNaN(id) && id > 0); } catch (e) { voterIdList = []; }
    } else if (Array.isArray(voterIds)) {
      voterIdList = voterIds.map(Number).filter(id => !isNaN(id) && id > 0);
    } else if (voterIds) {
      const n = Number(voterIds);
      if (!isNaN(n) && n > 0) voterIdList = [n];
    }

    if (!voterIdList.length) {
      req.flash("error", "No voters selected");
      return res.redirect("/polls");
    }

    // Fetch leads and verify ownership
    const leads = await db.select().from(schema.leads).where(inArray(schema.leads.id, voterIdList));
    const deletableIds = leads.filter(l => l.userId === userId || isAdmin).map(l => l.id);

    if (!deletableIds.length) {
      req.flash("error", "Unauthorized or no valid voters selected");
      return res.redirect("/polls");
    }

    await db.delete(schema.leads).where(inArray(schema.leads.id, deletableIds));
    req.flash("success", `Deleted ${deletableIds.length} poll voter(s)`);
    res.redirect("/polls");
  } catch (error) {
    console.error("Delete poll voters error:", error);
    req.flash("error", "Failed to delete poll voters");
    res.redirect("/polls");
  }
});

export default router;
