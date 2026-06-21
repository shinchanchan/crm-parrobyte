import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import nodemailer from "nodemailer";
import { checkCredits, deductCredits } from "../lib/credits.js";
import { triggerWebhook } from "../lib/webhookTrigger.js";
import { encrypt, decrypt } from "../lib/cryptoUtil.js";
import { sanitizeFilename } from "../lib/sanitize.js";
import path from "path";
import fs from "fs/promises";

const router = express.Router();
const MAX_ATTACHMENT_SIZE = 150 * 1024 * 1024; // 150MB

// Helper: build transporter from user's email config with smart TLS handling
export function buildTransporter(config, opts = {}) {
  const port = parseInt(config.smtpPort) || 587;
  // Auto-detect secure based on port if not explicitly set
  let secure = config.smtpSecure;
  if (opts.autoDetect !== false) {
    if (port === 465) secure = true;
    else if (port === 587 || port === 25) secure = false;
  }

  // Decrypt password before use
  const password = decrypt(config.emailPass) || config.emailPass;

  const transportConfig = {
    host: config.smtpHost,
    port,
    secure,
    auth: { user: config.emailUser, pass: password },
  };

  // Only add tls options when needed
  if (opts.ignoreCert) {
    transportConfig.tls = { rejectUnauthorized: false };
  }
  if (port === 587 && !secure) {
    transportConfig.requireTLS = true;
  }

  return nodemailer.createTransport(transportConfig);
}

// Helper: try multiple connection strategies and return working config + transporter
export async function tryConnect(config) {
  const strategies = [];
  const port = parseInt(config.smtpPort) || 587;

  // Strategy 1: User's explicit settings (no cert bypass)
  strategies.push({ ...config, smtpSecure: config.smtpSecure, ignoreCert: false });

  // Strategy 2: Auto-detect by port (no cert bypass)
  if (port === 465) {
    strategies.push({ ...config, smtpSecure: true, ignoreCert: false });
  } else {
    strategies.push({ ...config, smtpSecure: false, ignoreCert: false });
  }

  // Strategy 3: Opposite of auto-detect (some hosts use non-standard ports)
  if (port === 465) {
    strategies.push({ ...config, smtpSecure: false, ignoreCert: false });
  } else {
    strategies.push({ ...config, smtpSecure: true, ignoreCert: false });
  }

  // Strategy 4: With cert bypass (last resort)
  strategies.push({ ...config, smtpSecure: false, ignoreCert: true });
  strategies.push({ ...config, smtpSecure: true, ignoreCert: true });

  let lastErr = null;
  for (const strategy of strategies) {
    try {
      const transporter = buildTransporter(strategy, { autoDetect: false, ignoreCert: strategy.ignoreCert });
      await transporter.verify();
      return {
        success: true,
        transporter,
        workingConfig: {
          smtpSecure: strategy.smtpSecure,
          smtpPort: strategy.smtpPort,
        },
      };
    } catch (err) {
      lastErr = err;
      // Only log debug, don't throw yet
      console.log(`[Email] Connection attempt failed (secure=${strategy.smtpSecure}, ignoreCert=${strategy.ignoreCert}):`, err.message);
    }
  }

  return { success: false, error: lastErr };
}

// Helper: get or create user's email config
export async function getEmailConfig(userId) {
  const rows = await db.select().from(schema.emailConfigs)
    .where(eq(schema.emailConfigs.userId, userId));
  return rows.length ? rows[0] : null;
}

// GET /email - Email dashboard
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const config = await getEmailConfig(userId);
    const templates = await db.select().from(schema.emailTemplates)
      .where(eq(schema.emailTemplates.userId, userId))
      .orderBy(desc(schema.emailTemplates.createdAt));
    const messages = await db.select().from(schema.emailMessages)
      .where(eq(schema.emailMessages.userId, userId))
      .orderBy(desc(schema.emailMessages.createdAt))
      .limit(50);
    const rules = await db.select().from(schema.emailAutomationRules)
      .where(eq(schema.emailAutomationRules.userId, userId))
      .orderBy(desc(schema.emailAutomationRules.createdAt));
    const contacts = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.userId, userId));
    const scheduledEmailsData = await db.select().from(schema.scheduledEmails)
      .where(eq(schema.scheduledEmails.userId, userId))
      .orderBy(desc(schema.scheduledEmails.scheduledAt));

    res.render("pages/email/index", {
      title: "Email Automation - ParroByte CRM",
      config,
      templates,
      messages,
      rules,
      contacts,
      scheduledEmailsData,
    });
  } catch (error) {
    console.error("Email dashboard error:", error);
    req.flash("error", "Failed to load email dashboard");
    res.redirect("/dashboard");
  }
});

// POST /email/config - Save or update email config
router.post("/config", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { smtpHost, smtpPort, smtpSecure, imapHost, imapPort, imapSecure, emailUser, emailPass, fromName } = req.body;

    if (!smtpHost || !emailUser || !emailPass) {
      req.flash("error", "SMTP Host, Email, and Password are required");
      return res.redirect("/email");
    }

    // Verify SMTP connection with smart fallback strategies
    const testConfig = {
      smtpHost,
      smtpPort: parseInt(smtpPort) || 587,
      smtpSecure: smtpSecure === "on" || smtpSecure === true,
      emailUser,
      emailPass,
    };

    const connectResult = await tryConnect(testConfig);
    if (!connectResult.success) {
      const errMsg = connectResult.error?.message || "Unknown error";
      let friendlyMsg = errMsg;
      if (errMsg.includes("wrong version number")) {
        friendlyMsg = "SSL/TLS mismatch. Try port 587 with SSL OFF, or port 465 with SSL ON. Gmail users: use port 587 + SSL OFF.";
      } else if (errMsg.includes("Invalid login") || errMsg.includes("Authentication")) {
        friendlyMsg = "Invalid email or app password. For Gmail, generate an App Password at myaccount.google.com/apppasswords";
      } else if (errMsg.includes("connect")) {
        friendlyMsg = "Cannot connect to mail server. Check SMTP host and port.";
      }
      req.flash("error", "SMTP verification failed: " + friendlyMsg);
      return res.redirect("/email");
    }

    // Auto-correct port/secure settings if a different strategy worked
    const corrected = connectResult.workingConfig;
    console.log(`[Email] SMTP verified with secure=${corrected.smtpSecure}, port=${corrected.smtpPort}`);

    const existing = await getEmailConfig(userId);
    const data = {
      smtpHost,
      smtpPort: corrected.smtpPort || parseInt(smtpPort) || 587,
      smtpSecure: corrected.smtpSecure,
      imapHost: imapHost || null,
      imapPort: imapPort ? parseInt(imapPort) : null,
      imapSecure: imapSecure === "on" || imapSecure === true,
      emailUser,
      emailPass: encrypt(emailPass), // Encrypt before storing
      fromName: fromName || emailUser,
      fromEmail: emailUser,
    };

    if (existing) {
      await db.update(schema.emailConfigs).set(data).where(eq(schema.emailConfigs.id, existing.id));
    } else {
      await db.insert(schema.emailConfigs).values({ userId, ...data });
    }

    req.flash("success", "Email configuration saved and verified");
    res.redirect("/email");
  } catch (error) {
    console.error("Email config error:", error);
    req.flash("error", "Failed to save email config");
    res.redirect("/email");
  }
});

// POST /email/send - Send single email
router.post("/send", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { to, subject, body, isHtml, contactId, templateId, scheduledAt } = req.body;

    // Handle scheduled send
    if (scheduledAt) {
      const scheduleTime = new Date(scheduledAt);
      if (!isNaN(scheduleTime.getTime()) && scheduleTime > new Date()) {
        await db.insert(schema.scheduledEmails).values({
          userId,
          toEmail: to,
          subject,
          body,
          isHtml: isHtml === "true" || isHtml === true,
          scheduledAt: scheduleTime,
          contactId: contactId ? parseInt(contactId) : null,
          templateId: templateId ? parseInt(templateId) : null,
        });
        req.flash("success", `Email scheduled for ${scheduleTime.toLocaleString()}`);
        return res.redirect("/email");
      }
    }

    // Credit check for immediate send
    const creditCheck = await checkCredits(userId, "send_email");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/email");
    }

    const config = await getEmailConfig(userId);
    if (!config) {
      req.flash("error", "Please configure your email settings first");
      return res.redirect("/email");
    }

    // Handle attachments from form
    const attachments = [];
    if (req.files && req.files.attachments) {
      const files = Array.isArray(req.files.attachments) ? req.files.attachments : [req.files.attachments];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          req.flash("error", `Attachment "${file.name}" exceeds 150MB limit`);
          return res.redirect("/email");
        }
        attachments.push({ filename: file.name, content: file.data });
      }
    }

    // Include template attachments if templateId provided
    if (templateId) {
      const tmpl = await db.select().from(schema.emailTemplates)
        .where(and(eq(schema.emailTemplates.id, parseInt(templateId)), eq(schema.emailTemplates.userId, userId)));
      if (tmpl.length && tmpl[0].attachments) {
        try {
          const tmplAttachments = JSON.parse(tmpl[0].attachments);
          for (const att of tmplAttachments) {
            const attPath = path.join(process.cwd(), "public", att.path);
            try {
              const data = await fs.readFile(attPath);
              attachments.push({ filename: att.filename, content: data });
            } catch (e) {
              console.error("[Email] Failed to read template attachment:", attPath, e.message);
            }
          }
        } catch (e) {
          console.error("[Email] Failed to parse template attachments:", e.message);
        }
      }
    }

    const transporter = buildTransporter(config);
    const info = await transporter.sendMail({
      from: `"${config.fromName || config.emailUser}" <${config.fromEmail || config.emailUser}>`,
      to,
      subject,
      [isHtml === "true" || isHtml === true ? "html" : "text"]: body,
      attachments,
      headers: {
        "X-Mailer": "ParroByte-CRM",
        "List-Unsubscribe": `<mailto:${config.emailUser}?subject=unsubscribe>`,
      },
    });

    // Log message
    await db.insert(schema.emailMessages).values({
      userId,
      templateId: templateId ? parseInt(templateId) : null,
      direction: "outbound",
      fromEmail: config.fromEmail || config.emailUser,
      toEmail: to,
      subject,
      body,
      attachments: attachments.length ? JSON.stringify(attachments.map(a => ({ filename: a.filename, size: a.content?.length || 0 }))) : null,
      status: "sent",
      contactId: contactId ? parseInt(contactId) : null,
      messageId: info.messageId,
      sentAt: new Date(),
    });

    // Deduct credits
    await deductCredits(userId, "send_email", 1, `Email sent to ${to}`);

    triggerWebhook(userId, "email.sent", { to, subject, messageId: info.messageId });

    req.flash("success", "Email sent successfully");
    res.redirect("/email");
  } catch (error) {
    console.error("Email send error:", error);
    req.flash("error", "Failed to send email: " + error.message);
    res.redirect("/email");
  }
});

// POST /email/bulk-send - Send bulk email to contacts
router.post("/bulk-send", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { contactIds, subject, body, isHtml, templateId } = req.body;

    if (!contactIds || !contactIds.length) {
      return res.status(400).json({ success: false, error: "No contacts selected" });
    }

    const config = await getEmailConfig(userId);
    if (!config) {
      return res.status(400).json({ success: false, error: "Email not configured" });
    }

    // Credit check for bulk
    const qty = Array.isArray(contactIds) ? contactIds.length : 1;
    const creditCheck = await checkCredits(userId, "send_email", qty);
    if (!creditCheck.allowed) {
      return res.status(400).json({ success: false, error: creditCheck.message });
    }

    const ids = Array.isArray(contactIds) ? contactIds.map(Number) : [Number(contactIds)];
    const contacts = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.userId, userId), eq(schema.contacts.id, ids[0])));
    // Note: Drizzle inArray not easily available, query individually or use raw
    // For simplicity, fetch all contacts and filter in-memory
    const allContacts = await db.select().from(schema.contacts).where(eq(schema.contacts.userId, userId));
    const targetContacts = allContacts.filter(c => ids.includes(c.id) && c.email);

    if (!targetContacts.length) {
      return res.status(400).json({ success: false, error: "No valid contacts with email addresses" });
    }

    const transporter = buildTransporter(config);
    const results = { sent: 0, failed: 0, errors: [] };

    for (const contact of targetContacts) {
      try {
        // Replace variables in body/subject
        let personalizedBody = body
          .replace(/\{\{name\}\}/g, contact.name || "")
          .replace(/\{\{email\}\}/g, contact.email || "")
          .replace(/\{\{phone\}\}/g, contact.phone || "");
        let personalizedSubject = subject
          .replace(/\{\{name\}\}/g, contact.name || "");

        const info = await transporter.sendMail({
          from: `"${config.fromName || config.emailUser}" <${config.fromEmail || config.emailUser}>`,
          to: contact.email,
          subject: personalizedSubject,
          [isHtml === "true" || isHtml === true ? "html" : "text"]: personalizedBody,
          headers: {
            "X-Mailer": "ParroByte-CRM",
            "List-Unsubscribe": `<mailto:${config.emailUser}?subject=unsubscribe>`,
          },
        });

        await db.insert(schema.emailMessages).values({
          userId,
          templateId: templateId ? parseInt(templateId) : null,
          direction: "outbound",
          fromEmail: config.fromEmail || config.emailUser,
          toEmail: contact.email,
          subject: personalizedSubject,
          body: personalizedBody,
          status: "sent",
          contactId: contact.id,
          messageId: info.messageId,
          sentAt: new Date(),
        });

        results.sent++;

        // Rate limit: 3-second gap between bulk emails to avoid spam
        if (targetContacts.indexOf(contact) < targetContacts.length - 1) {
          await new Promise(r => setTimeout(r, 3000));
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ contact: contact.email, error: err.message });
        console.error(`[BulkEmail] Failed to send to ${contact.email}:`, err.message);
      }
    }

    // Deduct credits for successful sends
    if (results.sent > 0) {
      await deductCredits(userId, "send_email", results.sent, `Bulk email to ${results.sent} contacts`);
    }

    res.json({ success: true, message: `Sent ${results.sent}, failed ${results.failed}`, results });
  } catch (error) {
    console.error("Bulk email error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Template CRUD
router.post("/templates/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, subject, content, isHtml } = req.body;

    // Credit check
    const creditCheck = await checkCredits(userId, "create_email_template");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/email");
    }

    // Handle template attachments
    const templateAttachments = [];
    if (req.files && req.files.attachments) {
      const files = Array.isArray(req.files.attachments) ? req.files.attachments : [req.files.attachments];
      const uploadDir = path.join(process.cwd(), "public/uploads/email-attachments");
      await fs.mkdir(uploadDir, { recursive: true });
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_SIZE) continue;
        const filename = `tmpl_${Date.now()}_${sanitizeFilename(file.name)}`;
        const filepath = path.join(uploadDir, filename);
        await file.mv(filepath);
        templateAttachments.push({ filename: file.name, path: `/uploads/email-attachments/${filename}` });
      }
    }

    await db.insert(schema.emailTemplates).values({
      userId, name, subject, content,
      isHtml: isHtml === "on" || isHtml === true,
      attachments: templateAttachments.length ? JSON.stringify(templateAttachments) : null,
    });

    await deductCredits(userId, "create_email_template", 1, `Created email template: ${name}`);
    req.flash("success", "Template created");
    res.redirect("/email");
  } catch (error) {
    console.error("Template create error:", error);
    req.flash("error", "Failed to create template");
    res.redirect("/email");
  }
});

router.post("/templates/update/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    const { name, subject, content, isHtml, isActive } = req.body;

    const updates = { name, subject, content, isHtml: isHtml === "on" || isHtml === true, isActive: isActive === "on" || isActive === true };

    // Handle template attachments
    if (req.files && req.files.attachments) {
      const files = Array.isArray(req.files.attachments) ? req.files.attachments : [req.files.attachments];
      const uploadDir = path.join(process.cwd(), "public/uploads/email-attachments");
      await fs.mkdir(uploadDir, { recursive: true });
      const templateAttachments = [];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_SIZE) continue;
        const filename = `tmpl_${Date.now()}_${sanitizeFilename(file.name)}`;
        const filepath = path.join(uploadDir, filename);
        await file.mv(filepath);
        templateAttachments.push({ filename: file.name, path: `/uploads/email-attachments/${filename}` });
      }
      if (templateAttachments.length) updates.attachments = JSON.stringify(templateAttachments);
    }

    await db.update(schema.emailTemplates)
      .set(updates)
      .where(and(eq(schema.emailTemplates.id, id), eq(schema.emailTemplates.userId, userId)));

    req.flash("success", "Template updated");
    res.redirect("/email");
  } catch (error) {
    req.flash("error", "Failed to update template");
    res.redirect("/email");
  }
});

router.post("/templates/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    await db.delete(schema.emailTemplates)
      .where(and(eq(schema.emailTemplates.id, id), eq(schema.emailTemplates.userId, userId)));
    req.flash("success", "Template deleted");
    res.redirect("/email");
  } catch (error) {
    req.flash("error", "Failed to delete template");
    res.redirect("/email");
  }
});

// Automation Rules
router.post("/rules/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, triggerType, triggerValue, responseType, responseContent, templateId, aiPrompt } = req.body;

    const creditCheck = await checkCredits(userId, "create_email_automation");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/email");
    }

    await db.insert(schema.emailAutomationRules).values({
      userId, name, triggerType, triggerValue, responseType, responseContent,
      templateId: templateId ? parseInt(templateId) : null,
      aiPrompt: aiPrompt || null,
    });

    await deductCredits(userId, "create_email_automation", 1, `Created email automation: ${name}`);
    req.flash("success", "Automation rule created");
    res.redirect("/email");
  } catch (error) {
    console.error("Rule create error:", error);
    req.flash("error", "Failed to create rule");
    res.redirect("/email");
  }
});

router.post("/rules/update/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    const { name, triggerType, triggerValue, responseType, responseContent, templateId, aiPrompt, isActive } = req.body;
    await db.update(schema.emailAutomationRules)
      .set({ name, triggerType, triggerValue, responseType, responseContent, templateId: templateId ? parseInt(templateId) : null, aiPrompt, isActive: isActive === "on" || isActive === true })
      .where(and(eq(schema.emailAutomationRules.id, id), eq(schema.emailAutomationRules.userId, userId)));
    req.flash("success", "Rule updated");
    res.redirect("/email");
  } catch (error) {
    req.flash("error", "Failed to update rule");
    res.redirect("/email");
  }
});

router.post("/rules/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    await db.delete(schema.emailAutomationRules)
      .where(and(eq(schema.emailAutomationRules.id, id), eq(schema.emailAutomationRules.userId, userId)));
    req.flash("success", "Rule deleted");
    res.redirect("/email");
  } catch (error) {
    req.flash("error", "Failed to delete rule");
    res.redirect("/email");
  }
});

// Public incoming email webhook
// REQUIRES X-Email-Webhook-Secret header matching EMAIL_WEBHOOK_SECRET env var
router.post("/incoming", async (req, res) => {
  try {
    const secret = process.env.EMAIL_WEBHOOK_SECRET;
    const provided = req.headers["x-email-webhook-secret"] || "";
    if (secret && provided !== secret) {
      return res.status(401).json({ success: false, error: "Invalid or missing webhook secret" });
    }

    const { userId, from, to, subject, body, bodyText, messageId } = req.body;

    if (!userId || !from) {
      return res.status(400).json({ success: false, error: "Missing userId or from" });
    }

    // Log incoming email
    const msgResult = await db.insert(schema.emailMessages).values({
      userId: parseInt(userId),
      direction: "inbound",
      fromEmail: from,
      toEmail: to || "",
      subject: subject || "",
      body: body || bodyText || "",
      bodyText: bodyText || body || "",
      messageId: messageId || null,
      status: "delivered",
    }).returning();
    const msgId = msgResult[0].id;

    // Find or create contact
    let contact = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.userId, userId), eq(schema.contacts.email, from)));
    let contactId = contact.length ? contact[0].id : null;

    if (!contactId) {
      // Create contact from email sender
      const newContact = await db.insert(schema.contacts).values({
        userId: parseInt(userId),
        name: from.split("@")[0] || "Email Contact",
        email: from,
        phone: "",
        source: "email",
      }).returning();
      contactId = newContact[0].id;
    }

    // Update message with contactId
    await db.update(schema.emailMessages)
      .set({ contactId })
      .where(eq(schema.emailMessages.id, msgId));

    // Create/update lead
    const existingLeads = await db.select().from(schema.leads)
      .where(and(eq(schema.leads.userId, userId), eq(schema.leads.email, from)));

    if (existingLeads.length) {
      await db.update(schema.leads)
        .set({ status: "contacted", lastContactedAt: new Date(), notes: `Replied via email: ${subject}` })
        .where(eq(schema.leads.id, existingLeads[0].id));
    } else {
      await db.insert(schema.leads).values({
        userId: parseInt(userId),
        source: "email",
        name: from.split("@")[0] || "Email Contact",
        email: from,
        status: "new",
        notes: `Incoming email: ${subject}`,
      });
    }

    // Process automation rules
    const rules = await db.select().from(schema.emailAutomationRules)
      .where(and(eq(schema.emailAutomationRules.userId, userId), eq(schema.emailAutomationRules.isActive, true)));

    for (const rule of rules) {
      let matched = false;
      const searchBody = (bodyText || body || "").toLowerCase();
      const searchSubject = (subject || "").toLowerCase();
      const triggerVal = (rule.triggerValue || "").toLowerCase();

      if (rule.triggerType === "all") matched = true;
      else if (rule.triggerType === "contains") matched = searchBody.includes(triggerVal) || searchSubject.includes(triggerVal);
      else if (rule.triggerType === "exact") matched = searchBody === triggerVal;
      else if (rule.triggerType === "from_domain") matched = from.toLowerCase().includes(triggerVal);

      if (matched) {
        // Send auto-reply
        const config = await getEmailConfig(userId);
        if (config) {
          let replyBody = rule.responseContent;
          if (rule.responseType === "ai") {
            // AI reply placeholder - queue for background processing
            replyBody = rule.aiPrompt || "Thank you for your email. We will get back to you shortly.";
          } else if (rule.responseType === "template" && rule.templateId) {
            const tmpl = await db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.id, rule.templateId));
            if (tmpl.length) replyBody = tmpl[0].content;
          }

          try {
            const transporter = buildTransporter(config);
            await transporter.sendMail({
              from: `"${config.fromName || config.emailUser}" <${config.fromEmail || config.emailUser}>`,
              to: from,
              subject: `Re: ${subject || "Your email"}`,
              text: replyBody,
              headers: { "X-Mailer": "ParroByte-CRM" },
            });

            await db.insert(schema.emailMessages).values({
              userId: parseInt(userId),
              direction: "outbound",
              fromEmail: config.fromEmail || config.emailUser,
              toEmail: from,
              subject: `Re: ${subject || ""}`,
              body: replyBody,
              status: "sent",
              contactId,
            });

            await db.update(schema.emailAutomationRules)
              .set({ usageCount: (rule.usageCount || 0) + 1 })
              .where(eq(schema.emailAutomationRules.id, rule.id));
          } catch (replyErr) {
            console.error("[EmailAutoReply] Failed:", replyErr.message);
          }
        }
      }
    }

    triggerWebhook(userId, "email.received", { from, subject, messageId });
    res.json({ success: true, message: "Email processed" });
  } catch (error) {
    console.error("Incoming email error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Scheduled Emails
router.post("/schedule", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { to, subject, body, isHtml, scheduledAt, contactId, templateId } = req.body;

    if (!to || !subject || !body || !scheduledAt) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const scheduleTime = new Date(scheduledAt);
    if (isNaN(scheduleTime.getTime()) || scheduleTime <= new Date()) {
      return res.status(400).json({ success: false, error: "Invalid schedule time. Must be in the future." });
    }

    await db.insert(schema.scheduledEmails).values({
      userId,
      toEmail: to,
      subject,
      body,
      isHtml: isHtml === "true" || isHtml === true,
      scheduledAt: scheduleTime,
      contactId: contactId ? parseInt(contactId) : null,
      templateId: templateId ? parseInt(templateId) : null,
    });

    res.json({ success: true, message: `Email scheduled for ${scheduleTime.toLocaleString()}` });
  } catch (error) {
    console.error("Schedule email error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/schedule/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    await db.delete(schema.scheduledEmails)
      .where(and(eq(schema.scheduledEmails.id, id), eq(schema.scheduledEmails.userId, userId), eq(schema.scheduledEmails.status, "pending")));
    req.flash("success", "Scheduled email cancelled");
    res.redirect("/email");
  } catch (error) {
    req.flash("error", "Failed to cancel");
    res.redirect("/email");
  }
});

// GET /email/templates/:id - JSON API for template
router.get("/templates/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    const tmpl = await db.select().from(schema.emailTemplates)
      .where(and(eq(schema.emailTemplates.id, id), eq(schema.emailTemplates.userId, userId)));
    if (!tmpl.length) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, template: tmpl[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cron job processor: send scheduled emails
export async function processScheduledEmails() {
  try {
    const now = new Date();
    const pending = await db.select().from(schema.scheduledEmails)
      .where(and(eq(schema.scheduledEmails.status, "pending"), sql`${schema.scheduledEmails.scheduledAt} <= ${now}`));

    if (!pending.length) return;
    console.log(`[EmailCron] Processing ${pending.length} scheduled email(s)`);

    for (const job of pending) {
      // Mark as processing
      await db.update(schema.scheduledEmails)
        .set({ status: "processing" })
        .where(eq(schema.scheduledEmails.id, job.id));

      try {
        const config = await getEmailConfig(job.userId);
        if (!config) {
          await db.update(schema.scheduledEmails)
            .set({ status: "failed", errorMessage: "Email config not found" })
            .where(eq(schema.scheduledEmails.id, job.id));
          continue;
        }

        const transporter = buildTransporter(config);
        const info = await transporter.sendMail({
          from: `"${config.fromName || config.emailUser}" <${config.fromEmail || config.emailUser}>`,
          to: job.toEmail,
          subject: job.subject,
          [job.isHtml ? "html" : "text"]: job.body,
          headers: { "X-Mailer": "ParroByte-CRM", "List-Unsubscribe": `<mailto:${config.emailUser}?subject=unsubscribe>` },
        });

        // Log sent message
        await db.insert(schema.emailMessages).values({
          userId: job.userId,
          templateId: job.templateId,
          direction: "outbound",
          fromEmail: config.fromEmail || config.emailUser,
          toEmail: job.toEmail,
          subject: job.subject,
          body: job.body,
          status: "sent",
          contactId: job.contactId,
          messageId: info.messageId,
          sentAt: new Date(),
        });

        await db.update(schema.scheduledEmails)
          .set({ status: "sent", sentAt: new Date() })
          .where(eq(schema.scheduledEmails.id, job.id));

        // Deduct credits
        await deductCredits(job.userId, "send_email", 1, `Scheduled email to ${job.toEmail}`);

        console.log(`[EmailCron] Scheduled email ${job.id} sent to ${job.toEmail}`);
      } catch (err) {
        console.error(`[EmailCron] Failed to send scheduled email ${job.id}:`, err.message);
        await db.update(schema.scheduledEmails)
          .set({ status: "failed", errorMessage: err.message })
          .where(eq(schema.scheduledEmails.id, job.id));
      }
    }
  } catch (error) {
    console.error("[EmailCron] Processor error:", error.message);
  }
}

export default router;
