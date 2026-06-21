import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";

import { checkCredits, chargeCredits } from "../lib/credits.js";
import { paginate } from "../lib/paginate.js";
import { getSharedSession } from "../lib/sessions.js";
import { checkPlanLimit, getUserMaxSessions } from "../lib/planEnforce.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    let result;
    if (isAdmin) {
      result = await paginate({
        db,
        schema: schema.whatsappSessions,
        req,
        where: null,
        searchableColumns: ["sessionName", "phoneNumber"],
        defaultSort: { column: schema.whatsappSessions.createdAt, dir: "desc" },
      });
    } else {
      // Non-admin: show their OWN sessions + shared sessions
      const ownSessions = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.userId, userId))
        .orderBy(desc(schema.whatsappSessions.createdAt));

      const sharedSessions = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.isShared, true));

      // Merge: own sessions first, then shared sessions they don't already own
      const sessionMap = new Map();
      ownSessions.forEach(s => sessionMap.set(s.id, { ...s, isOwn: true }));
      sharedSessions.forEach(s => {
        if (!sessionMap.has(s.id)) {
          sessionMap.set(s.id, { ...s, isOwn: false });
        }
      });

      const allSessions = Array.from(sessionMap.values());
      result = {
        data: allSessions,
        pagination: { total: allSessions.length, page: 1, perPage: 10, totalPages: 1, hasPrev: false, hasNext: false, pageRange: [1], startPage: 1, endPage: 1 },
        columnFilters: {},
        sortCol: 'createdAt',
        sortDir: 'desc',
      };
    }

    // Enhance with real-time status
    for (const session of result.data) {
      const status = req.waManager.getSessionStatus(session.id, session.userId);
      session.realtimeStatus = status.status;
      session.qrCode = status.qrCode;
    }

    const sharedSession = await getSharedSession();

    // Get user's session limit info
    const userMaxSessions = await getUserMaxSessions(userId);
    const userSessionCount = isAdmin
      ? result.data.length
      : (await db.select({ count: schema.whatsappSessions.id }).from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId))).length;

    res.render("pages/sessions/index", {
      title: "WhatsApp Sessions - ParroByte CRM",
      sessions: result.data,
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      isAdmin,
      sharedSession,
      userMaxSessions,
      userSessionCount,
      canCreateSession: isAdmin || userSessionCount < userMaxSessions,
    });
  } catch (error) {
    console.error("Sessions error:", error);
    req.flash("error", "Failed to load sessions");
    res.redirect("/dashboard");
  }
});

router.post("/create", async (req, res) => {
  try {
    const { sessionName, questionnaireId } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Check plan / per-user session limit
    const limitCheck = await checkPlanLimit(userId, "sessions");
    if (!limitCheck.allowed) {
      req.flash("error", limitCheck.message);
      return res.redirect("/sessions");
    }

    // Check credits
    const creditCheck = await checkCredits(userId, "create_session");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/sessions");
    }

    if (!sessionName || sessionName.trim().length < 2) {
      req.flash("error", "Session name must be at least 2 characters");
      return res.redirect("/sessions");
    }

    const session = await req.waManager.createSession(userId, sessionName.trim());
    await chargeCredits(req, "create_session", 1, `Created session: ${sessionName.trim()}`);

    // Process questionnaire answers if provided
    if (questionnaireId) {
      const qId = parseInt(questionnaireId);
      const qnaire = await db.select().from(schema.sessionQuestionnaires)
        .where(eq(schema.sessionQuestionnaires.id, qId));

      if (qnaire.length && qnaire[0].userId === userId) {
        const questions = await db.select().from(schema.sessionQuestionnaireQuestions)
          .where(eq(schema.sessionQuestionnaireQuestions.questionnaireId, qId))
          .orderBy(schema.sessionQuestionnaireQuestions.sortOrder);

        const leadData = { userId, source: "questionnaire", status: "new", data: {} };
        let hasLeadData = false;

        for (const q of questions) {
          const answerKey = `q_${q.id}`;
          const answer = req.body[answerKey];

          if (answer !== undefined && answer !== null && String(answer).trim()) {
            // Save answer
            await db.insert(schema.sessionQuestionnaireAnswers).values({
              sessionId: session.id,
              questionnaireId: qId,
              questionId: q.id,
              answer: String(answer).trim(),
            });

            // Map to lead field if configured
            if (q.mapToLeadField) {
              hasLeadData = true;
              const val = String(answer).trim();
              if (q.mapToLeadField === "name") leadData.name = val;
              else if (q.mapToLeadField === "phone") leadData.phone = val;
              else if (q.mapToLeadField === "email") leadData.email = val;
              else if (q.mapToLeadField === "status") leadData.status = val;
              else if (q.mapToLeadField === "tags") leadData.tags = val;
              else if (q.mapToLeadField === "notes") leadData.notes = (leadData.notes || "") + `${q.questionText}: ${val}\n`;
              else if (q.mapToLeadField === "data") {
                if (!leadData.data) leadData.data = {};
                leadData.data[q.questionText] = val;
              }
            }
          }
        }

        // Business logic: auto-qualify leads based on answers
        const allAnswers = await db.select().from(schema.sessionQuestionnaireAnswers)
          .where(eq(schema.sessionQuestionnaireAnswers.sessionId, session.id));

        // Rule: If budget question answered "high" or "enterprise", mark as qualified
        const budgetAnswer = allAnswers.find(a => {
          const q = questions.find(qn => qn.id === a.questionId);
          return q && q.questionText.toLowerCase().includes("budget");
        });
        if (budgetAnswer) {
          const ba = budgetAnswer.answer.toLowerCase();
          if (ba.includes("high") || ba.includes("enterprise") || ba.includes("large") || ba.includes("premium")) {
            leadData.status = "qualified";
          }
        }

        // Rule: If "ready to buy" is yes, mark as qualified
        const readyAnswer = allAnswers.find(a => {
          const q = questions.find(qn => qn.id === a.questionId);
          return q && (q.questionText.toLowerCase().includes("ready") || q.questionText.toLowerCase().includes("buy"));
        });
        if (readyAnswer && readyAnswer.answer.toLowerCase() === "yes") {
          leadData.status = "qualified";
        }

        // Create lead if we have at least name or phone
        if (hasLeadData && (leadData.name || leadData.phone)) {
          if (leadData.data && typeof leadData.data === "object") {
            leadData.data = JSON.stringify(leadData.data);
          }
          if (!leadData.name) leadData.name = sessionName.trim();
          await db.insert(schema.leads).values(leadData);
          req.flash("info", `Lead auto-created from questionnaire answers.`);
        }
      }
    }

    req.flash("success", `Session created. Scan the QR code with WhatsApp on your phone. (${creditCheck.cost} credits used)`);
    res.redirect("/sessions");
  } catch (error) {
    console.error("Create session error:", error);
    req.flash("error", "Failed to create session: " + error.message);
    res.redirect("/sessions");
  }
});

router.post("/disconnect/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = parseInt(id);

    const rows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!rows.length) {
      req.flash("error", "Session not found");
      return res.redirect("/sessions");
    }

    if (rows[0].userId !== req.session.user.id && req.session.user.role !== "admin") {
      req.flash("error", "Unauthorized");
      return res.redirect("/sessions");
    }

    await req.waManager.disconnectSession(sessionId, true);
    req.flash("success", "Session disconnected. Click Reconnect to restore without scanning QR again.");
    res.redirect("/sessions");
  } catch (error) {
    console.error("Disconnect error:", error);
    req.flash("error", "Failed to disconnect session: " + error.message);
    res.redirect("/sessions");
  }
});

router.post("/reconnect/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = parseInt(id);

    const rows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!rows.length) {
      req.flash("error", "Session not found");
      return res.redirect("/sessions");
    }

    if (rows[0].userId !== req.session.user.id && req.session.user.role !== "admin") {
      req.flash("error", "Unauthorized");
      return res.redirect("/sessions");
    }

    await req.waManager.reconnectSession(sessionId);
    req.flash("success", "Session reconnection initiated");
    res.redirect("/sessions");
  } catch (error) {
    console.error("Reconnect error:", error);
    req.flash("error", "Failed to reconnect: " + error.message);
    res.redirect("/sessions");
  }
});

router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = parseInt(id);

    const rows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!rows.length) {
      req.flash("error", "Session not found");
      return res.redirect("/sessions");
    }

    if (rows[0].userId !== req.session.user.id && req.session.user.role !== "admin") {
      req.flash("error", "Unauthorized");
      return res.redirect("/sessions");
    }

    // Destroy client and clean auth permanently
    await req.waManager.disconnectSession(sessionId, false);

    // Delete from database
    await db.delete(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    req.flash("success", "Session deleted permanently");
    res.redirect("/sessions");
  } catch (error) {
    console.error("Delete session error:", error);
    req.flash("error", "Failed to delete session: " + error.message);
    res.redirect("/sessions");
  }
});

router.get("/status/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = parseInt(id);
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const rows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!rows.length) {
      return res.json({ status: "not_found" });
    }

    // Prevent users from accessing other users' session status (QR codes)
    // Allow access if the session is shared or belongs to the user
    if (rows[0].userId !== userId && !isAdmin && !rows[0].isShared) {
      return res.status(403).json({ status: "unauthorized", message: "Session does not belong to your account" });
    }

    const status = req.waManager.getSessionStatus(sessionId, rows[0].userId);
    res.json(status);
  } catch (error) {
    res.json({ status: "error", message: error.message });
  }
});

// Toggle isShared flag on a session (admin only)
router.post("/toggle-shared/:id", async (req, res) => {
  try {
    const isAdmin = req.session.user.role === "admin";
    if (!isAdmin) {
      req.flash("error", "Only admins can share sessions");
      return res.redirect("/sessions");
    }

    const sessionId = parseInt(req.params.id);
    const rows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!rows.length) {
      req.flash("error", "Session not found");
      return res.redirect("/sessions");
    }

    const newValue = !rows[0].isShared;

    // If enabling sharing, first un-share any other shared session
    if (newValue) {
      await db.update(schema.whatsappSessions)
        .set({ isShared: false })
        .where(eq(schema.whatsappSessions.isShared, true));
    }

    await db.update(schema.whatsappSessions)
      .set({ isShared: newValue })
      .where(eq(schema.whatsappSessions.id, sessionId));

    req.flash("success", newValue
      ? `Session "${rows[0].sessionName}" is now shared. All users will use this session for sending messages.`
      : `Session "${rows[0].sessionName}" is no longer shared.`);
    res.redirect("/sessions");
  } catch (error) {
    console.error("Toggle shared error:", error);
    req.flash("error", "Failed to update session sharing");
    res.redirect("/sessions");
  }
});

export default router;
