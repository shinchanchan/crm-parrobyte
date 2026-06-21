#!/usr/bin/env node
/**
 * WhatsApp Heartbeat Worker
 * Monitors RAM and session health.
 * NOTE: Actual session keepalive is handled by the web server process
 * (each WhatsApp client has a built-in 60s heartbeat interval).
 */
import os from "os";
import { db } from "../server/lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";

console.log("[Heartbeat] Monitoring started.");

// RAM monitoring every 60 seconds
setInterval(async () => {
  try {
    const freePercent = (os.freemem() / os.totalmem()) * 100;
    const sessions = await db.select({ count: schema.whatsappSessions.id })
      .from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.status, "connected"));
    const sessionCount = sessions.length;

    console.log(`[Heartbeat] RAM: ${freePercent.toFixed(1)}% free | Connected sessions: ${sessionCount}`);

    if (freePercent < 10) {
      console.error("[Heartbeat] CRITICAL RAM LOW! Consider disconnecting idle sessions.");
    }
  } catch (e) {
    console.error("[Heartbeat] Error:", e.message);
  }
}, 60000);

// Graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
