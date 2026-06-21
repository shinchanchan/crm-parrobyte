import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import { encrypt, decrypt } from "../lib/cryptoUtil.js";
import {
  validateCredentials,
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveMessage,
  uploadMedia,
  getTemplates,
  createTemplate,
  deleteTemplate,
  verifyWebhookSignature,
  parseIncomingWebhook,
  generateWebhookToken,
} from "../lib/metaWhatsApp.js";

const router = express.Router();

// Simple auth middleware for routes that need it (webhooks are public)
function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.flash("error", "Please login to access this page");
    return res.redirect("/auth/login");
  }
  next();
}

// ============================================
// DASHBOARD / LIST ACCOUNTS
// ============================================
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(isAdmin ? undefined : eq(schema.metaWhatsappAccounts.userId, userId))
      .orderBy(desc(schema.metaWhatsappAccounts.createdAt));

    // Get quick stats
    let stats = { todaySent: 0, totalSent: 0, templatesApproved: 0 };
    if (accounts.length) {
      const accountIds = accounts.map(a => a.id);
      const messages = await db.select().from(schema.whatsappApiMessages)
        .where(isAdmin ? undefined : eq(schema.whatsappApiMessages.userId, userId));

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      stats.todaySent = messages.filter(m => m.direction === "outbound" && new Date(m.createdAt) >= today).length;
      stats.totalSent = messages.filter(m => m.direction === "outbound").length;

      const templates = await db.select().from(schema.whatsappApiTemplates)
        .where(isAdmin ? undefined : eq(schema.whatsappApiTemplates.userId, userId));
      stats.templatesApproved = templates.filter(t => t.status === "approved").length;
    }

    res.render("pages/metaWhatsapp/index", {
      title: "Meta WhatsApp API - ParroByte CRM",
      accounts,
      stats,
      isAdmin,
    });
  } catch (error) {
    console.error("[MetaWhatsApp] Dashboard error:", error.message);
    req.flash("error", "Failed to load Meta WhatsApp API dashboard");
    res.redirect("/dashboard");
  }
});

// ============================================
// CONNECT / SAVE CREDENTIALS
// ============================================
router.post("/connect", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountName, appId, appSecret, accessToken, phoneNumberId, wabaId } = req.body;

    if (!accountName || !appId || !accessToken || !phoneNumberId || !wabaId) {
      req.flash("error", "All fields are required: Account Name, App ID, Access Token, Phone Number ID, and WABA ID");
      return res.redirect("/meta-whatsapp");
    }

    // Validate credentials against Meta API
    let validated;
    try {
      validated = await validateCredentials(accessToken, phoneNumberId);
    } catch (err) {
      console.error("[MetaWhatsApp] Validation failed:", err.message);
      req.flash("error", `Credential validation failed: ${err.message}. Please check your App ID, Access Token, and Phone Number ID.`);
      return res.redirect("/meta-whatsapp");
    }

    // Encrypt sensitive fields
    const encryptedSecret = appSecret ? encrypt(appSecret) : null;
    const encryptedToken = encrypt(accessToken);

    const verifyToken = generateWebhookToken();

    await db.insert(schema.metaWhatsappAccounts).values({
      userId,
      accountName: accountName.trim(),
      appId: appId.trim(),
      appSecret: encryptedSecret,
      accessToken: encryptedToken,
      phoneNumberId: phoneNumberId.trim(),
      wabaId: wabaId.trim(),
      displayPhoneNumber: validated.displayPhoneNumber || null,
      status: "connected",
      webhookVerifyToken: verifyToken,
      lastValidatedAt: new Date(),
      isActive: true,
    });

    req.flash("success", `Meta WhatsApp API connected! Phone: ${validated.displayPhoneNumber || phoneNumberId}`);
    res.redirect("/meta-whatsapp");
  } catch (error) {
    console.error("[MetaWhatsApp] Connect error:", error.message);
    req.flash("error", "Failed to connect Meta WhatsApp API: " + error.message);
    res.redirect("/meta-whatsapp");
  }
});

// ============================================
// DISCONNECT ACCOUNT
// ============================================
router.post("/disconnect/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const accountId = parseInt(id);
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const rows = await db.select().from(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.id, accountId));

    if (!rows.length) {
      req.flash("error", "Account not found");
      return res.redirect("/meta-whatsapp");
    }

    if (rows[0].userId !== userId && !isAdmin) {
      req.flash("error", "Unauthorized");
      return res.redirect("/meta-whatsapp");
    }

    await db.delete(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.id, accountId));

    req.flash("success", "Meta WhatsApp account disconnected");
    res.redirect("/meta-whatsapp");
  } catch (error) {
    console.error("[MetaWhatsApp] Disconnect error:", error.message);
    req.flash("error", "Failed to disconnect account");
    res.redirect("/meta-whatsapp");
  }
});

// ============================================
// SEND MESSAGE PAGE
// ============================================
router.get("/send", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(and(
        eq(schema.metaWhatsappAccounts.userId, userId),
        eq(schema.metaWhatsappAccounts.isActive, true),
        eq(schema.metaWhatsappAccounts.status, "connected")
      ));

    // Fetch approved templates for template selector
    const templates = await db.select().from(schema.whatsappApiTemplates)
      .where(and(
        eq(schema.whatsappApiTemplates.userId, userId),
        eq(schema.whatsappApiTemplates.status, "approved")
      ));

    const creditConfig = await db.select().from(schema.creditConfigs)
      .where(eq(schema.creditConfigs.serviceKey, "whatsapp_api_message"));

    res.render("pages/metaWhatsapp/send", {
      title: "Send WhatsApp API Message - ParroByte CRM",
      accounts,
      templates,
      creditCost: creditConfig.length ? parseFloat(creditConfig[0].cost) : 1.00,
    });
  } catch (error) {
    console.error("[MetaWhatsApp] Send page error:", error.message);
    req.flash("error", "Failed to load send page");
    res.redirect("/meta-whatsapp");
  }
});

// ============================================
// SEND MESSAGE ACTION
// ============================================
router.post("/send", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountId, phone, messageType, text, templateId, caption } = req.body;

    if (!accountId || !phone) {
      req.flash("error", "Account and phone number are required");
      return res.redirect("/meta-whatsapp/send");
    }

    // Verify account ownership
    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.id, parseInt(accountId)));

    if (!accounts.length || accounts[0].userId !== userId) {
      req.flash("error", "Unauthorized: account does not belong to you");
      return res.redirect("/meta-whatsapp/send");
    }

    const account = accounts[0];
    const accessToken = decrypt(account.accessToken);

    // Check credits before sending
    const creditCheck = await checkCredits(userId, "whatsapp_api_message");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/meta-whatsapp/send");
    }

    let result;
    let msgType = messageType || "text";
    let content = text || "";
    let mediaUrl = null;
    let templateName = null;

    if (msgType === "template" && templateId) {
      const templates = await db.select().from(schema.whatsappApiTemplates)
        .where(eq(schema.whatsappApiTemplates.id, parseInt(templateId)));
      if (!templates.length || templates[0].userId !== userId) {
        req.flash("error", "Template not found");
        return res.redirect("/meta-whatsapp/send");
      }
      const tpl = templates[0];
      result = await sendTemplateMessage(
        account.phoneNumberId,
        accessToken,
        phone,
        tpl.templateName,
        tpl.language
      );
      templateName = tpl.templateName;
      content = `[Template: ${tpl.templateName}]`;
    } else if (msgType === "text") {
      if (!text || !text.trim()) {
        req.flash("error", "Message text is required");
        return res.redirect("/meta-whatsapp/send");
      }
      result = await sendTextMessage(account.phoneNumberId, accessToken, phone, text.trim());
    } else if (["image", "document", "video", "audio"].includes(msgType)) {
      // Media upload required
      if (!req.files || !req.files.mediaFile) {
        req.flash("error", "Media file is required for this message type");
        return res.redirect("/meta-whatsapp/send");
      }
      const file = req.files.mediaFile;
      const uploadResult = await uploadMedia(account.phoneNumberId, accessToken, file.data, file.mimetype);
      result = await sendMediaMessage(account.phoneNumberId, accessToken, phone, msgType, uploadResult.mediaId, caption || "");
      mediaUrl = uploadResult.mediaId;
    } else if (msgType === "buttons") {
      const buttons = [];
      for (let i = 1; i <= 3; i++) {
        const btn = req.body[`btn_${i}`];
        if (btn && btn.trim()) {
          buttons.push({ type: "reply", reply: { id: `btn-${i}`, title: btn.trim().substring(0, 20) } });
        }
      }
      if (buttons.length === 0) {
        req.flash("error", "At least one button is required");
        return res.redirect("/meta-whatsapp/send");
      }
      if (!content || !content.trim()) {
        req.flash("error", "Message body is required for button messages");
        return res.redirect("/meta-whatsapp/send");
      }
      result = await sendInteractiveMessage(
        account.phoneNumberId,
        accessToken,
        phone,
        "button",
        {
          body: content.trim().substring(0, 1024),
          footer: req.body.btnFooter || undefined,
          action: { buttons },
        }
      );
    } else if (msgType === "list") {
      if (!content || !content.trim()) {
        req.flash("error", "Message body is required for list messages");
        return res.redirect("/meta-whatsapp/send");
      }
      const sectionTitle = req.body.listSectionTitles || "Options";
      const rowsRaw = (req.body.listSectionRows || "").split("\n").map(line => {
        const [title, ...descParts] = line.split("|");
        return { title: (title || "").trim(), description: descParts.join("|").trim() };
      }).filter(r => r.title);
      if (rowsRaw.length === 0) {
        req.flash("error", "At least one list option is required");
        return res.redirect("/meta-whatsapp/send");
      }
      const rows = rowsRaw.map((r, idx) => ({
        id: `row-${idx + 1}`,
        title: r.title.substring(0, 24),
        description: r.description ? r.description.substring(0, 72) : undefined,
      }));
      result = await sendInteractiveMessage(
        account.phoneNumberId,
        accessToken,
        phone,
        "list",
        {
          body: content.trim().substring(0, 1024),
          footer: req.body.listFooter || undefined,
          action: {
            button: (req.body.listButtonText || "Select").substring(0, 20),
            sections: [{ title: sectionTitle.substring(0, 24), rows }],
          },
        }
      );
    } else {
      req.flash("error", "Invalid message type");
      return res.redirect("/meta-whatsapp/send");
    }

    // Deduct credits
    await chargeCredits(req, "whatsapp_api_message", 1, `WhatsApp API message to ${phone}`);

    // Log message
    await db.insert(schema.whatsappApiMessages).values({
      userId,
      accountId: account.id,
      phone: phone.replace(/\D/g, ""),
      direction: "outbound",
      type: msgType,
      content: content.substring(0, 4096),
      mediaUrl,
      templateName,
      status: "sent",
      metaMessageId: result.messageId,
      conversationId: result.conversationId,
      conversationCategory: result.conversationCategory,
      sentAt: new Date(),
    });

    req.flash("success", `Message sent successfully! Message ID: ${result.messageId} (${creditCheck.cost} credits used)`);
    res.redirect("/meta-whatsapp/send");
  } catch (error) {
    console.error("[MetaWhatsApp] Send error:", error.message);

    // Log failed attempt
    try {
      await db.insert(schema.whatsappApiMessages).values({
        userId: req.session.user.id,
        accountId: req.body.accountId ? parseInt(req.body.accountId) : null,
        phone: (req.body.phone || "").replace(/\D/g, ""),
        direction: "outbound",
        type: req.body.messageType || "text",
        content: (req.body.text || "").substring(0, 4096),
        status: "failed",
        errorMessage: error.message,
      });
    } catch (e) {}

    req.flash("error", "Failed to send message: " + error.message);
    res.redirect("/meta-whatsapp/send");
  }
});

// ============================================
// TEMPLATES PAGE
// ============================================
router.get("/templates", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(and(
        eq(schema.metaWhatsappAccounts.userId, userId),
        eq(schema.metaWhatsappAccounts.isActive, true)
      ));

    const templates = await db.select().from(schema.whatsappApiTemplates)
      .where(eq(schema.whatsappApiTemplates.userId, userId))
      .orderBy(desc(schema.whatsappApiTemplates.createdAt));

    const creditConfig = await db.select().from(schema.creditConfigs)
      .where(eq(schema.creditConfigs.serviceKey, "whatsapp_api_template"));

    res.render("pages/metaWhatsapp/templates", {
      title: "WhatsApp API Templates - ParroByte CRM",
      accounts,
      templates,
      creditCost: creditConfig.length ? parseFloat(creditConfig[0].cost) : 5.00,
    });
  } catch (error) {
    console.error("[MetaWhatsApp] Templates page error:", error.message);
    req.flash("error", "Failed to load templates");
    res.redirect("/meta-whatsapp");
  }
});

// ============================================
// SYNC TEMPLATES FROM META
// ============================================
router.post("/templates/sync", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountId } = req.body;

    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.id, parseInt(accountId)));

    if (!accounts.length || accounts[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/meta-whatsapp/templates");
    }

    const account = accounts[0];
    const accessToken = decrypt(account.accessToken);

    const metaTemplates = await getTemplates(account.wabaId, accessToken);

    // Upsert templates
    for (const tpl of metaTemplates) {
      const existing = await db.select().from(schema.whatsappApiTemplates)
        .where(and(
          eq(schema.whatsappApiTemplates.userId, userId),
          eq(schema.whatsappApiTemplates.metaTemplateId, tpl.metaTemplateId)
        ));

      if (existing.length) {
        await db.update(schema.whatsappApiTemplates)
          .set({
            templateName: tpl.templateName,
            language: tpl.language,
            category: tpl.category,
            status: tpl.status,
            components: tpl.components,
            rejectionReason: tpl.rejectionReason,
            updatedAt: new Date(),
          })
          .where(eq(schema.whatsappApiTemplates.id, existing[0].id));
      } else {
        await db.insert(schema.whatsappApiTemplates).values({
          userId,
          accountId: account.id,
          templateName: tpl.templateName,
          language: tpl.language,
          category: tpl.category,
          status: tpl.status,
          components: tpl.components,
          metaTemplateId: tpl.metaTemplateId,
          rejectionReason: tpl.rejectionReason,
        });
      }
    }

    req.flash("success", `Synced ${metaTemplates.length} templates from Meta`);
    res.redirect("/meta-whatsapp/templates");
  } catch (error) {
    console.error("[MetaWhatsApp] Sync templates error:", error.message);
    req.flash("error", "Failed to sync templates: " + error.message);
    res.redirect("/meta-whatsapp/templates");
  }
});

// ============================================
// CREATE TEMPLATE ON META
// ============================================
router.post("/templates/create", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountId, templateName, category, language, componentsJson } = req.body;

    if (!accountId || !templateName || !category || !language || !componentsJson) {
      req.flash("error", "All fields are required");
      return res.redirect("/meta-whatsapp/templates");
    }

    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.id, parseInt(accountId)));

    if (!accounts.length || accounts[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/meta-whatsapp/templates");
    }

    // Check credits
    const creditCheck = await checkCredits(userId, "whatsapp_api_template");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/meta-whatsapp/templates");
    }

    const account = accounts[0];
    const accessToken = decrypt(account.accessToken);
    let components;
    try {
      components = JSON.parse(componentsJson);
    } catch {
      req.flash("error", "Invalid JSON in components field");
      return res.redirect("/meta-whatsapp/templates");
    }

    const result = await createTemplate(account.wabaId, accessToken, templateName, category, language, components);

    await chargeCredits(req, "whatsapp_api_template", 1, `Submitted template: ${templateName}`);

    // Save to DB
    await db.insert(schema.whatsappApiTemplates).values({
      userId,
      accountId: account.id,
      templateName,
      language,
      category,
      status: result.status,
      components: JSON.stringify(components),
      metaTemplateId: result.metaTemplateId,
    });

    req.flash("success", `Template "${templateName}" submitted to Meta for approval! Status: ${result.status} (${creditCheck.cost} credits used)`);
    res.redirect("/meta-whatsapp/templates");
  } catch (error) {
    console.error("[MetaWhatsApp] Create template error:", error.message);
    req.flash("error", "Failed to create template: " + error.message);
    res.redirect("/meta-whatsapp/templates");
  }
});

// ============================================
// DELETE TEMPLATE
// ============================================
router.post("/templates/delete/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const templateId = parseInt(req.params.id);

    const templates = await db.select().from(schema.whatsappApiTemplates)
      .where(eq(schema.whatsappApiTemplates.id, templateId));

    if (!templates.length || templates[0].userId !== userId) {
      req.flash("error", "Template not found");
      return res.redirect("/meta-whatsapp/templates");
    }

    const tpl = templates[0];

    // Delete from Meta if we have the metaTemplateId
    if (tpl.metaTemplateId && tpl.accountId) {
      try {
        const accounts = await db.select().from(schema.metaWhatsappAccounts)
          .where(eq(schema.metaWhatsappAccounts.id, tpl.accountId));
        if (accounts.length) {
          const accessToken = decrypt(accounts[0].accessToken);
          await deleteTemplate(accounts[0].wabaId, accessToken, tpl.templateName);
        }
      } catch (err) {
        console.warn("[MetaWhatsApp] Failed to delete template from Meta:", err.message);
      }
    }

    await db.delete(schema.whatsappApiTemplates)
      .where(eq(schema.whatsappApiTemplates.id, templateId));

    req.flash("success", "Template deleted");
    res.redirect("/meta-whatsapp/templates");
  } catch (error) {
    console.error("[MetaWhatsApp] Delete template error:", error.message);
    req.flash("error", "Failed to delete template");
    res.redirect("/meta-whatsapp/templates");
  }
});

// ============================================
// MESSAGE HISTORY
// ============================================
router.get("/messages", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const messages = await db.select().from(schema.whatsappApiMessages)
      .where(eq(schema.whatsappApiMessages.userId, userId))
      .orderBy(desc(schema.whatsappApiMessages.createdAt))
      .limit(200);

    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.userId, userId));

    res.render("pages/metaWhatsapp/messages", {
      title: "WhatsApp API Messages - ParroByte CRM",
      messages,
      accounts,
    });
  } catch (error) {
    console.error("[MetaWhatsApp] Messages error:", error.message);
    req.flash("error", "Failed to load messages");
    res.redirect("/meta-whatsapp");
  }
});

// ============================================
// WEBHOOK VERIFICATION (GET) — Meta subscription verification
// ============================================
router.get("/webhook", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && challenge) {
    // Find account with this verify token
    const accounts = await db.select().from(schema.metaWhatsappAccounts)
      .where(eq(schema.metaWhatsappAccounts.webhookVerifyToken, token));

    if (accounts.length) {
      console.log(`[MetaWhatsApp Webhook] Verified for account ${accounts[0].id}`);
      return res.status(200).send(challenge);
    }
  }

  res.sendStatus(403);
});

// ============================================
// WEBHOOK RECEIVER (POST) — incoming messages & status updates
// ============================================
router.post("/webhook", async (req, res) => {
  // Acknowledge immediately (Meta requires 200 within 20s)
  res.status(200).send("EVENT_RECEIVED");

  try {
    const signature = req.headers["x-hub-signature-256"] || "";
    const body = JSON.stringify(req.body);

    // We need to verify against each account's app secret.
    // First, find the matching account by phone_number_id in the payload.
    const events = parseIncomingWebhook(req.body);
    if (!events.length) return;

    // Get unique phone_number_ids from events
    const phoneNumberIds = [...new Set(events.map(e => e.phoneNumberId).filter(Boolean))];

    for (const pnid of phoneNumberIds) {
      const accounts = await db.select().from(schema.metaWhatsappAccounts)
        .where(eq(schema.metaWhatsappAccounts.phoneNumberId, pnid));

      if (!accounts.length) continue;
      const account = accounts[0];

      // Verify signature using this account's app secret
      if (account.appSecret) {
        const appSecret = decrypt(account.appSecret);
        if (!verifyWebhookSignature(body, signature, appSecret)) {
          console.warn(`[MetaWhatsApp Webhook] Signature verification failed for account ${account.id}`);
          continue;
        }
      }

      for (const event of events.filter(e => e.phoneNumberId === pnid)) {
        if (event.type === "message") {
          // Save incoming message
          await db.insert(schema.whatsappApiMessages).values({
            userId: account.userId,
            accountId: account.id,
            phone: event.phone,
            direction: "inbound",
            type: event.messageType || "text",
            content: event.content || event.caption || "",
            mediaUrl: event.mediaId || null,
            status: "delivered",
            metaMessageId: event.messageId,
          });

          console.log(`[MetaWhatsApp Webhook] Inbound message from ${event.phone}: ${event.content?.substring(0, 50)}`);
        } else if (event.type === "status") {
          // Update message status
          await db.update(schema.whatsappApiMessages)
            .set({
              status: event.status,
              conversationId: event.conversationId || null,
              conversationCategory: event.conversationCategory || null,
              errorMessage: event.errorMessage || null,
            })
            .where(eq(schema.whatsappApiMessages.metaMessageId, event.messageId));

          console.log(`[MetaWhatsApp Webhook] Status update for ${event.messageId}: ${event.status}`);
        }
      }
    }
  } catch (err) {
    console.error("[MetaWhatsApp Webhook] Error:", err.message);
  }
});

export default router;
