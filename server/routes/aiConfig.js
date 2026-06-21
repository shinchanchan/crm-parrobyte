import express from "express";
import { db } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { getAiConfig, getAiConfigWithFallback, saveAiConfig, saveUserAiConfig, checkOllamaHealth, generateAiResponse } from "../lib/aiService.js";

const router = express.Router();

// GET - AI Config page
// Admin sees: Ollama URL, Model, Temperature, Max Tokens, Enable, Universal mode, Prompt, Business data
// User sees:  Temperature, Max Tokens, Enable, Universal mode, Prompt, Business data (NO Ollama URL, NO Model)
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Get admin's config (for Ollama URL + model display)
    let adminConfig = null;
    try {
      const rows = await db.select().from(schema.aiConfigs).orderBy(desc(schema.aiConfigs.createdAt));
      for (const row of rows) {
        if (row.ollamaUrl) { adminConfig = row; break; }
      }
    } catch (e) {}

    // Get user's merged config (with fallback to admin's Ollama settings)
    const config = await getAiConfigWithFallback(userId);

    // Only admin checks Ollama health
    let health = { ok: false, error: "Admin only" };
    if (isAdmin && config.ollamaUrl) {
      health = await checkOllamaHealth(config.ollamaUrl);
    }

    // Only admin sees queue stats
    let queueStats = { total: 0, queued: 0, processing: 0, sent: 0, failed: 0 };
    if (isAdmin) {
      try {
        const queueItems = await db.select().from(schema.aiMessageQueue)
          .where(eq(schema.aiMessageQueue.userId, userId));
        queueStats = {
          total: queueItems.length,
          queued: queueItems.filter(function(q) { return q.status === "queued"; }).length,
          processing: queueItems.filter(function(q) { return q.status === "processing"; }).length,
          sent: queueItems.filter(function(q) { return q.status === "sent"; }).length,
          failed: queueItems.filter(function(q) { return q.status === "failed"; }).length,
        };
      } catch (queueErr) {
        if (queueErr.message && queueErr.message.includes('does not exist')) {
          console.log('[AI] ai_message_queue table not found. Run: npx drizzle-kit push');
        }
      }
    }

    res.render("pages/aiConfig/index", {
      title: isAdmin ? "AI Admin Configuration" : "AI Assistant",
      config,
      adminConfig,
      isAdmin,
      health,
      queueStats,
    });
  } catch (error) {
    console.error("AI config page error:", error);
    req.flash("error", "Failed to load AI configuration");
    res.redirect("/dashboard");
  }
});

// POST - Admin saves full config (Ollama + prompt + business)
router.post("/save", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    if (isAdmin) {
      // Admin saves FULL config including Ollama URL + model
      const { ollamaUrl, model, systemPrompt, businessData, temperature, maxTokens, isActive, universalAiReply, language } = req.body;
      await saveAiConfig(userId, {
        ollamaUrl: ollamaUrl || "http://localhost:11434",
        model: model || "translategemma:4b",
        systemPrompt: systemPrompt || "You are a helpful business assistant.",
        businessData: businessData || "",
        temperature: temperature || "0.7",
        maxTokens: parseInt(maxTokens) || 500,
        isActive: isActive === "on" || isActive === true,
        universalAiReply: universalAiReply === "on" || universalAiReply === true,
        language: language || "en",
      });
      req.flash("success", "AI configuration saved successfully");
    } else {
      // User saves ONLY prompt + business + enable + mode (Ollama inherited from admin)
      const { systemPrompt, businessData, temperature, maxTokens, isActive, universalAiReply, language } = req.body;
      await saveUserAiConfig(userId, {
        systemPrompt: systemPrompt || "",
        businessData: businessData || "",
        temperature: temperature || "0.7",
        maxTokens: maxTokens || 500,
        isActive: isActive === "on" || isActive === true,
        universalAiReply: universalAiReply === "on" || universalAiReply === true,
        language: language || "en",
      });
      req.flash("success", "AI settings saved successfully");
    }

    res.redirect("/ai-config");
  } catch (error) {
    console.error("Save AI config error:", error);
    req.flash("error", "Failed to save AI settings");
    res.redirect("/ai-config");
  }
});

// POST - Admin tests Ollama connection
router.post("/test", async (req, res) => {
  try {
    if (req.session.user.role !== "admin") {
      return res.status(403).json({ success: false, error: "Admin only" });
    }
    const { ollamaUrl, model } = req.body;
    const health = await checkOllamaHealth(ollamaUrl);

    if (!health.ok) {
      return res.json({ success: false, error: "Cannot connect to Ollama: " + health.error });
    }
    if (!health.models.includes(model)) {
      return res.json({
        success: false,
        error: 'Model "' + model + '" not found. Available: ' + health.models.join(", "),
        models: health.models,
      });
    }

    const testResult = await generateAiResponse(req.session.user.id, "Hello, this is a test message.");
    if (testResult.success) {
      return res.json({
        success: true,
        message: 'Model "' + model + '" responded in ' + testResult.elapsedMs + "ms",
        preview: testResult.response.substring(0, 200),
        models: health.models,
      });
    }
    return res.json({ success: false, error: testResult.error, models: health.models });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// POST - User/Admin test AI chat
router.post("/chat", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.json({ success: false, error: "Message is required" });
    }

    const config = await getAiConfigWithFallback(userId);
    if (!config.isActive) {
      return res.json({ success: false, error: "AI is not enabled. Please activate AI in settings." });
    }

    const result = await generateAiResponse(userId, message.trim());
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// GET - Queue status (admin only)
router.get("/queue", async (req, res) => {
  try {
    if (req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
    const userId = req.session.user.id;
    const items = await db.select().from(schema.aiMessageQueue)
      .where(eq(schema.aiMessageQueue.userId, userId))
      .orderBy(schema.aiMessageQueue.createdAt);
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Retry failed queue items (admin only)
router.post("/queue/retry", async (req, res) => {
  try {
    if (req.session.user.role !== "admin") {
      req.flash("error", "Admin only");
      return res.redirect("/ai-config");
    }
    const userId = req.session.user.id;
    await db.update(schema.aiMessageQueue)
      .set({ status: "queued", retryCount: 0 })
      .where(eq(schema.aiMessageQueue.userId, userId));
    req.flash("success", "Failed items queued for retry");
    res.redirect("/ai-config");
  } catch (error) {
    req.flash("error", "Failed to retry");
    res.redirect("/ai-config");
  }
});

export default router;
