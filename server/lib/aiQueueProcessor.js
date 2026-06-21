import { db } from "./db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { generateAiResponse } from "./aiService.js";
import { deductCredits } from "./credits.js";

/**
 * AI Queue Processor - Background worker for Ollama AI auto-replies
 * Optimized for low-resource systems (8GB RAM, 50GB disk)
 *
 * Design:
 * - Per-user sequential processing (one message per user at a time)
 * - 30-second gap between each user's messages to prevent CPU/RAM overload and WhatsApp rate limits
 * - Multiple users can be processed concurrently
 * - Uses setInterval (not node-cron) to avoid blocking IO warnings
 * - 3 retry attempts with exponential backoff
 * - All DB operations are async/non-blocking
 */

const GAP_MS = 30000; // 30 seconds between each AI response per user
const POLL_INTERVAL_MS = 10000; // 10 seconds between queue checks
const MAX_RETRIES = 3;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Per-user tracking (allows concurrent processing across different users)
const processingUsers = new Set(); // userIds currently being processed
const lastProcessedTime = new Map(); // userId -> timestamp
let timerId = null;
let cleanupTimerId = null;

function cleanupOldEntries() {
  const cutoff = Date.now() - CLEANUP_INTERVAL_MS;
  let cleaned = 0;
  for (const [userId, time] of lastProcessedTime.entries()) {
    if (time < cutoff && !processingUsers.has(userId)) {
      lastProcessedTime.delete(userId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[AI Processor] Cleaned up ${cleaned} stale user entries`);
  }
}

/**
 * Start the background AI queue processor
 */
export function startAiQueueProcessor(waManager) {
  console.log(`[AI Processor] Starting with ${GAP_MS/1000}s gap per user...`);

  // Use setInterval to check queue every 10 seconds
  timerId = setInterval(function() {
    processQueue(waManager).catch(function(err) {
      console.error("[AI Processor] Interval error:", err.message);
    });
  }, POLL_INTERVAL_MS);

  // Cleanup stale entries every hour to prevent memory leak
  cleanupTimerId = setInterval(cleanupOldEntries, CLEANUP_INTERVAL_MS);

  console.log(`[AI Processor] Running - checks queue every ${POLL_INTERVAL_MS/1000}s, ${GAP_MS/1000}s gap per user`);
}

/**
 * Stop the processor
 */
export function stopAiQueueProcessor() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  if (cleanupTimerId) {
    clearInterval(cleanupTimerId);
    cleanupTimerId = null;
  }
  console.log("[AI Processor] Stopped");
}

/**
 * Process queue items for all users concurrently
 * Each user gets one message at a time with a 30s gap
 */
async function processQueue(waManager) {
  try {
    // Get distinct users who have queued messages
    const queuedItems = await db.select({ userId: schema.aiMessageQueue.userId })
      .from(schema.aiMessageQueue)
      .where(eq(schema.aiMessageQueue.status, "queued"))
      .groupBy(schema.aiMessageQueue.userId);

    if (!queuedItems.length) return;

    // Process each user's oldest message concurrently
    const promises = queuedItems.map(async ({ userId }) => {
      // Skip if this user is already being processed
      if (processingUsers.has(userId)) return;

      // Enforce 45-second gap per user
      const lastTime = lastProcessedTime.get(userId) || 0;
      if (Date.now() - lastTime < GAP_MS) return;

      processingUsers.add(userId);
      try {
        await processNextForUser(waManager, userId);
      } finally {
        processingUsers.delete(userId);
        lastProcessedTime.set(userId, Date.now());
      }
    });

    await Promise.all(promises);
  } catch (err) {
    console.error("[AI Processor] Queue processing error:", err.message);
  }
}

/**
 * Process the next queued item for a specific user
 */
async function processNextForUser(waManager, userId) {
  try {
    // Get oldest queued item for this user
    const items = await db.select()
      .from(schema.aiMessageQueue)
      .where(and(
        eq(schema.aiMessageQueue.status, "queued"),
        eq(schema.aiMessageQueue.userId, userId)
      ))
      .orderBy(schema.aiMessageQueue.createdAt)
      .limit(1);

    if (!items.length) return;

    const item = items[0];

    // Skip @lid contacts - they must be handled immediately via msg.reply in handleIncomingMessage
    if (item.phone && item.phone.includes("@lid")) {
      console.log(`[AI Processor] Skipping @lid contact ${item.phone} - handled by msg.reply`);
      await db.update(schema.aiMessageQueue)
        .set({ status: "sent", aiResponse: "Handled via msg.reply for LID contact", processedAt: new Date() })
        .where(eq(schema.aiMessageQueue.id, item.id));
      return;
    }

    console.log(`[AI Processor] Processing queue item #${item.id} for user ${item.userId}`);

    await db.update(schema.aiMessageQueue)
      .set({ status: "processing" })
      .where(eq(schema.aiMessageQueue.id, item.id));

    const aiResult = await generateAiResponse(item.userId, item.incomingMessage);

    if (!aiResult.success) {
      throw new Error(aiResult.error || "AI generation failed");
    }

    await waManager.sendReply(item.sessionId, item.phone, aiResult.response);

    // Deduct AI reply credits after successful send
    try {
      await deductCredits(item.userId, "ai_reply", 1, `AI queued reply to ${item.phone}`);
    } catch (creditErr) {
      console.error(`[AI Processor] Credit deduction failed for item #${item.id}:`, creditErr.message);
    }

    await db.update(schema.aiMessageQueue)
      .set({
        status: "sent",
        aiResponse: aiResult.response,
        processedAt: new Date(),
      })
      .where(eq(schema.aiMessageQueue.id, item.id));

    console.log(`[AI Processor] Sent AI reply #${item.id} in ${aiResult.elapsedMs}ms`);

  } catch (error) {
    await handleProcessingError(userId, error);
  }
}

/**
 * Handle errors during processing for a specific user
 */
async function handleProcessingError(userId, error) {
  const errMsg = error.message || "";
  const isPermanentError =
    errMsg.includes("No LID") ||
    errMsg.includes("not a valid") ||
    errMsg.includes("not registered") ||
    errMsg.includes("invalid number");

  const isConfigError =
    errMsg.includes("not configured") ||
    errMsg.includes("not active") ||
    errMsg.includes("does not exist");

  try {
    // Find the item that was being processed for this user
    const itemRows = await db.select()
      .from(schema.aiMessageQueue)
      .where(and(
        eq(schema.aiMessageQueue.status, "processing"),
        eq(schema.aiMessageQueue.userId, userId)
      ))
      .orderBy(schema.aiMessageQueue.createdAt)
      .limit(1);

    if (!itemRows.length) return;
    const item = itemRows[0];

    if (isConfigError) {
      console.log(`[AI Processor] Skipping item #${item.id} - AI not configured`);
      await db.update(schema.aiMessageQueue)
        .set({ status: "skipped", aiResponse: "AI not configured", processedAt: new Date() })
        .where(eq(schema.aiMessageQueue.id, item.id));
    } else if (isPermanentError) {
      console.error(`[AI Processor] Permanent error for item #${item.id}: ${errMsg}`);
      await db.update(schema.aiMessageQueue)
        .set({ status: "failed", aiResponse: "Permanent error: " + errMsg, retryCount: MAX_RETRIES, processedAt: new Date() })
        .where(eq(schema.aiMessageQueue.id, item.id));
    } else {
      // Retryable error
      console.error(`[AI Processor] Retryable error for item #${item.id}:`, errMsg);
      const newRetryCount = (item.retryCount || 0) + 1;
      if (newRetryCount >= MAX_RETRIES) {
        await db.update(schema.aiMessageQueue)
          .set({ status: "failed", aiResponse: "Failed after retries: " + errMsg, retryCount: newRetryCount, processedAt: new Date() })
          .where(eq(schema.aiMessageQueue.id, item.id));
      } else {
        await db.update(schema.aiMessageQueue)
          .set({ status: "queued", retryCount: newRetryCount })
          .where(eq(schema.aiMessageQueue.id, item.id));
      }
    }
  } catch (dbErr) {
    console.error("[AI Processor] Error handling failure:", dbErr.message);
  }
}
