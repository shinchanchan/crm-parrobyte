import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import path from "path";
import { fileURLToPath } from "url";
import { paginate } from "../lib/paginate.js";
import { sanitizeFilename } from "../lib/sanitize.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import fs from "fs";
import { resolveSessionForUser, getSharedSession } from "../lib/sessions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    
    const whereClause = isAdmin ? null : eq(schema.messages.userId, userId);
    const result = await paginate({
      db,
      schema: schema.messages,
      req,
      where: whereClause,
      searchableColumns: ["content", "phone"],
      defaultSort: { column: schema.messages.createdAt, dir: "desc" },
    });
    
    let sessions = isAdmin
      ? await db.select().from(schema.whatsappSessions)
      : await db.select().from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId));
    
    let contacts = isAdmin
      ? await db.select().from(schema.contacts)
      : await db.select().from(schema.contacts).where(eq(schema.contacts.userId, userId));
    
    let templates = isAdmin
      ? await db.select().from(schema.templates)
      : await db.select().from(schema.templates).where(eq(schema.templates.userId, userId));
    
    const sharedSession = await getSharedSession();
    
    res.render("pages/messages/index", {
      title: "Messages - ParroByte CRM",
      messages: result.data,
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      sessions,
      contacts,
      templates,
      isAdmin,
      sharedSession,
    });
  } catch (error) {
    console.error("Messages error:", error);
    req.flash("error", "Failed to load messages");
    res.redirect("/dashboard");
  }
});

router.post("/send", async (req, res) => {
  try {
    const { sessionId, phone, type, useTemplate, templateId } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Resolve session (shared admin session for non-admins)
    const resolved = await resolveSessionForUser({ userId, isAdmin, providedSessionId: sessionId });
    if (resolved.error) {
      req.flash("error", resolved.error);
      return res.redirect("/messages");
    }
    const resolvedSessionId = resolved.sessionId;

    // Handle multiple content fields (text/buttons/list panels all have name="content")
    let content = "";
    if (Array.isArray(req.body.content)) {
      content = req.body.content.find(c => c && c.trim()) || "";
    } else {
      content = req.body.content || req.body.message || "";
    }

    let mediaUrl = req.body.mediaUrl || null;
    let msgType = type || "text";
    let interactiveData = null;

    if (templateId) {
      const template = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, templateId));

      if (template.length && (template[0].userId === userId || isAdmin)) {
        content = template[0].content;
        mediaUrl = template[0].mediaUrl;
        msgType = template[0].type;
      }
    }

    // Handle poll messages
    if (msgType === "poll") {
      const pollOptions = (req.body.pollOptions || "").split("\n").map(o => o.trim()).filter(Boolean);
      if (pollOptions.length < 2) {
        req.flash("error", "Poll requires at least 2 options");
        return res.redirect("/messages");
      }
      interactiveData = {
        options: pollOptions,
        allowMultipleAnswers: req.body.pollAllowMultiple === "true",
      };
    }

    if (req.files && req.files.mediaFile) {
      const file = req.files.mediaFile;
      const maxSizeMB = 150;
      if (file.size > maxSizeMB * 1024 * 1024) {
        req.flash("error", `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed is ${maxSizeMB}MB.`);
        return res.redirect("/messages");
      }
      const uploadPath = path.join(__dirname, "../../public/uploads/media", `${Date.now()}_${sanitizeFilename(file.name)}`);
      await file.mv(uploadPath);
      mediaUrl = uploadPath;
      // Detect media type from MIME type; uploaded file always wins over template type
      const mime = file.mimetype || '';
      if (mime.startsWith('image/')) msgType = 'image';
      else if (mime.startsWith('video/')) msgType = 'video';
      else if (mime.startsWith('audio/')) msgType = 'audio';
      else msgType = 'document';
    }

    // Handle multiple phones
    const phones = phone.split(",").map(p => p.trim()).filter(p => p);

    // Check credits
    const creditService = msgType === "poll" ? "poll_message" : "send_message";
    const creditCheck = await checkCredits(userId, creditService, phones.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/messages");
    }

    // Verify session is actually connected in memory before sending
    const sessionCheck = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, resolvedSessionId));
    if (!sessionCheck.length) {
      req.flash("error", "Selected session not found");
      return res.redirect("/messages");
    }
    const memStatus = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
    if (memStatus.status !== "connected") {
      console.log(`[Messages] Session ${resolvedSessionId} memory status=${memStatus.status}. Attempting reconnect...`);
      try {
        await req.waManager.reconnectSession(resolvedSessionId);
        await new Promise(r => setTimeout(r, 3000));
        const reconnected = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
        if (reconnected.status !== "connected") {
          throw new Error("Session reconnect failed");
        }
      } catch (reconnectErr) {
        console.error(`[Messages] Session ${resolvedSessionId} reconnect failed:`, reconnectErr.message);
        req.flash("error", "WhatsApp session is disconnected. Please go to WhatsApp Sessions and reconnect it.");
        return res.redirect("/messages");
      }
    }

    const results = [];
    for (let i = 0; i < phones.length; i++) {
      const p = phones[i];
      try {
        await req.waManager.sendMessage(resolvedSessionId, p, content, msgType, mediaUrl, interactiveData);
        results.push({ phone: p, status: "success" });
      } catch (err) {
        results.push({ phone: p, status: "failed", error: err.message });
      }

      // Random 30-50 second gap between messages to avoid WhatsApp rate limits
      if (i < phones.length - 1) {
        const randomGap = Math.floor(Math.random() * 20000) + 30000; // 30000-50000ms
        console.log(`[WhatsApp] Waiting ${(randomGap / 1000).toFixed(1)}s before next message...`);
        await new Promise(r => setTimeout(r, randomGap));
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    let deductedCredits = 0;
    fs.appendFileSync("/home/vallarasu/Downloads/automation-whatsapp/kimi3/app/credit-route-debug.log", `[${new Date().toISOString()}] messages/send: successCount=${successCount}, creditService=${creditService}, userId=${userId}\n`);
    if (successCount > 0) {
      try {
        const creditResult = await chargeCredits(req, creditService, successCount, `Sent ${successCount} message(s)`);
        fs.appendFileSync("/home/vallarasu/Downloads/automation-whatsapp/kimi3/app/credit-route-debug.log", `[${new Date().toISOString()}] messages/send: creditResult=${JSON.stringify(creditResult)}\n`);
        deductedCredits = creditResult.deducted || 0;
      } catch (creditErr) {
        fs.appendFileSync("/home/vallarasu/Downloads/automation-whatsapp/kimi3/app/credit-route-debug.log", `[${new Date().toISOString()}] messages/send: creditErr=${creditErr.message}\n`);
        req.flash("error", `Message sent but credit deduction failed: ${creditErr.message}`);
      }
    }
    req.flash("success", `Messages sent: ${successCount} successful, ${results.filter(r => r.status === "failed").length} failed (₹${deductedCredits} credits deducted)`);
    res.redirect("/messages");
  } catch (error) {
    console.error("Send message error:", error);
    req.flash("error", "Failed to send message: " + error.message);
    res.redirect("/messages");
  }
});

router.post("/send-bulk", async (req, res) => {
  try {
    const { sessionId, contactIds, type, templateId } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Resolve session (shared admin session for non-admins)
    const resolved = await resolveSessionForUser({ userId, isAdmin, providedSessionId: sessionId });
    if (resolved.error) {
      req.flash("error", resolved.error);
      return res.redirect("/messages");
    }
    const resolvedSessionId = resolved.sessionId;

    // Handle multiple content fields (text/buttons/list panels all have name="content")
    let content = "";
    if (Array.isArray(req.body.content)) {
      content = req.body.content.find(c => c && c.trim()) || "";
    } else {
      content = req.body.content || req.body.message || "";
    }

    let mediaUrl = null;
    let msgType = type || "text";

    if (templateId) {
      const template = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, templateId));

      if (template.length && (template[0].userId === userId || isAdmin)) {
        content = template[0].content;
        mediaUrl = template[0].mediaUrl;
        msgType = template[0].type;
      }
    }

    const ids = JSON.parse(contactIds || "[]");
    const contacts = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.userId, userId));

    const targetContacts = contacts.filter(c => ids.includes(String(c.id)));

    // Check credits
    const creditService = msgType === "poll" ? "poll_message" : "send_message";
    const creditCheck = await checkCredits(userId, creditService, targetContacts.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/messages");
    }

    // Verify session is actually connected in memory
    const sessionCheck = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, resolvedSessionId));
    if (!sessionCheck.length) {
      req.flash("error", "Selected session not found");
      return res.redirect("/messages");
    }
    const memStatus = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
    if (memStatus.status !== "connected") {
      console.log(`[Messages/send-bulk] Session ${resolvedSessionId} memory status=${memStatus.status}. Attempting reconnect...`);
      try {
        await req.waManager.reconnectSession(resolvedSessionId);
        await new Promise(r => setTimeout(r, 3000));
        const reconnected = req.waManager.getSessionStatus(resolvedSessionId, sessionCheck[0].userId);
        if (reconnected.status !== "connected") {
          throw new Error("Session reconnect failed");
        }
      } catch (reconnectErr) {
        console.error(`[Messages/send-bulk] Session ${resolvedSessionId} reconnect failed:`, reconnectErr.message);
        req.flash("error", "WhatsApp session is disconnected. Please go to WhatsApp Sessions and reconnect it.");
        return res.redirect("/messages");
      }
    }

    // Helper: replace template variables with contact data
    function fillVars(text, contact) {
      if (!text) return text;
      return text
        .replace(/\{\{name\}\}/gi, contact.name || '')
        .replace(/\{\{email\}\}/gi, contact.email || '')
        .replace(/\{\{phone\}\}/gi, contact.phone || '')
        .replace(/\{\{group\}\}/gi, contact.group || '')
        .replace(/\{\{tags\}\}/gi, contact.tags || '')
        .replace(/\{\{notes\}\}/gi, contact.notes || '')
        .replace(/\{\{countryCode\}\}/gi, contact.countryCode || '')
        .replace(/\{\{id\}\}/gi, String(contact.id));
    }

    const results = [];
    for (let i = 0; i < targetContacts.length; i++) {
      const contact = targetContacts[i];
      try {
        const personalizedContent = fillVars(content, contact);
        await req.waManager.sendMessage(resolvedSessionId, contact.phone, personalizedContent, msgType, mediaUrl, interactiveData);
        results.push({ phone: contact.phone, status: "success" });
      } catch (err) {
        results.push({ phone: contact.phone, status: "failed", error: err.message });
      }

      // Random 30-50 second gap between messages to avoid WhatsApp rate limits
      if (i < targetContacts.length - 1) {
        const randomGap = Math.floor(Math.random() * 20000) + 30000; // 30000-50000ms
        console.log(`[WhatsApp] Waiting ${(randomGap / 1000).toFixed(1)}s before next message...`);
        await new Promise(r => setTimeout(r, randomGap));
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    let deductedCredits = 0;
    if (successCount > 0) {
      try {
        const creditResult = await chargeCredits(req, creditService, successCount, `Bulk sent ${successCount} message(s)`);
        deductedCredits = creditResult.deducted || 0;
      } catch (creditErr) {
        req.flash("error", `Messages sent but credit deduction failed: ${creditErr.message}`);
      }
    }
    req.flash("success", `Bulk messages sent: ${successCount} successful (₹${deductedCredits} credits deducted)`);
    res.redirect("/messages");
  } catch (error) {
    console.error("Bulk send error:", error);
    req.flash("error", "Failed to send bulk messages");
    res.redirect("/messages");
  }
});

export default router;
