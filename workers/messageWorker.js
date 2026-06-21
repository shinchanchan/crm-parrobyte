#!/usr/bin/env node
/**
 * Message Worker — BullMQ Worker Process
 * Handles: bulk WhatsApp sends, scheduled messages, incoming message auto-replies
 * Runs as separate process via PM2 to not block the web server
 */
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "../server/lib/db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { checkCredits, deductCredits } from "../server/lib/credits.js";
import { getAiConfigWithFallback } from "../server/lib/aiService.js";
import { triggerWebhook } from "../server/lib/webhookTrigger.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

// Lazy-load waManager to avoid circular deps
let waManager = null;
async function getWaManager() {
  if (!waManager) {
    const WhatsAppManager = (await import("../whatsapp/manager.js")).default;
    waManager = new WhatsAppManager();
  }
  return waManager;
}

// System resource check
import os from "os";

function getFreeMemPercent() {
  return (os.freemem() / os.totalmem()) * 100;
}

async function checkSystemHealth() {
  const freePercent = (os.freemem() / os.totalmem()) * 100;
  if (freePercent < 8) {
    console.error(`[MessageWorker] CRITICAL: Only ${freePercent.toFixed(1)}% RAM free. Pausing processing.`);
    return false;
  }
  if (freePercent < 15) {
    console.warn(`[MessageWorker] LOW MEMORY: ${freePercent.toFixed(1)}% free. Throttling...`);
  }
  return true;
}

// ── BULK MESSAGE JOB ──
async function processBulkMessage(job) {
  const { userId, jobId, sessionId, contacts, content, type, mediaUrl, interactiveData, gapSeconds = 45 } = job.data;
  console.log(`[BulkWorker] Starting job ${jobId}, contacts=${contacts.length}, session=${sessionId}`);

  const wa = await getWaManager();
  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    try {
      // Health check every 10 messages
      if (i % 10 === 0 && !(await checkSystemHealth())) {
        await new Promise(r => setTimeout(r, 5000));
      }

      const creditCheck = await checkCredits(userId, type === "poll" ? "poll_message" : "send_message");
      if (!creditCheck.allowed) {
        console.warn(`[BulkWorker] Job ${jobId} stopped: insufficient credits`);
        break;
      }

      let personalizedContent = content;
      if (contact.name) personalizedContent = personalizedContent.replace(/\{\{name\}\}/gi, contact.name);
      if (contact.email) personalizedContent = personalizedContent.replace(/\{\{email\}\}/gi, contact.email);
      if (contact.phone) personalizedContent = personalizedContent.replace(/\{\{phone\}\}/gi, contact.phone);

      await wa.sendMessage(sessionId, contact.phone, personalizedContent, type, mediaUrl, interactiveData);
      await deductCredits(userId, type === "poll" ? "poll_message" : "send_message", 1, `Bulk job ${jobId}`);
      sentCount++;

      // Progress report
      if (i % 5 === 0) {
        await db.update(schema.bulkMessageJobs)
          .set({ sentCount, failedCount })
          .where(eq(schema.bulkMessageJobs.id, jobId));
        await job.updateProgress(Math.round((i / contacts.length) * 100));
      }

      // Rate limit gap
      if (i < contacts.length - 1) {
        await new Promise(r => setTimeout(r, gapSeconds * 1000));
      }
    } catch (err) {
      console.error(`[BulkWorker] Job ${jobId} contact ${contact.phone} failed:`, err.message);
      failedCount++;
    }
  }

  await db.update(schema.bulkMessageJobs)
    .set({ status: "completed", sentCount, failedCount, completedAt: new Date() })
    .where(eq(schema.bulkMessageJobs.id, jobId));

  console.log(`[BulkWorker] Job ${jobId} completed: ${sentCount} sent, ${failedCount} failed`);
}

// ── SCHEDULED MESSAGE JOB ──
async function processScheduledMessage(job) {
  const { scheduleId, userId, sessionId, contacts, content, type, mediaUrl } = job.data;
  console.log(`[ScheduledWorker] Running schedule ${scheduleId}, contacts=${contacts.length}`);

  const wa = await getWaManager();
  let sent = 0;
  let failed = 0;

  for (const contact of contacts) {
    try {
      const creditCheck = await checkCredits(userId, type === "poll" ? "poll_message" : "send_message");
      if (!creditCheck.allowed) break;

      let msg = content;
      if (contact.name) msg = msg.replace(/\{\{name\}\}/gi, contact.name);
      if (contact.email) msg = msg.replace(/\{\{email\}\}/gi, contact.email);
      if (contact.phone) msg = msg.replace(/\{\{phone\}\}/gi, contact.phone);
      if (contact.group) msg = msg.replace(/\{\{group\}\}/gi, contact.group);
      if (contact.tags) msg = msg.replace(/\{\{tags\}\}/gi, contact.tags);
      if (contact.notes) msg = msg.replace(/\{\{notes\}\}/gi, contact.notes);

      await wa.sendMessage(sessionId, contact.phone, msg, type, mediaUrl);
      await deductCredits(userId, type === "poll" ? "poll_message" : "send_message", 1, `Scheduled msg`);
      sent++;
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      failed++;
      console.error(`[ScheduledWorker] Contact ${contact.phone} failed:`, e.message);
    }
  }

  await db.update(schema.scheduledMessages)
    .set({ status: "completed", completedAt: new Date(), sentCount: sent, failedCount: failed })
    .where(eq(schema.scheduledMessages.id, scheduleId));
}

// ── INCOMING MESSAGE JOB ──
async function processIncomingMessage(job) {
  const { sessionId, userId, phone, body, msg } = job.data;
  console.log(`[IncomingWorker] Processing from ${phone}: "${body?.substring(0, 50)}"`);

  try {
    // Auto-reply rules
    const rules = await db.select().from(schema.autoReplies)
      .where(and(eq(schema.autoReplies.userId, userId), eq(schema.autoReplies.isActive, true)))
      .orderBy(schema.autoReplies.priority);

    for (const rule of rules) {
      let matched = false;
      const trigger = rule.triggerValue.toLowerCase();
      const text = (body || "").toLowerCase();

      switch (rule.triggerType) {
        case "exact": matched = text === trigger; break;
        case "starts_with": matched = text.startsWith(trigger); break;
        case "ends_with": matched = text.endsWith(trigger); break;
        case "regex": try { matched = new RegExp(trigger, "i").test(text); } catch(e){} break;
        default: matched = text.includes(trigger);
      }

      if (matched) {
        const wa = await getWaManager();
        let replyContent = rule.responseContent;

        if (rule.responseType === "ai") {
          const aiCfg = await getAiConfigWithFallback(userId);
          const Ollama = (await import("ollama")).default;
          const resp = await Ollama.chat({
            model: aiCfg.model,
            messages: [
              { role: "system", content: aiCfg.systemPrompt },
              { role: "user", content: `${rule.aiPrompt || "Respond to:"} ${body}` },
            ],
            stream: false,
          });
          replyContent = resp.message?.content || rule.responseContent;
        }

        await wa.sendMessage(sessionId, phone, replyContent, "text");
        await db.update(schema.autoReplies).set({ usageCount: (rule.usageCount || 0) + 1 }).where(eq(schema.autoReplies.id, rule.id));
        break; // Only first matching rule
      }
    }

    // Webhooks
    const webhooks = await db.select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.userId, userId), eq(schema.webhooks.isActive, true)));
    for (const wh of webhooks) {
      if (wh.events?.includes("message.received")) {
        triggerWebhook(wh, "message.received", { phone, body, timestamp: new Date().toISOString() }).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[IncomingWorker] Error:", e.message);
  }
}

// ── CREATE WORKER INSTANCES ──
const bulkWorker = new Worker("bulk-message", processBulkMessage, {
  connection,
  concurrency: 1, // One bulk job at a time per worker
  limiter: { max: 1, duration: 1000 },
});

const scheduledWorker = new Worker("scheduled-message", processScheduledMessage, {
  connection,
  concurrency: 2,
  limiter: { max: 2, duration: 1000 },
});

const incomingWorker = new Worker("incoming-message", processIncomingMessage, {
  connection,
  concurrency: 5, // Handle multiple incoming messages concurrently
  limiter: { max: 10, duration: 1000 },
});

[bulkWorker, scheduledWorker, incomingWorker].forEach(w => {
  w.on("completed", job => console.log(`[Worker] ${job.queueName} job ${job.id} completed`));
  w.on("failed", (job, err) => console.error(`[Worker] ${job?.queueName} job ${job?.id} failed:`, err.message));
});

console.log("[MessageWorker] Started. Waiting for jobs...");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[MessageWorker] SIGTERM received, closing...");
  await bulkWorker.close();
  await scheduledWorker.close();
  await incomingWorker.close();
  await connection.quit();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[MessageWorker] SIGINT received, closing...");
  await bulkWorker.close();
  await scheduledWorker.close();
  await incomingWorker.close();
  await connection.quit();
  process.exit(0);
});
