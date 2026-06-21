/**
 * Webhook trigger utility - sends events to user-configured webhook URLs
 * Includes SSRF protection to prevent internal network scanning
 */
import { db } from "./db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import crypto from "crypto";
import { URL } from "url";

/**
 * Validate webhook URL to prevent SSRF attacks.
 * Blocks private IPs, localhost, and metadata endpoints.
 */
function isValidWebhookUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Only allow http/https
    if (!["http:", "https:"].includes(url.protocol)) return false;

    const hostname = url.hostname.toLowerCase();

    // Block localhost
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;

    // Block private IP ranges
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./, // Link-local
      /^127\./,
      /^0\./,
      /^fc00:/i,
      /^fe80:/i,
    ];
    if (privateRanges.some(r => r.test(hostname))) return false;

    // Block cloud metadata endpoints
    const blockedHosts = [
      "169.254.169.254",
      "metadata.google.internal",
      "metadata.azure.internal",
      "169.254.170.2",
    ];
    if (blockedHosts.includes(hostname)) return false;

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Send a webhook event to all matching webhooks for a user.
 * Filters by sessionId if payload contains sessionId and webhook has sessionId set.
 */
export async function triggerWebhook(userId, eventType, payload) {
  try {
    const sessionId = payload?.sessionId || null;

    // Get all active webhooks for this user
    const webhooks = await db.select().from(schema.webhooks)
      .where(
        and(
          eq(schema.webhooks.userId, userId),
          eq(schema.webhooks.isActive, true)
        )
      );

    if (!webhooks.length) return;

    // Filter webhooks that subscribe to this event (or wildcard)
    // AND either have no sessionId (global) or match the payload sessionId
    const matchingHooks = webhooks.filter(hook => {
      try {
        const events = JSON.parse(hook.events || "[]");
        const eventMatch = events.includes(eventType) || events.includes("all") || events.includes("*");
        if (!eventMatch) return false;

        // Session filtering: if webhook has sessionId, only match if payload sessionId matches
        if (hook.sessionId && sessionId) {
          return parseInt(hook.sessionId) === parseInt(sessionId);
        }
        // If webhook has sessionId but payload has none, don't match
        if (hook.sessionId && !sessionId) return false;
        // If webhook has no sessionId, it's global — matches all
        return true;
      } catch (e) {
        return false;
      }
    });

    if (!matchingHooks.length) return;

    // Send to each matching webhook
    for (const hook of matchingHooks) {
      // Fire delivery in background but log result
      deliverWebhook(hook, eventType, payload).catch(err => {
        console.error(`[Webhook] Background delivery error for hook ${hook.id}:`, err.message);
      });
    }
  } catch (err) {
    console.error("[Webhook] triggerWebhook error:", err.message);
  }
}

/**
 * Deliver a single webhook and log the result
 */
async function deliverWebhook(hook, eventType, payload) {
  // SSRF protection
  if (!isValidWebhookUrl(hook.url)) {
    console.error(`[Webhook] BLOCKED SSRF attempt: ${hook.url}`);
    await db.insert(schema.webhookLogs).values({
      webhookId: hook.id,
      eventType,
      payload: JSON.stringify(payload).substring(0, 1000),
      responseStatus: 0,
      errorMessage: "SSRF protection: URL points to internal network or is invalid",
    });
    return;
  }

  const body = {
    event: eventType,
    timestamp: new Date().toISOString(),
    data: payload,
  };
  const bodyJson = JSON.stringify(body);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "ParroByte-Webhook/1.0",
    "X-Webhook-Event": eventType,
    "X-Webhook-Id": String(hook.id),
    "X-Webhook-Timestamp": String(Math.floor(Date.now() / 1000)),
  };

  // HMAC signature if secret is configured
  if (hook.secret) {
    const signature = crypto
      .createHmac("sha256", hook.secret)
      .update(bodyJson)
      .digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  let responseStatus = null;
  let responseBody = null;
  let errorMessage = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(hook.url, {
      method: "POST",
      headers,
      body: bodyJson,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    responseStatus = response.status;
    try {
      responseBody = await response.text();
    } catch (e) {
      responseBody = "";
    }

    console.log(`[Webhook] ${eventType} → ${hook.url} [${response.status}] hook=${hook.id}`);
  } catch (err) {
    errorMessage = err.message;
    console.error(`[Webhook] ${eventType} → ${hook.url} FAILED hook=${hook.id}:`, err.message);
  }

  // Log delivery attempt
  try {
    await db.insert(schema.webhookLogs).values({
      webhookId: hook.id,
      eventType,
      payload: bodyJson.substring(0, 10000),
      responseStatus,
      responseBody: responseBody ? responseBody.substring(0, 5000) : null,
      errorMessage: errorMessage ? errorMessage.substring(0, 1000) : null,
    });
  } catch (logErr) {
    console.error("[Webhook] Failed to log delivery:", logErr.message);
  }
}

/**
 * Get recent webhook logs for a specific webhook
 */
export async function getWebhookLogs(webhookId, limit = 50) {
  return db.select().from(schema.webhookLogs)
    .where(eq(schema.webhookLogs.webhookId, webhookId))
    .orderBy(desc(schema.webhookLogs.createdAt))
    .limit(limit);
}
