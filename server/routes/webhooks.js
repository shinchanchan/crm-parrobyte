import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { triggerWebhook, getWebhookLogs } from "../lib/webhookTrigger.js";

const router = express.Router();

// GET /webhooks - List user's webhooks with logs
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const hooks = await db.select().from(schema.webhooks)
      .where(eq(schema.webhooks.userId, userId));

    // Get user's sessions for the dropdown
    const sessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.userId, userId));

    // Get recent logs for each webhook
    const hooksWithLogs = await Promise.all(hooks.map(async (hook) => {
      const logs = await getWebhookLogs(hook.id, 10);
      let events = [];
      try { events = JSON.parse(hook.events || "[]"); } catch (e) {}
      return { ...hook, events, logs };
    }));

    res.render("pages/webhooks/index", {
      title: "Webhooks - ParroByte CRM",
      webhooks: hooksWithLogs,
      sessions,
    });
  } catch (error) {
    console.error("Webhooks list error:", error);
    req.flash("error", "Failed to load webhooks");
    res.redirect("/dashboard");
  }
});

// POST /webhooks/create - Create webhook
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, url, events, secret, sessionId } = req.body;

    const eventsArray = Array.isArray(events) ? events : (events ? [events] : []);

    await db.insert(schema.webhooks).values({
      userId,
      name: name.trim(),
      url: url.trim(),
      events: JSON.stringify(eventsArray),
      secret: secret ? secret.trim() : null,
      sessionId: sessionId ? parseInt(sessionId) : null,
    });

    req.flash("success", "Webhook created successfully");
    res.redirect("/webhooks");
  } catch (error) {
    console.error("Webhook create error:", error);
    req.flash("error", "Failed to create webhook");
    res.redirect("/webhooks");
  }
});

// POST /webhooks/update/:id - Update webhook
router.post("/update/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    const { name, url, events, secret, isActive, sessionId } = req.body;

    // Verify ownership
    const existing = await db.select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.userId, userId)));
    if (!existing.length) {
      req.flash("error", "Webhook not found");
      return res.redirect("/webhooks");
    }

    const eventsArray = Array.isArray(events) ? events : (events ? [events] : []);

    await db.update(schema.webhooks)
      .set({
        name: name.trim(),
        url: url.trim(),
        events: JSON.stringify(eventsArray),
        secret: secret ? secret.trim() : null,
        isActive: isActive === "on" || isActive === true || isActive === "true",
        sessionId: sessionId ? parseInt(sessionId) : null,
      })
      .where(eq(schema.webhooks.id, id));

    req.flash("success", "Webhook updated");
    res.redirect("/webhooks");
  } catch (error) {
    console.error("Webhook update error:", error);
    req.flash("error", "Failed to update webhook");
    res.redirect("/webhooks");
  }
});

// POST /webhooks/delete/:id - Delete webhook
router.post("/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;

    await db.delete(schema.webhooks)
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.userId, userId)));

    req.flash("success", "Webhook deleted");
    res.redirect("/webhooks");
  } catch (error) {
    console.error("Webhook delete error:", error);
    req.flash("error", "Failed to delete webhook");
    res.redirect("/webhooks");
  }
});

// POST /webhooks/test/:id - Test webhook with a ping event
router.post("/test/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;

    const hooks = await db.select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.userId, userId)));

    if (!hooks.length) {
      return res.status(404).json({ success: false, error: "Webhook not found" });
    }

    triggerWebhook(userId, "ping", {
      sessionId: hooks[0].sessionId || null,
      message: "This is a test ping from ParroByte CRM",
      webhookName: hooks[0].name,
    });

    res.json({ success: true, message: "Test event sent. Check delivery logs below." });
  } catch (error) {
    console.error("Webhook test error:", error);
    res.status(500).json({ success: false, error: "Failed to send test" });
  }
});

// GET /webhooks/logs/:id - Get logs for a webhook (JSON API)
router.get("/logs/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;

    const hooks = await db.select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.userId, userId)));

    if (!hooks.length) {
      return res.status(404).json({ success: false, error: "Webhook not found" });
    }

    const logs = await getWebhookLogs(id, 50);
    res.json({ success: true, logs });
  } catch (error) {
    console.error("Webhook logs error:", error);
    res.status(500).json({ success: false, error: "Failed to load logs" });
  }
});

export default router;
