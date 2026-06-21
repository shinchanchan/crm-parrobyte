import express from "express";
import { db } from "../lib/db.js";
import { eq, and, inArray, gte, lte } from "drizzle-orm";
import { paginate } from "../lib/paginate.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import * as schema from "../../db/schema.js";
import { resolveSessionForUser, getSharedSession } from "../lib/sessions.js";
import path from "path";
import { fileURLToPath } from "url";
import { sanitizeFilename } from "../lib/sanitize.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * Normalize phone number for WhatsApp
 * - If already has @lid or @c.us or @g.us, return as-is (WhatsApp internal IDs)
 * - For raw digit-only numbers: remove leading 0, add country code, append @c.us
 */
function normalizePhone(phone, countryCode) {
  if (!phone) return null;

  // Already a WhatsApp internal ID - NEVER modify these
  if (phone.includes("@lid") || phone.includes("@c.us") || phone.includes("@g.us")) {
    return phone;
  }

  let digits = String(phone).replace(/\D/g, "");

  // Remove leading 0
  if (digits.startsWith("0")) {
    digits = digits.substring(1);
  }

  // If exactly 10 digits, add country code
  if (digits.length === 10) {
    digits = (countryCode || "91") + digits;
  }

  return digits + "@c.us";
}

// Get bulk message page
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Get user's own sessions + shared sessions for the dropdown
    let sessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.userId, userId));

    // Enhance with real-time status for accurate filtering
    for (const s of sessions) {
      const rt = req.waManager.getSessionStatus(s.id, s.userId);
      s.realtimeStatus = rt.status;
    }

    const contacts = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.userId, userId));
    const groups = [...new Set(contacts.map((c) => c.group).filter(Boolean))];
    const tags = [...new Set(contacts.map((c) => c.tags).filter(Boolean).flatMap((t) => t.split(/[,;]/).map((s) => s.trim()).filter(Boolean)))];
    const templates = await db.select().from(schema.templates)
      .where(eq(schema.templates.userId, userId));

    // Fetch user's questionnaires for targeting filters
    const questionnaires = await db.select().from(schema.sessionQuestionnaires)
      .where(eq(schema.sessionQuestionnaires.userId, userId));
    let questionnaireQuestions = [];
    if (questionnaires.length) {
      questionnaireQuestions = await db.select().from(schema.sessionQuestionnaireQuestions)
        .where(inArray(schema.sessionQuestionnaireQuestions.questionnaireId, questionnaires.map(q => q.id)));
    }

    // Get any active bulk job from session
    const activeJob = req.session.bulkJob || null;

    // Date range filter for job history
    const fromDate = req.query.from ? new Date(req.query.from) : null;
    const toDate = req.query.to ? new Date(req.query.to) : null;
    const dateFilters = [eq(schema.bulkMessageJobs.userId, userId)];
    if (fromDate && !isNaN(fromDate)) {
      dateFilters.push(gte(schema.bulkMessageJobs.createdAt, fromDate));
    }
    if (toDate && !isNaN(toDate)) {
      // Add 1 day to include the full end date
      const endOfDay = new Date(toDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      dateFilters.push(lte(schema.bulkMessageJobs.createdAt, endOfDay));
    }

    // Get bulk job history with pagination
    const result = await paginate({
      db,
      schema: schema.bulkMessageJobs,
      req,
      where: dateFilters.length > 1 ? and(...dateFilters) : dateFilters[0],
      searchableColumns: ["content"],
      defaultSort: { column: schema.bulkMessageJobs.createdAt, dir: "desc" },
    });

    const sharedSession = await getSharedSession();

    // Build unified available sessions list (own + shared)
    const availableSessions = [];
    const seenIds = new Set();
    for (const s of sessions) {
      if (!seenIds.has(s.id)) {
        seenIds.add(s.id);
        availableSessions.push({ ...s, label: s.sessionName + (s.phoneNumber ? ` (${s.phoneNumber})` : ''), isShared: false });
      }
    }
    if (sharedSession && !seenIds.has(sharedSession.id)) {
      availableSessions.push({
        ...sharedSession,
        realtimeStatus: req.waManager.getSessionStatus(sharedSession.id, sharedSession.userId).status,
        label: sharedSession.sessionName + (sharedSession.phoneNumber ? ` (${sharedSession.phoneNumber})` : '') + ' — Shared',
        isShared: true,
      });
    }

    res.render("pages/bulk/index", {
      title: "Bulk Messaging - ParroByte CRM",
      sessions,
      contacts,
      groups,
      tags,
      templates,
      questionnaires,
      questionnaireQuestions,
      jobs: result.data,
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      activeJob,
      isAdmin,
      sharedSession,
      availableSessions,
      fromDate: req.query.from || '',
      toDate: req.query.to || '',
    });
  } catch (error) {
    console.error("Bulk page error:", error);
    req.flash("error", "Failed to load bulk messaging");
    res.redirect("/dashboard");
  }
});

// Send bulk messages - stores job in DB and processes in background
router.post("/send", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { sessionId, contactIds, messageType, templateId, delay } = req.body;

    // Resolve session (shared admin session for non-admins)
    const resolved = await resolveSessionForUser({ userId, isAdmin, providedSessionId: sessionId });
    if (resolved.error) {
      req.flash("error", resolved.error);
      return res.redirect("/bulk");
    }
    const resolvedSessionId = resolved.sessionId;
    // Handle multiple message fields (text/buttons/list panels all have name="message")
    let content = "";
    if (Array.isArray(req.body.message)) {
      content = req.body.message.find(m => m && m.trim()) || "";
    } else {
      content = req.body.message || req.body.content || "";
    }
    const campaignCategory = req.body.campaignCategory || "";
    const questionnaireFilterId = req.body.questionnaireFilterId || "";
    const questionFilterId = req.body.questionFilterId || "";
    const answerFilterValue = req.body.answerFilterValue || "";

    // Verify resolved session is valid and actually connected in memory
    const sessionCheck = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, resolvedSessionId));
    if (!sessionCheck.length) {
      req.flash("error", "Selected session not found");
      return res.redirect("/bulk");
    }

    // Check actual in-memory client status (not just DB status)
    const actualStatus = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
    if (actualStatus.status !== "connected") {
      console.log(`[Bulk] Session ${resolvedSessionId} DB status=${sessionCheck[0].status} but memory status=${actualStatus.status}. Attempting reconnect...`);
      try {
        await req.waManager.reconnectSession(resolvedSessionId);
        // Give it a moment to connect
        await new Promise(r => setTimeout(r, 3000));
        const reconnected = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
        if (reconnected.status !== "connected") {
          throw new Error("Session reconnect failed");
        }
        console.log(`[Bulk] Session ${resolvedSessionId} reconnected successfully`);
      } catch (reconnectErr) {
        console.error(`[Bulk] Session ${resolvedSessionId} reconnect failed:`, reconnectErr.message);
        req.flash("error", "WhatsApp session is disconnected. Please go to WhatsApp Sessions and reconnect it.");
        return res.redirect("/bulk");
      }
    }

    if (!content.trim() && !templateId) {
      req.flash("error", "Please enter a message or select a template");
      return res.redirect("/bulk");
    }

    // Robust contactIds parsing
    let targetIds = [];
    const rawContactIds = req.body.contactIds;

    if (rawContactIds) {
      if (typeof rawContactIds === "string") {
        try {
          const parsed = JSON.parse(rawContactIds);
          if (Array.isArray(parsed)) {
            targetIds = parsed.map(String);
          } else {
            targetIds = [String(parsed)];
          }
        } catch (e) {
          if (rawContactIds.includes(",")) {
            targetIds = rawContactIds.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
          } else if (rawContactIds !== "all" && rawContactIds !== "custom") {
            targetIds = [rawContactIds];
          }
        }
      } else if (Array.isArray(rawContactIds)) {
        targetIds = rawContactIds.map(String);
      }
    }

    // Fallback: check for contactIdsJson hidden field
    if (targetIds.length === 0 && req.body.contactIdsJson) {
      try {
        const parsed = JSON.parse(req.body.contactIdsJson);
        if (Array.isArray(parsed)) targetIds = parsed.map(String);
      } catch (e) {}
    }

    // Handle checkbox array (contactIdsArr from form)
    if (targetIds.length === 0 && req.body.contactIdsArr) {
      const arr = Array.isArray(req.body.contactIdsArr) ? req.body.contactIdsArr : [req.body.contactIdsArr];
      targetIds = arr.map(String);
    }

    // Handle "all" selection
    if (rawContactIds === "all" || targetIds.length === 0) {
      const allContacts = await db.select().from(schema.contacts)
        .where(eq(schema.contacts.userId, userId));
      targetIds = allContacts.map(function(c) { return String(c.id); });
    }

    if (!targetIds.length) {
      req.flash("error", "No contacts selected");
      return res.redirect("/bulk");
    }

    // Get selected contacts
    let contacts = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.userId, userId));

    // Apply questionnaire-based filtering if specified
    if (questionnaireFilterId && questionFilterId && answerFilterValue) {
      const qAnswers = await db.select().from(schema.sessionQuestionnaireAnswers)
        .where(and(
          eq(schema.sessionQuestionnaireAnswers.questionnaireId, parseInt(questionnaireFilterId)),
          eq(schema.sessionQuestionnaireAnswers.questionId, parseInt(questionFilterId))
        ));
      const matchingSessionIds = qAnswers
        .filter(a => a.answer.toLowerCase().trim() === answerFilterValue.toLowerCase().trim())
        .map(a => a.sessionId);
      // Filter contacts to only those whose linked session matches
      // We match by phone number since sessions don't directly link to contacts
      const sessions = await db.select().from(schema.whatsappSessions)
        .where(inArray(schema.whatsappSessions.id, matchingSessionIds));
      const sessionPhones = sessions.map(s => String(s.phoneNumber || '').replace(/\D/g, ''));
      contacts = contacts.filter(c => {
        const contactPhone = String(c.phone || '').replace(/\D/g, '');
        return sessionPhones.some(sp => contactPhone.includes(sp) || sp.includes(contactPhone));
      });
    }

    const targetContacts = contacts.filter(function(c) {
      return targetIds.includes(String(c.id));
    });

    if (!targetContacts.length) {
      req.flash("error", "No valid contacts found");
      return res.redirect("/bulk");
    }

    // Get template content if selected, otherwise use form values
    let finalContent = content;
    let mediaUrl = req.body.mediaUrl || null;
    let msgType = messageType || "text";
    let interactiveData = null;
    let templateVars = null;

    // Handle uploaded media file (takes priority over template media)
    if (req.files && req.files.mediaFile) {
      const file = req.files.mediaFile;
      const maxSizeMB = 10;
      if (file.size > maxSizeMB * 1024 * 1024) {
        req.flash("error", `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed is ${maxSizeMB}MB.`);
        return res.redirect("/bulk");
      }
      const uploadPath = path.join(__dirname, "../../public/uploads/media", `${Date.now()}_${sanitizeFilename(file.name)}`);
      await file.mv(uploadPath);
      mediaUrl = uploadPath;
      const mime = file.mimetype || '';
      if (mime.startsWith('image/')) msgType = 'image';
      else if (mime.startsWith('video/')) msgType = 'video';
      else if (mime.startsWith('audio/')) msgType = 'audio';
      else msgType = 'document';
    }

    // Resolve template first (it may override type, content, and poll options)
    if (templateId) {
      const templates = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, templateId));
      if (templates.length && (templates[0].userId === userId || isAdmin)) {
        finalContent = templates[0].content;
        mediaUrl = templates[0].mediaUrl;
        msgType = templates[0].type || "text";
        try { templateVars = JSON.parse(templates[0].variables || '{}'); } catch (e) {}
      }
    }

    // Parse interactive data for poll bulk messages
    if (msgType === "poll") {
      // If poll template selected, use its stored options; else use form input
      let pollOptions = [];
      if (templateVars && templateVars.pollOptions && templateVars.pollOptions.length >= 2) {
        pollOptions = templateVars.pollOptions;
      } else {
        pollOptions = (req.body.pollOptions || "").split("\n").map(o => o.trim()).filter(Boolean);
      }
      if (pollOptions.length < 2) {
        req.flash("error", "Poll requires at least 2 options");
        return res.redirect("/bulk");
      }
      const allowMultiple = templateVars && templateVars.allowMultipleAnswers
        ? templateVars.allowMultipleAnswers
        : req.body.pollAllowMultiple === "true";
      interactiveData = {
        options: pollOptions,
        allowMultipleAnswers: allowMultiple,
      };
    }

    // Check credits for at least one message
    const creditService = msgType === "poll" ? "poll_message" : "send_message";
    const creditCheck = await checkCredits(userId, creditService, 1);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/bulk");
    }

    const gapSeconds = parseInt(delay) || 30;
    const total = targetContacts.length;

    // Create a bulk job record in the database
    const jobResult = await db.insert(schema.bulkMessageJobs).values({
      userId,
      sessionId: parseInt(resolvedSessionId),
      templateId: templateId ? parseInt(templateId) : null,
      content: finalContent,
      type: msgType,
      mediaUrl,
      totalContacts: total,
      gapSeconds,
      status: "processing",
      contactIds: JSON.stringify(targetIds),
      interactiveData: interactiveData ? JSON.stringify(interactiveData) : null,
      startedAt: new Date(),
    }).returning();

    const job = jobResult[0];
    const jobId = job.id;

    // Save poll auto-responses if configured
    if (msgType === "poll" && interactiveData) {
      try {
        const pollOptions = interactiveData.options || [];
        const autoResponseRows = [];

        // If poll template has optionResponses in variables, use those
        const templateOptionResponses = templateVars && templateVars.optionResponses ? templateVars.optionResponses : {};

        for (let i = 0; i < pollOptions.length; i++) {
          const optionName = pollOptions[i];
          let respTemplateId = null;

          // First try template's stored optionResponses
          if (templateOptionResponses[optionName] && templateOptionResponses[optionName].templateId) {
            respTemplateId = templateOptionResponses[optionName].templateId;
          }
          // Then try manual form override
          else if (req.body['pollAutoOption_' + i] === optionName && req.body['pollAutoResponse_' + i]) {
            respTemplateId = parseInt(req.body['pollAutoResponse_' + i]);
          }

          if (respTemplateId) {
            const templateRows = await db.select().from(schema.templates)
              .where(eq(schema.templates.id, respTemplateId));
            const responseContent = templateRows.length ? templateRows[0].content : '';
            autoResponseRows.push({
              userId,
              sessionId: parseInt(resolvedSessionId),
              pollName: finalContent,
              optionName,
              responseContent,
              templateId: respTemplateId,
              isActive: true,
            });
          }
        }
        if (autoResponseRows.length) {
          await db.insert(schema.pollAutoResponses).values(autoResponseRows);
          console.log(`[BulkPoll] Saved ${autoResponseRows.length} auto-response mappings for job ${jobId}`);
        }
      } catch (parErr) {
        console.error("[BulkPoll] Failed to save auto-responses:", parErr.message);
      }
    }

    // Store minimal job info in session for the UI
    req.session.bulkJob = { id: jobId, total, sent: 0, failed: 0 };

    // ── PROCESS BULK MESSAGES INLINE (non-blocking) ──
    req.flash("success", `Bulk job started for ${total} contacts. Job #${jobId} is processing in the background.`);
    res.redirect("/bulk");

    // Process after response is sent so browser doesn't hang
    setImmediate(async () => {
      const contactData = targetContacts.map(c => ({
        id: c.id, phone: c.phone, name: c.name, email: c.email,
        group: c.group, tags: c.tags, notes: c.notes, countryCode: c.countryCode,
      }));

      console.log(`[Bulk] Job ${jobId} starting inline processing (${contactData.length} contacts)`);
      let sentCount = 0;
      let failedCount = 0;

      for (let i = 0; i < contactData.length; i++) {
        const contact = contactData[i];
        try {
          const creditCheck = await checkCredits(userId, msgType === "poll" ? "poll_message" : "send_message", 1);
          if (!creditCheck.allowed) {
            console.warn(`[Bulk] Job ${jobId} stopped: insufficient credits`);
            break;
          }

          let personalizedContent = finalContent;
          if (contact.name) personalizedContent = personalizedContent.replace(/\{\{name\}\}/gi, contact.name);
          if (contact.email) personalizedContent = personalizedContent.replace(/\{\{email\}\}/gi, contact.email);
          if (contact.phone) personalizedContent = personalizedContent.replace(/\{\{phone\}\}/gi, contact.phone);

          await req.waManager.sendMessage(resolvedSessionId, contact.phone, personalizedContent, msgType, mediaUrl, interactiveData);
          await chargeCredits(req, msgType === "poll" ? "poll_message" : "send_message", 1, `Bulk job ${jobId}`);
          sentCount++;

          // Progress report
          if (i % 5 === 0) {
            await db.update(schema.bulkMessageJobs)
              .set({ sentCount, failedCount })
              .where(eq(schema.bulkMessageJobs.id, jobId));
          }

          // Rate limit gap
          if (i < contactData.length - 1) {
            await new Promise(r => setTimeout(r, gapSeconds * 1000));
          }
        } catch (err) {
          console.error(`[Bulk] Job ${jobId} contact ${contact.phone} failed:`, err.message);
          failedCount++;
        }
      }

      await db.update(schema.bulkMessageJobs)
        .set({ status: "completed", sentCount, failedCount, completedAt: new Date() })
        .where(eq(schema.bulkMessageJobs.id, jobId));

      console.log(`[Bulk] Job ${jobId} completed: ${sentCount} sent, ${failedCount} failed`);
    });
  } catch (error) {
    console.error("Bulk send error:", error);
    req.flash("error", "Failed to send bulk messages: " + error.message);
    res.redirect("/bulk");
  }
});

// Get bulk job status - reads from both session and DB
router.get("/status", async (req, res) => {
  try {
    const sessionJob = req.session.bulkJob;
    if (!sessionJob) return res.json({ active: false });

    // Also try to get latest from DB for more accurate counts
    let dbJob = null;
    try {
      const jobs = await db.select().from(schema.bulkMessageJobs)
        .where(eq(schema.bulkMessageJobs.id, sessionJob.id));
      if (jobs.length) dbJob = jobs[0];
    } catch (e) {}

    const sent = dbJob ? dbJob.sentCount : sessionJob.sent;
    const failed = dbJob ? dbJob.failedCount : sessionJob.failed;
    const total = dbJob ? dbJob.totalContacts : sessionJob.total;
    const status = dbJob ? dbJob.status : "processing";

    res.json({
      active: true,
      total,
      sent,
      failed,
      status,
      progress: Math.round(((sent + failed) / (total || 1)) * 100),
    });
  } catch (error) {
    res.json({ active: false, error: error.message });
  }
});

// Delete a bulk message job
router.post("/delete-job/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const jobId = parseInt(req.params.id);

    const jobs = await db.select().from(schema.bulkMessageJobs)
      .where(eq(schema.bulkMessageJobs.id, jobId));
    if (!jobs.length || (jobs[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized or job not found");
      return res.redirect("/bulk");
    }

    await db.delete(schema.bulkMessageJobs).where(eq(schema.bulkMessageJobs.id, jobId));
    req.flash("success", "Job deleted");
    res.redirect("/bulk");
  } catch (error) {
    console.error("Delete bulk job error:", error);
    req.flash("error", "Failed to delete job");
    res.redirect("/bulk");
  }
});

export default router;
