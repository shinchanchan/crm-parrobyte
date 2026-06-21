#!/usr/bin/env node
/**
 * AI Worker — BullMQ Worker Process
 * Handles AI reply generation via Ollama
 * Low concurrency since AI inference is CPU intensive
 */
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "../server/lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { getAiConfigWithFallback } from "../server/lib/aiService.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

let Ollama = null;
async function getOllama() {
  if (!Ollama) {
    const mod = await import("ollama");
    Ollama = mod.default;
  }
  return Ollama;
}

async function processAiReply(job) {
  const { userId, sessionId, phone, incomingMessage, ruleId, aiPrompt } = job.data;
  console.log(`[AIWorker] Generating reply for ${phone}: "${incomingMessage?.substring(0, 50)}"`);

  try {
    const aiCfg = await getAiConfigWithFallback(userId);
    if (!aiCfg.model) {
      throw new Error("No AI model configured");
    }

    const Ollama = await getOllama();
    const systemPrompt = aiCfg.systemPrompt || "You are a helpful business assistant.";
    const prompt = aiPrompt
      ? `${aiPrompt}\n\nCustomer message: ${incomingMessage}`
      : `Respond professionally to this customer message: "${incomingMessage}"`;

    const resp = await Ollama.chat({
      model: aiCfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      stream: false,
      options: {
        temperature: parseFloat(aiCfg.temperature || 0.7),
        num_predict: parseInt(aiCfg.maxTokens || 500),
      },
    });

    const replyContent = resp.message?.content || "Sorry, I couldn't generate a response.";

    // Send via WhatsApp
    const { WhatsAppManager } = await import("../whatsapp/manager.js");
    const wa = new WhatsAppManager();
    await wa.initialize();
    await wa.sendMessage(sessionId, phone, replyContent, "text");

    // Log AI message
    await db.insert(schema.aiMessageQueue).values({
      userId,
      sessionId,
      phone,
      incomingMessage,
      aiResponse: replyContent,
      status: "sent",
      processedAt: new Date(),
    });

    // Update rule usage
    if (ruleId) {
      const rules = await db.select().from(schema.autoReplies).where(eq(schema.autoReplies.id, ruleId));
      if (rules.length) {
        await db.update(schema.autoReplies)
          .set({ usageCount: (rules[0].usageCount || 0) + 1 })
          .where(eq(schema.autoReplies.id, ruleId));
      }
    }

    console.log(`[AIWorker] Reply sent to ${phone}`);
  } catch (error) {
    console.error(`[AIWorker] Failed for ${phone}:`, error.message);
    await db.insert(schema.aiMessageQueue).values({
      userId,
      sessionId,
      phone,
      incomingMessage,
      status: "failed",
      processedAt: new Date(),
    });
    throw error;
  }
}

const aiWorker = new Worker("ai-reply", processAiReply, {
  connection,
  concurrency: 2, // Ollama can handle 2 concurrent requests on 12 cores
  limiter: { max: 2, duration: 1000 },
});

aiWorker.on("completed", job => console.log(`[AIWorker] Job ${job.id} completed`));
aiWorker.on("failed", (job, err) => console.error(`[AIWorker] Job ${job?.id} failed:`, err.message));

console.log("[AIWorker] Started. Concurrency=2.");

process.on("SIGTERM", async () => {
  await aiWorker.close();
  await connection.quit();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await aiWorker.close();
  await connection.quit();
  process.exit(0);
});
