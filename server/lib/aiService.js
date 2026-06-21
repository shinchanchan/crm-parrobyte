import { db } from "./db.js";
import { eq, desc, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { Ollama } from "ollama";

/**
 * Ollama AI Service using npm 'ollama' package
 * Admin sets Ollama URL + model globally
 * Users set their own prompt + business data
 */

/**
 * Get AI config for a specific user
 */
export async function getAiConfig(userId) {
  try {
    const rows = await db.select().from(schema.aiConfigs)
      .where(eq(schema.aiConfigs.userId, userId));
    return rows.length ? rows[0] : null;
  } catch (err) {
    console.error("[AI] getAiConfig error:", err.message);
    return null;
  }
}

/**
 * Get ADMIN's Ollama config (URL + model) as global fallback
 */
export async function getAdminOllamaConfig() {
  try {
    // Find admin users first, then their AI configs
    const adminUsers = await db.select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.role, "admin"));

    if (!adminUsers.length) return null;

    const adminIds = adminUsers.map(u => u.id);

    // Get AI configs for admin users, newest first
    const rows = await db.select()
      .from(schema.aiConfigs)
      .where(eq(schema.aiConfigs.userId, adminIds[0]))
      .orderBy(desc(schema.aiConfigs.createdAt));

    // Find the first config that has ollamaUrl set
    for (const row of rows) {
      if (row.ollamaUrl) return row;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Get merged AI config for a user:
 * - User's prompt + business data + enable status + universal mode
 * - Falls back to admin's Ollama URL + model if user hasn't set them
 */
export async function getAiConfigWithFallback(userId) {
  const userConfig = await getAiConfig(userId);
  const adminConfig = await getAdminOllamaConfig();

  // Build merged config
  const merged = {
    ollamaUrl: "http://localhost:11434",
    model: "translategemma:4b",
    systemPrompt: "You are a helpful business assistant. Respond professionally and concisely to customer inquiries.",
    businessData: "",
    temperature: "0.7",
    maxTokens: 500,
    isActive: false,
    universalAiReply: false,
    language: "en",
  };

  // Apply admin's Ollama settings first (global defaults)
  if (adminConfig) {
    if (adminConfig.ollamaUrl) merged.ollamaUrl = adminConfig.ollamaUrl;
    if (adminConfig.model) merged.model = adminConfig.model;
    if (adminConfig.temperature) merged.temperature = adminConfig.temperature;
    if (adminConfig.maxTokens) merged.maxTokens = adminConfig.maxTokens;
  }

  // Apply user's settings (overrides)
  if (userConfig) {
    if (userConfig.systemPrompt) merged.systemPrompt = userConfig.systemPrompt;
    if (userConfig.businessData) merged.businessData = userConfig.businessData;
    if (userConfig.temperature) merged.temperature = userConfig.temperature;
    if (userConfig.maxTokens) merged.maxTokens = userConfig.maxTokens;
    merged.isActive = userConfig.isActive;
    merged.universalAiReply = userConfig.universalAiReply;
    if (userConfig.language) merged.language = userConfig.language;
    // User can override Ollama URL/model too (for advanced users)
    if (userConfig.ollamaUrl) merged.ollamaUrl = userConfig.ollamaUrl;
    if (userConfig.model) merged.model = userConfig.model;
  }

  return merged;
}

/**
 * Create an Ollama client
 */
function getOllamaClient(host) {
  const url = (host || "http://localhost:11434").replace(/\/$/, "");
  return new Ollama({ host: url });
}

/**
 * Generate AI response with fallback config
 */
export async function generateAiResponse(userId, incomingMessage) {
  const startTime = Date.now();

  try {
    const config = await getAiConfigWithFallback(userId);
    if (!config.isActive) {
      return { success: false, error: "AI not enabled. Please activate AI in settings." };
    }

    const ollama = getOllamaClient(config.ollamaUrl);
    const model = config.model || "translategemma:4b";
    const systemPrompt = config.systemPrompt || "You are a helpful business assistant.";
    const businessData = config.businessData || "";
    const maxTokens = config.maxTokens || 500;

    let fullSystemPrompt = businessData
      ? `${systemPrompt}\n\nBusiness Information:\n${businessData}`
      : systemPrompt;

    const lang = config.language || "en";
    if (lang !== "en") {
      const langNames = {
        ta: "Tamil", te: "Telugu", hi: "Hindi", ml: "Malayalam", kn: "Kannada",
      };
      const langName = langNames[lang] || lang;
      fullSystemPrompt += `\n\nIMPORTANT: Respond ONLY in ${langName} language. Do not use English unless the user explicitly asks in English.`;
    }

    const response = await ollama.chat({
      model,
      messages: [
        { role: "system", content: fullSystemPrompt },
        { role: "user", content: incomingMessage },
      ],
      options: {
        num_predict: maxTokens,
        num_ctx: 2048,
        num_thread: 2,
        num_gpu: 0,
      },
    });

    const aiText = response.message?.content || "";
    if (!aiText.trim()) {
      return { success: false, error: "AI returned empty response" };
    }

    const elapsed = Date.now() - startTime;
    console.log(`[AI] Response in ${elapsed}ms (user=${userId}, model=${model})`);

    return {
      success: true,
      response: aiText.trim(),
      model,
      elapsedMs: elapsed,
    };
  } catch (error) {
    console.error("[AI] generateAiResponse error:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Test AI chat - direct response
 */
export async function testAiChat(userId, message) {
  return generateAiResponse(userId, message);
}

/**
 * Check if Ollama is reachable
 */
export async function checkOllamaHealth(url) {
  try {
    const ollama = getOllamaClient(url);
    const list = await ollama.list();
    const models = list.models?.map(function(m) { return m.name; }) || [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Save admin Ollama config (full settings)
 */
export async function saveAiConfig(userId, configData) {
  try {
    const existing = await db.select().from(schema.aiConfigs)
      .where(eq(schema.aiConfigs.userId, userId));

    if (existing.length) {
      await db.update(schema.aiConfigs)
        .set({ ...configData, updatedAt: new Date() })
        .where(eq(schema.aiConfigs.id, existing[0].id));
      return { success: true, id: existing[0].id };
    } else {
      const result = await db.insert(schema.aiConfigs).values({
        userId,
        language: "en",
        ...configData,
      }).returning();
      return { success: true, id: result[0].id };
    }
  } catch (err) {
    console.error("[AI] saveAiConfig error:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Save user prompt + business config only (does not touch Ollama settings)
 */
export async function saveUserAiConfig(userId, { systemPrompt, businessData, temperature, maxTokens, isActive, universalAiReply, language }) {
  try {
    const existing = await db.select().from(schema.aiConfigs)
      .where(eq(schema.aiConfigs.userId, userId));

    const data = {
      systemPrompt: systemPrompt || "",
      businessData: businessData || "",
      temperature: temperature || "0.7",
      maxTokens: maxTokens ? parseInt(maxTokens) : 500,
      isActive: isActive === true || isActive === "on",
      universalAiReply: universalAiReply === true || universalAiReply === "on",
      language: language || "en",
    };

    if (existing.length) {
      await db.update(schema.aiConfigs)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.aiConfigs.id, existing[0].id));
      return { success: true, id: existing[0].id };
    } else {
      const result = await db.insert(schema.aiConfigs).values({
        userId,
        ollamaUrl: null, // Will use admin's fallback
        model: null,     // Will use admin's fallback
        ...data,
      }).returning();
      return { success: true, id: result[0].id };
    }
  } catch (err) {
    console.error("[AI] saveUserAiConfig error:", err.message);
    return { success: false, error: err.message };
  }
}
