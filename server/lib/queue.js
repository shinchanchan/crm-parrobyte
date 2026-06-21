/**
 * BullMQ Queue System for ParroByte CRM
 * Handles: bulk messages, scheduled messages, scraping, AI replies, incoming messages
 * Uses Redis as backing store. Each queue has its own worker process.
 */
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import os from "os";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Shared Redis connection for queues
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on("error", (err) => console.error("[Queue] Redis error:", err.message));
connection.on("connect", () => console.log("[Queue] Redis connected"));

// Queue definitions
export const queues = {
  bulkMessage: new Queue("bulk-message", { connection, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 } } }),
  scheduledMessage: new Queue("scheduled-message", { connection, defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 10000 } } }),
  scraper: new Queue("scraper", { connection, defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 10000 } } }),
  aiReply: new Queue("ai-reply", { connection, defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 5000 } } }),
  incomingMessage: new Queue("incoming-message", { connection, defaultJobOptions: { attempts: 1 } }),
  emailSend: new Queue("email-send", { connection, defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 5000 } } }),
};

// Graceful shutdown helper
export async function closeQueues() {
  for (const [name, q] of Object.entries(queues)) {
    await q.close();
    console.log(`[Queue] ${name} closed`);
  }
  await connection.quit();
}

// Add job with priority and delay helpers
export async function addBulkMessageJob(data, options = {}) {
  return queues.bulkMessage.add("send-batch", data, {
    priority: options.priority || 5,
    delay: options.delay || 0,
    jobId: options.jobId || `bulk-${data.userId}-${Date.now()}`,
  });
}

export async function addScraperJob(data, options = {}) {
  return queues.scraper.add("scrape-businesses", data, {
    priority: options.priority || 5,
    delay: options.delay || 0,
    jobId: options.jobId || `scrape-${data.userId}-${Date.now()}`,
  });
}

export async function addAiReplyJob(data, options = {}) {
  return queues.aiReply.add("generate-reply", data, {
    priority: options.priority || 3,
    delay: options.delay || 0,
    jobId: options.jobId || `ai-${data.userId}-${Date.now()}`,
  });
}

export async function addIncomingMessageJob(data, options = {}) {
  return queues.incomingMessage.add("process-incoming", data, {
    priority: options.priority || 1,
    delay: options.delay || 0,
    jobId: options.jobId || `msg-${data.sessionId}-${Date.now()}`,
  });
}

export async function addScheduledMessageJob(data, options = {}) {
  return queues.scheduledMessage.add("send-scheduled", data, {
    priority: options.priority || 5,
    delay: options.delay || 0,
    jobId: options.jobId || `sched-${data.userId}-${Date.now()}`,
  });
}

// Get queue stats for monitoring
export async function getQueueStats() {
  const stats = {};
  for (const [name, q] of Object.entries(queues)) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    stats[name] = { waiting, active, completed, failed, delayed };
  }
  return stats;
}

// Resource monitor - check if server has enough RAM/CPU before adding jobs
export function getSystemResources() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const loadAvg = os.loadavg();
  return {
    totalMemGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
    freeMemGB: (freeMem / 1024 / 1024 / 1024).toFixed(1),
    memPercent,
    loadAvg1m: loadAvg[0].toFixed(2),
    loadAvg5m: loadAvg[1].toFixed(2),
    cpuCount: os.cpus().length,
  };
}

// Check if system is under heavy load
export function isSystemOverloaded() {
  const res = getSystemResources();
  return res.memPercent > 90 || parseFloat(res.loadAvg1m) > res.cpuCount * 1.5;
}
