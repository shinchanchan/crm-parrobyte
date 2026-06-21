import express from "express";
import { db } from "../lib/db.js";
import { eq, and, gte } from "drizzle-orm";
import { paginate } from "../lib/paginate.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import * as schema from "../../db/schema.js";
import { resolveSessionForUser, getSharedSession } from "../lib/sessions.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    
    let whereClause = isAdmin ? null : eq(schema.scheduledMessages.userId, userId);
    
    const result = await paginate({
      db,
      schema: schema.scheduledMessages,
      req,
      where: whereClause,
      searchableColumns: ["content", "type", "status", "repeatPattern"],
      defaultSort: { column: schema.scheduledMessages.scheduleTime, dir: "asc" },
    });
    
    const userSessions = await db.select().from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId));
    const sharedSession = await getSharedSession();
    
    const availableSessions = [];
    for (const s of userSessions) {
      const status = req.waManager ? req.waManager.getSessionStatus(s.id, s.userId) : { status: s.status };
      const isConnected = status.status === 'connected' || s.status === 'connected';
      if (isConnected) {
        availableSessions.push({ ...s, realtimeStatus: status.status, label: `${s.sessionName} (${s.phoneNumber || 'You'})` });
      }
    }
    if (sharedSession) {
      const status = req.waManager ? req.waManager.getSessionStatus(sharedSession.id, sharedSession.userId) : { status: sharedSession.status };
      const isConnected = status.status === 'connected' || sharedSession.status === 'connected';
      if (isConnected) {
        availableSessions.push({ ...sharedSession, realtimeStatus: status.status, label: `${sharedSession.sessionName} (Admin - ${sharedSession.phoneNumber})` });
      }
    }
    
    let contacts = isAdmin
      ? await db.select().from(schema.contacts)
      : await db.select().from(schema.contacts).where(eq(schema.contacts.userId, userId));
    
    let templates = isAdmin
      ? await db.select().from(schema.templates)
      : await db.select().from(schema.templates).where(eq(schema.templates.userId, userId));
    
    res.render("pages/schedule/index", {
      title: "Scheduled Messages - ParroByte CRM",
      schedules: result.data,
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      sessions: availableSessions,
      availableSessions,
      contacts,
      templates,
      isAdmin,
      sharedSession,
    });
  } catch (error) {
    console.error("Schedule error:", error);
    req.flash("error", "Failed to load scheduled messages");
    res.redirect("/dashboard");
  }
});

router.post("/create", async (req, res) => {
  try {
    const { sessionId, templateId, contactIds, content, type, scheduleTime, repeatPattern, timezoneOffset } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Resolve session (shared admin session for non-admins)
    const resolved = await resolveSessionForUser({ userId, isAdmin, providedSessionId: sessionId });
    if (resolved.error) {
      req.flash("error", resolved.error);
      return res.redirect("/schedule");
    }
    const resolvedSessionId = resolved.sessionId;

    // Normalize contactIds to array of integers
    let ids = contactIds || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.filter(Boolean).map(id => parseInt(id, 10)).filter(id => !isNaN(id));

    let finalContent = content;
    let mediaUrl = null;
    let msgType = type || "text";
    let interactiveData = null;

    if (templateId) {
      const template = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, templateId));

      if (template.length && (template[0].userId === userId || isAdmin)) {
        finalContent = template[0].content;
        mediaUrl = template[0].mediaUrl;
        msgType = template[0].type;

        // Parse poll options from template variables
        if (msgType === 'poll' && template[0].variables) {
          try {
            const vars = JSON.parse(template[0].variables);
            if (vars.pollOptions && vars.pollOptions.length >= 2) {
              interactiveData = JSON.stringify({
                options: vars.pollOptions,
                allowMultipleAnswers: vars.allowMultipleAnswers === true,
              });
            }
          } catch (e) {}
        }
      }
    }

    // Check credits (charge per contact scheduled)
    const creditService = msgType === "poll" ? "poll_message" : "schedule_message";
    const creditCheck = await checkCredits(userId, creditService, ids.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/schedule");
    }

    // Convert scheduleTime from browser's local timezone to UTC
    // timezoneOffset is in minutes (e.g., -330 for IST, 300 for EST)
    let scheduleDate;
    if (timezoneOffset && !isNaN(parseInt(timezoneOffset))) {
      const [datePart, timePart] = scheduleTime.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour, minute] = timePart.split(':').map(Number);
      // Build UTC timestamp from wall-clock values, then adjust by browser offset
      const utcTimestamp = Date.UTC(year, month - 1, day, hour, minute);
      const browserOffsetMs = parseInt(timezoneOffset) * 60 * 1000;
      scheduleDate = new Date(utcTimestamp + browserOffsetMs);
    } else {
      scheduleDate = new Date(scheduleTime);
    }

    await db.insert(schema.scheduledMessages).values({
      userId,
      sessionId: resolvedSessionId,
      templateId: templateId || null,
      contactIds: JSON.stringify(ids),
      type: msgType,
      content: finalContent,
      mediaUrl,
      interactiveData,
      scheduleTime: scheduleDate,
      repeatPattern: repeatPattern || null,
    });

    req.flash("success", `Message scheduled for ${ids.length} contact(s). Credits will be deducted per successful send at delivery time.`);
    res.redirect("/schedule");
  } catch (error) {
    console.error("Create schedule error:", error);
    req.flash("error", "Failed to schedule message");
    res.redirect("/schedule");
  }
});

router.post("/cancel/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const schedule = await db.select().from(schema.scheduledMessages)
      .where(eq(schema.scheduledMessages.id, id))
      ;
    
    if (!schedule.length || (schedule[0].userId !== req.session.user.id && req.session.user.role !== "admin")) {
      req.flash("error", "Unauthorized");
      return res.redirect("/schedule");
    }
    
    await db.update(schema.scheduledMessages)
      .set({ status: "cancelled" })
      .where(eq(schema.scheduledMessages.id, id));
    
    req.flash("success", "Scheduled message cancelled");
    res.redirect("/schedule");
  } catch (error) {
    console.error("Cancel schedule error:", error);
    req.flash("error", "Failed to cancel schedule");
    res.redirect("/schedule");
  }
});

export default router;
