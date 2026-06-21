import wwebjs from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia, NoAuth, Buttons, List, Poll } = wwebjs;

// Patch PollVote constructor to handle missing poll options gracefully
// whatsapp-web.js v1.34.7 can crash when poll option localId is not found in parentMessage.pollOptions
try {
  const PollVoteCls = wwebjs.PollVote;
  if (PollVoteCls && PollVoteCls.prototype && PollVoteCls.prototype._patch) {
    const originalPatch = PollVoteCls.prototype._patch;
    PollVoteCls.prototype._patch = function(data) {
      try {
        return originalPatch.call(this, data);
      } catch (err) {
        console.error('[PollVote Patch] Library constructor crashed, applying fallback:', err.message);
        this.voter = data.sender || '';
        // Fallback: map selected option IDs to names if we can find them, otherwise 'Unknown'
        const parentOpts = data.parentMessage?.pollOptions || [];
        this.selectedOptions = (data.selectedOptionLocalIds || []).map(e => ({
          name: parentOpts.find(x => x.localId === e)?.name || 'Unknown',
          localId: e,
        }));
        this.interractedAtTs = data.senderTimestampMs;
        try {
          const Message = require('whatsapp-web.js/src/structures/Message');
          this.parentMessage = data.parentMessage ? new Message(this.client, data.parentMessage) : null;
        } catch (mErr) {
          this.parentMessage = null;
        }
        this.parentMsgKey = data.parentMsgKey;
        return this;
      }
    };
    console.log('[PollVote Patch] Applied defensive patch for poll vote constructor');
  }
} catch (patchErr) {
  console.error('[PollVote Patch] Failed to apply patch:', patchErr.message);
}

import qrcode from "qrcode";
import fs from "fs/promises";
import { statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../server/lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { getAiConfigWithFallback } from "../server/lib/aiService.js";
import { triggerWebhook } from "../server/lib/webhookTrigger.js";
import { sendTestEmail } from "../server/lib/mail.js";
import { checkCredits, deductCredits } from "../server/lib/credits.js";
import { addIncomingMessageJob, isSystemOverloaded, getSystemResources } from "../server/lib/queue.js";
import os from "os";

/**
 * Normalize phone number for WhatsApp
 * - If already has @lid or @c.us or @g.us, return as-is (WhatsApp internal IDs)
 * - For raw digit-only numbers: remove leading 0, add country code, append @c.us
 */
function normalizePhone(phone, countryCode) {
  if (!phone) return null;

  // Already a WhatsApp internal ID - NEVER modify these
  if (phone.includes("@lid") || phone.includes("@c.us") || phone.includes("@g.us")) {
    return phone;
  }

  let digits = String(phone).replace(/\D/g, "");

  // Remove leading 0
  if (digits.startsWith("0")) {
    digits = digits.substring(1);
  }

  // If exactly 10 digits, add country code (strip + if present)
  if (digits.length === 10) {
    const cc = String(countryCode || "91").replace(/^\+/, "");
    digits = cc + digits;
  }

  return digits + "@c.us";
}

/**
 * Strip suffix for DB storage only (phone numbers stored without @suffix)
 */
function stripPhoneSuffix(phone) {
  if (!phone) return "";
  // Strip any WhatsApp suffix: @c.us, @lid, @g.us, @s.whatsapp.net, @broadcast, etc.
  return String(phone).replace(/@[a-z0-9.]+$/, "");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.join(process.cwd(), ".wwebjs_auth");

// Detect Chromium/Chrome executable
function findChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const paths = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/lib/chromium/chromium",
    "/opt/google/chrome/google-chrome",
    "/opt/google/chrome/chrome",
  ];
  for (const p of paths) {
    try {
      try { statSync(p); return p; } catch (e) {}
    } catch (e) {}
  }
  return null;
}

const CHROME_PATH = findChromeExecutable();
console.log("[WhatsApp] Chrome/Chromium path:", CHROME_PATH || "NOT FOUND - will use bundled Chromium");

class WhatsAppManager {
  constructor() {
    this.clients = new Map();
    this.qrCodes = new Map();
    this.sessionStatus = new Map();
    this.messageQueue = [];
    this.processingQueue = false;
    this.rateLimits = new Map();
    this.userDisconnected = new Set(); // Track user-initiated disconnects (don't auto-reconnect)
    this._shuttingDown = false; // Track server shutdown to avoid false disconnect alerts
    this._ensureAuthDir();
  }

  // ── RAM-based session limits ──
  getMaxSessions() {
    const totalGB = os.totalmem() / 1024 / 1024 / 1024;
    // Conservative: ~200MB per optimized Chromium session
    // Reserve 3GB for OS + DB + Node workers
    const availableGB = Math.max(2, totalGB - 3);
    return Math.floor(availableGB / 0.2); // ~200MB per session
  }

  async canCreateSession() {
    const currentCount = this.clients.size;
    const maxSessions = this.getMaxSessions();
    const freeMemPercent = (os.freemem() / os.totalmem()) * 100;

    if (currentCount >= maxSessions) {
      return { allowed: false, reason: `Max ${maxSessions} WhatsApp sessions reached. Disconnect an existing session first.` };
    }
    if (freeMemPercent < 10) {
      return { allowed: false, reason: `Server memory too low (${freeMemPercent.toFixed(1)}% free). Cannot create new session.` };
    }
    return { allowed: true, maxSessions, currentCount, freeMemPercent };
  }

  async _ensureAuthDir() {
    try {
      await fs.mkdir(AUTH_DIR, { recursive: true });
    } catch (e) {
      console.error("Failed to create auth directory:", e.message);
    }
  }

  async _cleanupAuth(clientId) {
    try {
      const authPath = path.join(AUTH_DIR, clientId);
      await fs.rm(authPath, { recursive: true, force: true });
    } catch (e) {}
  }

  async createSession(userId, sessionName, sessionId = null) {
    // ── RAM-based session limit check ──
    const ramCheck = await this.canCreateSession();
    if (!ramCheck.allowed) {
      throw new Error(ramCheck.reason);
    }
    console.log(`[WhatsApp] Creating session. Current: ${ramCheck.currentCount}/${ramCheck.maxSessions}, RAM: ${ramCheck.freeMemPercent.toFixed(1)}% free`);

    let session;
    try {
      if (sessionId) {
        const existing = await db.select().from(schema.whatsappSessions)
          .where(eq(schema.whatsappSessions.id, sessionId));
        session = existing[0];
        if (!session) throw new Error("Session not found in database");
      } else {
        const result = await db.insert(schema.whatsappSessions).values({
          userId,
          sessionName,
          status: "connecting",
        }).returning();
        session = result[0];
      }
    } catch (dbErr) {
      console.error("Database error creating session:", dbErr);
      throw dbErr;
    }

    const clientId = `${userId}_${session.id}`;
    const authPath = path.join(AUTH_DIR, clientId);

    // Clean any stale Chrome lock files before starting new browser
    const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const lock of lockFiles) {
      for (const lockDir of [authPath, path.join(authPath, "session")]) {
        try {
          await fs.unlink(path.join(lockDir, lock));
          console.log(`[${clientId}] Cleaned stale lock file: ${lock}`);
        } catch (e) {}
      }
    }

    // Ensure auth subdirectory exists
    try {
      await fs.mkdir(authPath, { recursive: true });
    } catch (e) {}

    // ── Optimized Puppeteer args for low memory (8GB target) ──
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: authPath }),
      webVersionCache: { type: "local" },
      puppeteer: {
        headless: "new",
        executablePath: CHROME_PATH || undefined,
        protocolTimeout: 0,
        handleSIGINT: false,
        handleSIGTERM: false,
        // Single-process mode saves ~50% RAM but slightly less stable.
        // Use only when RAM is tight (< 8GB total)
        ...(this.getMaxSessions() < 25 ? {} : { args: ["--single-process"] }),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-breakpad",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-features=IsolateOrigins,site-per-process,TranslateUI,InterestFeedContentSuggestions,MediaRouter,OptimizationHints,NetworkPrediction,OfflinePagesPrefetching,AutofillServerCommunication,PasswordManager",
          "--disable-hang-monitor",
          "--disable-ipc-flooding-protection",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--force-color-profile=srgb",
          "--metrics-recording-only",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-sync",
          "--disable-translate",
          "--disable-blink-features=AutomationControlled",
          "--js-flags=--max-old-space-size=256",
          "--window-size=800,600",
        ],
        timeout: 120000,
        bypassCSP: true,
        defaultViewport: { width: 800, height: 600 },
      },
    });

    client.on("qr", async (qr) => {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        this.qrCodes.set(clientId, qrDataUrl);
        this.sessionStatus.set(clientId, "qr_ready");

        await db.update(schema.whatsappSessions)
          .set({ status: "qr_ready", qrCode: qrDataUrl })
          .where(eq(schema.whatsappSessions.id, session.id));

        console.log(`[${clientId}] QR code generated - ready to scan`);
      } catch (err) {
        console.error(`[${clientId}] QR generation error:`, err.message);
      }
    });

    client.on("ready", async () => {
      console.log(`[${clientId}] Client ready!`);
      this.sessionStatus.set(clientId, "connected");
      this.qrCodes.delete(clientId);

      try {
        const info = client.info;
        const phoneNumber = info?.wid?.user || null;
        await db.update(schema.whatsappSessions)
          .set({
            status: "connected",
            phoneNumber: phoneNumber,
            lastActivity: new Date(),
            disconnectAlertSent: false,
            qrCode: null,
          })
          .where(eq(schema.whatsappSessions.id, session.id));

        // Trigger webhook for session connected
        triggerWebhook(userId, "session.connected", {
          sessionId: session.id,
          sessionName: session.sessionName,
          phoneNumber: phoneNumber,
          timestamp: new Date().toISOString(),
        });

        // Send email notification to user on connect
        await this._notifyUserOfConnect(userId, session.sessionName, phoneNumber);
      } catch (err) {
        console.error(`[${clientId}] Ready handler error:`, err.message);
      }

      // Start heartbeat to keep session alive (prevents idle disconnect)
      this._startHeartbeat(clientId, client);
    });

    client.on("change_state", (state) => {
      console.log(`[${clientId}] State changed: ${state}`);
      if (state === "CONFLICT" || state === "UNLAUNCHED") {
        console.log(`[${clientId}] Potentially problematic state detected: ${state}`);
      }
    });

    client.on("disconnected", async (reason) => {
      console.log(`[${clientId}] Disconnected:`, reason);
      this.sessionStatus.set(clientId, "disconnected");
      this.clients.delete(clientId);

      // Stop heartbeat
      this._stopHeartbeat(clientId);

      // During server shutdown, don't update DB or send emails — the session
      // will be restored on next startup. This prevents false "disconnected"
      // states that block restoreAllSessions().
      if (this._shuttingDown) {
        console.log(`[${clientId}] Disconnect during shutdown — skipping DB update and email`);
        return;
      }

      const isUserInitiated = this.userDisconnected.has(clientId);

      try {
        await db.update(schema.whatsappSessions)
          .set({ status: "disconnected", lastActivity: new Date() })
          .where(eq(schema.whatsappSessions.id, session.id));

        // Trigger webhook for session disconnected
        triggerWebhook(userId, "session.disconnected", {
          sessionId: session.id,
          sessionName: session.sessionName,
          reason: reason || "unknown",
          timestamp: new Date().toISOString(),
        });

        // Send email notification only for unexpected disconnects (not user-initiated)
        if (!isUserInitiated) {
          await this._notifyUserOfDisconnect(userId, session.id, session.sessionName, reason || "Session disconnected from WhatsApp");
        } else {
          console.log(`[${clientId}] User-initiated disconnect — skipping email notification`);
        }
      } catch (err) {
        console.error(`[${clientId}] DB update error on disconnect:`, err.message);
      }

      // Auto-reconnect after 10s if this was NOT a user-initiated disconnect
      // This handles "Execution context was destroyed" and other transient errors
      if (!isUserInitiated) {
        console.log(`[${clientId}] Auto-reconnecting in 10s (unexpected disconnect: ${reason})`);
        setTimeout(() => {
          this.reconnectSession(session.id).catch(err => {
            console.error(`[${clientId}] Auto-reconnect failed:`, err.message);
          });
        }, 10000);
      } else {
        this.userDisconnected.delete(clientId); // Clear flag for next time
      }

      // Do NOT clean auth on disconnect - let LocalAuth keep the session data for reconnect
    });

    client.on("auth_failure", async (msg) => {
      console.error(`[${clientId}] Auth failure:`, msg);
      this.sessionStatus.set(clientId, "disconnected");

      try {
        await db.update(schema.whatsappSessions)
          .set({ status: "disconnected" })
          .where(eq(schema.whatsappSessions.id, session.id));
      } catch (err) {
        console.error(`[${clientId}] DB update error on auth failure:`, err.message);
      }
    });

    // Catch-all error handler - prevents process crash from unhandled client errors
    client.on("error", (err) => {
      console.error(`[${clientId}] Client error (non-fatal):`, err.message || err);
    });

    client.on("message_create", async (msg) => {
      if (msg.fromMe) return;
      // Queue incoming message to worker instead of processing inline
      try {
        await addIncomingMessageJob({
          sessionId: session.id,
          userId: session.userId,
          phone: msg.from,
          body: msg.body,
          msg: { from: msg.from, body: msg.body, hasMedia: msg.hasMedia, timestamp: msg.timestamp },
        });
      } catch (qerr) {
        console.error("[MessageHandler] Queue enqueue failed:", qerr.message);
        // Fallback: process inline if queue fails
        this.handleIncomingMessage(session.id, msg).catch(e => console.error("[MessageHandler] Fallback error:", e.message));
      }
    });

    // Handle poll votes — create/update lead with vote data
    // NOTE: whatsapp-web.js emits 'vote_update', not 'poll_vote'
    client.on("vote_update", async (vote) => {
      setImmediate(() => {
        this.handlePollVote(session.id, vote).catch(function(err) {
          console.error("[PollVote] Error:", err.message);
        });
      });
    });

    // Initialize client with retry logic
    // The "Execution context was destroyed" error happens when WhatsApp Web
    // internally navigates during startup. We retry up to 5 times with delays.
    let initAttempts = 0;
    const maxAttempts = 5;
    let lastError = null;

    while (initAttempts < maxAttempts) {
      initAttempts++;
      try {
        console.log(`[${clientId}] Initializing WhatsApp client (attempt ${initAttempts}/${maxAttempts})...`);
        this.sessionStatus.set(clientId, "connecting");

        // Delay before init to let browser settle, longer on retries
        if (initAttempts > 1) {
          const delayMs = initAttempts === 2 ? 5000 : 10000;
          console.log(`[${clientId}] Waiting ${delayMs}ms before retry...`);
          await new Promise(r => setTimeout(r, delayMs));
        }

        await client.initialize();
        this.clients.set(clientId, { client, sessionId: session.id, userId });
        console.log(`[${clientId}] Client initialized successfully`);
        lastError = null;
        break; // Success - exit retry loop

      } catch (initErr) {
        lastError = initErr;
        const errMsg = initErr.message || "";
        console.error(`[${clientId}] Init attempt ${initAttempts} failed:`, errMsg);

        // If it's the "Execution context was destroyed" error, retry
        // Otherwise, fail immediately for non-retryable errors
        const isRetryable =
          errMsg.includes("Execution context was destroyed") ||
          errMsg.includes("Protocol error") ||
          errMsg.includes("Target closed") ||
          errMsg.includes("Navigation failed") ||
          errMsg.includes("net::ERR") ||
          errMsg.includes("page.evaluate") ||
          errMsg.includes("evaluateHandle");

        if (!isRetryable || initAttempts >= maxAttempts) {
          break; // Non-retryable or max attempts reached
        }
      }
    }

    // If all retries failed, clean up and throw
    if (lastError) {
      console.error(`[${clientId}] All ${maxAttempts} init attempts failed. Last error:`, lastError.message);
      this.sessionStatus.set(clientId, "disconnected");

      try {
        await db.update(schema.whatsappSessions)
          .set({ status: "disconnected" })
          .where(eq(schema.whatsappSessions.id, session.id));
      } catch (dbErr) {
        console.error(`[${clientId}] Failed to update DB status:`, dbErr.message);
      }

      // Clean up the client to free resources
      try {
        await client.destroy();
      } catch (e) {}

      throw new Error(`WhatsApp initialization failed after ${maxAttempts} attempts: ${lastError.message}`);
    }

    return session;
  }

  async handleIncomingMessage(sessionId, msg) {
    try {
      // Debug: log every incoming message
      console.log(`[AutoReply] Incoming message from=${msg.from}, body="${msg.body || "(empty)"}"`);

      const sessionRows = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, sessionId));

      if (!sessionRows.length) {
        console.log("[AutoReply] Session not found:", sessionId);
        return;
      }

      const userId = sessionRows[0].userId;

      // Trigger webhook for incoming message
      triggerWebhook(userId, "message.received", {
        sessionId,
        from: msg.from,
        body: msg.body,
        timestamp: new Date().toISOString(),
        hasMedia: msg.hasMedia || false,
      });

      // Skip messages from self
      if (msg.fromMe) {
        console.log("[AutoReply] Skipping message from self");
        return;
      }

      // Skip group messages — auto-reply and credit deduction should not apply to groups
      if (msg.from && msg.from.includes("@g.us")) {
        console.log("[AutoReply] Skipping group message");
        return;
      }

      // Skip if no message body
      if (!msg.body || !msg.body.trim()) {
        console.log("[AutoReply] Skipping empty message body");
        return;
      }

      // Check if universal AI reply is enabled for this user
      let universalAi = false;
      try {
        const aiConfig = await getAiConfigWithFallback(userId);
        if (aiConfig && aiConfig.isActive && aiConfig.universalAiReply) {
          universalAi = true;
        }
      } catch (e) { /* ignore */ }

      // === UNIVERSAL AI REPLY: respond to ALL messages ===
      if (universalAi) {
        console.log(`[AutoReply] Universal AI mode active for user ${userId}`);

        if (msg.from && msg.from.includes("@lid")) {
          try {
            const aiCheck = await checkCredits(userId, "ai_reply");
            if (!aiCheck.allowed) {
              console.log(`[AutoReply] Insufficient AI credits for user ${userId}`);
              return;
            }
            const { generateAiResponse } = await import("../server/lib/aiService.js");
            const aiResult = await generateAiResponse(userId, msg.body);
            if (aiResult.success) {
              await msg.reply(aiResult.response);
              await deductCredits(userId, "ai_reply", 1, `Universal AI reply to ${msg.from}`);
              console.log(`[AI Universal] Immediate LID reply sent to ${msg.from}`);
            }
          } catch (lidErr) {
            console.error(`[AI Universal] LID reply error:`, lidErr.message);
          }
        } else {
          await this.queueAiResponse(userId, sessionId, msg.from, msg.body);
          console.log(`[AI Universal] Queued AI reply for ${msg.from}`);
        }
        return;
      }

      // === KEYWORD-BASED: only respond to matching keywords ===
      console.log(`[AutoReply] Fetching active rules for user ${userId}`);
      const autoReplies = await db.select().from(schema.autoReplies)
        .where(
          and(
            eq(schema.autoReplies.userId, userId),
            eq(schema.autoReplies.isActive, true)
          )
        );

      console.log(`[AutoReply] Found ${autoReplies.length} active rules for user ${userId}`);

      if (!autoReplies.length) {
        console.log(`[AutoReply] No active auto-reply rules for user ${userId}`);
        return;
      }

      const messageBody = (msg.body || "").toLowerCase().trim();
      console.log(`[AutoReply] Checking message "${messageBody}" against ${autoReplies.length} rules`);

      for (const rule of autoReplies) {
        let matches = false;
        const triggerValue = (rule.triggerValue || "").toLowerCase().trim();

        console.log(`[AutoReply] Rule "${rule.name}": type=${rule.triggerType}, trigger="${triggerValue}", responseType=${rule.responseType}`);

        switch (rule.triggerType) {
          case "exact":
            matches = messageBody === triggerValue;
            break;
          case "contains":
            matches = messageBody.includes(triggerValue);
            break;
          case "starts_with":
            matches = messageBody.startsWith(triggerValue);
            break;
          case "ends_with":
            matches = messageBody.endsWith(triggerValue);
            break;
          case "regex":
            try {
              const regex = new RegExp(triggerValue, "i");
              matches = regex.test(msg.body);
            } catch (e) {
              matches = false;
            }
            break;
        }

        console.log(`[AutoReply] Rule "${rule.name}" match result: ${matches}`);

        if (matches) {
          console.log(`[AutoReply] MATCHED rule "${rule.name}" - responseType=${rule.responseType}`);

          if (rule.responseType === "ai") {
            // AI response
            const aiCheck = await checkCredits(userId, "ai_reply");
            if (!aiCheck.allowed) {
              console.log(`[AutoReply] Insufficient AI credits for user ${userId} - skipping AI reply`);
              break;
            }
            if (msg.from && msg.from.includes("@lid")) {
              try {
                const { generateAiResponse } = await import("../server/lib/aiService.js");
                const aiResult = await generateAiResponse(userId, msg.body);
                if (aiResult.success) {
                  await msg.reply(aiResult.response);
                  await deductCredits(userId, "ai_reply", 1, `AI auto-reply to ${msg.from}`);
                  console.log(`[AI Keyword] Immediate LID reply to ${msg.from}`);
                }
              } catch (lidErr) {
                console.error(`[AI Keyword] LID reply error:`, lidErr.message);
              }
            } else {
              await this.queueAiResponse(userId, sessionId, msg.from, msg.body);
              console.log(`[AI Queue] Queued AI response for user ${userId}, phone ${msg.from}`);
            }
          } else {
            // STATIC response - send immediately using msg.reply
            try {
              console.log(`[AutoReply] Sending STATIC reply to ${msg.from}: "${rule.responseContent?.substring(0, 50)}..."`);
              await msg.reply(rule.responseContent);
              console.log(`[AutoReply] STATIC reply sent successfully to ${msg.from}`);
              // Trigger webhook for auto-reply sent
              triggerWebhook(userId, "message.sent", {
                sessionId,
                to: msg.from,
                body: rule.responseContent,
                type: "auto_reply",
                ruleName: rule.name,
                timestamp: new Date().toISOString(),
              });
            } catch (replyErr) {
              console.error(`[AutoReply] STATIC reply send error:`, replyErr.message);
            }
          }
          break; // Only match first rule
        }
      }
    } catch (error) {
      console.error("[AutoReply] handler error:", error.message);
    }
  }

  /**
   * Queue an AI response for background processing with 45s gap
   */
  async queueAiResponse(userId, sessionId, phone, incomingMessage) {
    try {
      // Store phone exactly as received - normalizePhone preserves @lid and @c.us
      const normalizedPhone = normalizePhone(phone) || phone;

      await db.insert(schema.aiMessageQueue).values({
        userId,
        sessionId,
        phone: normalizedPhone,
        incomingMessage,
        status: "queued",
      });
    } catch (err) {
      console.error("[AI Queue] queueAiResponse error:", err.message);
    }
  }

  /**
   * Handle incoming poll vote — create or update lead with vote data
   */
  async handlePollVote(sessionId, vote) {
    try {
      const sessionRows = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, sessionId));
      if (!sessionRows.length) return;
      const userId = sessionRows[0].userId;

      const voterPhone = stripPhoneSuffix(vote.voter);
      const pollName = vote.parentMessage?.pollName || vote.parentMessage?.name || vote.parentMessage?.body || "Poll";

      // Defensive: handle both {name, localId} objects and plain strings
      let selectedOptions = [];
      if (Array.isArray(vote.selectedOptions)) {
        selectedOptions = vote.selectedOptions.map(o => {
          if (typeof o === 'string') return o;
          if (o && typeof o === 'object') return o.name || o.label || o.text || String(o);
          return String(o);
        }).filter(Boolean);
      }

      console.log(`[PollVote] User ${voterPhone} voted in "${pollName}": ${selectedOptions.join(", ")} (options=${selectedOptions.length})`);

      // Look up contact name from contacts table
      let voterName = voterPhone;
      try {
        const contactRows = await db.select().from(schema.contacts)
          .where(and(
            eq(schema.contacts.userId, userId),
            eq(schema.contacts.phone, voterPhone)
          ));
        if (contactRows.length && contactRows[0].name) {
          voterName = contactRows[0].name;
          console.log(`[PollVote] Found contact name: ${voterName} for ${voterPhone}`);
        }
      } catch (contactErr) {
        // Contacts table lookup failed — proceed with phone as name
      }

      // Find existing lead by phone
      const existingLeads = await db.select().from(schema.leads)
        .where(and(
          eq(schema.leads.userId, userId),
          eq(schema.leads.phone, voterPhone)
        ));

      const voteData = {
        pollName,
        selectedOptions,
        votedAt: new Date().toISOString(),
      };

      if (existingLeads.length) {
        // Update existing lead — append poll vote to data
        const lead = existingLeads[0];
        let leadData = {};
        try {
          leadData = lead.data ? JSON.parse(lead.data) : {};
        } catch (e) { leadData = {}; }

        if (!Array.isArray(leadData.pollVotes)) leadData.pollVotes = [];
        leadData.pollVotes.push(voteData);

        let notes = lead.notes || "";
        notes += (notes ? "\n" : "") + `[Poll] ${pollName}: ${selectedOptions.join(", ")} (${new Date().toLocaleString()})`;

        await db.update(schema.leads)
          .set({
            data: JSON.stringify(leadData),
            notes: notes.substring(0, 2000),
            updatedAt: new Date(),
            // Update name from contact if lead name is currently just the phone number
            name: (lead.name === voterPhone && voterName !== voterPhone) ? voterName : lead.name,
          })
          .where(eq(schema.leads.id, lead.id));
        console.log(`[PollVote] Updated lead ${lead.id} with vote data`);
      } else {
        // Create new lead from poll vote
        const leadData = { pollVotes: [voteData] };
        await db.insert(schema.leads).values({
          userId,
          name: voterName,
          phone: voterPhone,
          source: "poll_vote",
          status: "new",
          notes: `[Poll] ${pollName}: ${selectedOptions.join(", ")} (${new Date().toLocaleString()})`,
          data: JSON.stringify(leadData),
        });
        console.log(`[PollVote] Created new lead for ${voterPhone}`);
      }

      // === POLL AUTO-RESPONSE (template-based) ===
      // Send automated follow-up message based on selected option(s)
      try {
        // Find the poll template by matching poll name (content) and type=poll
        const pollTemplates = await db.select().from(schema.templates)
          .where(and(
            eq(schema.templates.userId, userId),
            eq(schema.templates.type, "poll"),
            eq(schema.templates.content, pollName)
          ))
          .orderBy(desc(schema.templates.createdAt))
          .limit(1);

        if (pollTemplates.length) {
          let pollVars = {};
          try { pollVars = JSON.parse(pollTemplates[0].variables || '{}'); } catch (e) {}

          for (const optionName of selectedOptions) {
            try {
              const respConfig = pollVars.optionResponses ? pollVars.optionResponses[optionName] : null;
              if (respConfig && respConfig.templateId) {
                const respTemplates = await db.select().from(schema.templates)
                  .where(eq(schema.templates.id, respConfig.templateId));
                if (respTemplates.length) {
                  const respTemplate = respTemplates[0];
                  const isLid = vote.voter && vote.voter.includes('@lid');
                  const hasParentMsg = vote.parentMessage && vote.parentMessage.id;

                  if (isLid && hasParentMsg) {
                    // LID contacts must be replied to via the parent poll message
                    let content = respTemplate.content;
                    let options = {};
                    if (respTemplate.type === 'audio' && respTemplate.mediaUrl) {
                      content = MessageMedia.fromFilePath(respTemplate.mediaUrl);
                      options.sendAudioAsVoice = true;
                    } else if ((respTemplate.type === 'image' || respTemplate.type === 'video') && respTemplate.mediaUrl) {
                      content = MessageMedia.fromFilePath(respTemplate.mediaUrl);
                    }
                    console.log(`[PollAutoResponse] Replying (LID) ${respTemplate.type} template "${respTemplate.name}" to ${vote.voter} for option "${optionName}"`);
                    await vote.parentMessage.reply(content, null, options);
                    console.log(`[PollAutoResponse] Replied to ${vote.voter}`);
                  } else {
                    // Normal @c.us contacts
                    const voterWaId = vote.voter || normalizePhone(voterPhone);
                    console.log(`[PollAutoResponse] Sending ${respTemplate.type} template "${respTemplate.name}" to ${voterWaId} for option "${optionName}"`);
                    await this.sendMessage(sessionId, voterWaId, respTemplate.content, respTemplate.type, respTemplate.mediaUrl || null);
                    console.log(`[PollAutoResponse] Sent to ${voterWaId}`);
                  }
                }
              }
            } catch (sendErr) {
              console.error(`[PollAutoResponse] Failed for option "${optionName}":`, sendErr.message);
            }
          }
        }
      } catch (autoErr) {
        console.error("[PollAutoResponse] Error:", autoErr.message);
      }
    } catch (err) {
      console.error("[PollVote] handler error:", err.message);
    }
  }

  /**
   * Send a reply message (used by AI processor for @c.us contacts only)
   */
  async sendReply(sessionId, phone, content) {
    try {
      // For @c.us contacts only - @lid contacts are handled immediately in handleIncomingMessage
      const normalizedPhone = normalizePhone(phone) || phone;
      await this.sendMessage(sessionId, normalizedPhone, content, "text");
    } catch (err) {
      console.error("[AI Queue] sendReply error:", err.message);
      // Don't throw - let the processor handle retries
    }
  }

  async sendMessage(sessionId, phone, content, type = "text", mediaUrl = null, interactiveData = null) {
    const sessionRows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!sessionRows.length) throw new Error("Session not found");

    const userId = sessionRows[0].userId;
    const clientId = `${userId}_${sessionId}`;
    let clientData = this.clients.get(clientId);

    // If client not in memory but DB says connected, try auto-reconnect once
    if (!clientData) {
      console.log(`[${clientId}] Client not in memory (DB status=${sessionRows[0].status}). Attempting auto-reconnect...`);
      try {
        await this.reconnectSession(sessionId);
        // Poll for client connection for up to 15 seconds (reconnectSession takes ~5-10s)
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          clientData = this.clients.get(clientId);
          if (clientData) break;
        }
      } catch (reconnectErr) {
        console.error(`[${clientId}] Auto-reconnect failed:`, reconnectErr.message);
      }
    }

    if (!clientData) {
      // Sync DB status to reality
      try {
        await db.update(schema.whatsappSessions)
          .set({ status: "disconnected" })
          .where(eq(schema.whatsappSessions.id, sessionId));
      } catch (e) {}
      throw new Error("WhatsApp client not connected. Please go to WhatsApp Sessions and reconnect your session.");
    }

    if (!this.checkRateLimit(userId)) {
      throw new Error("Rate limit exceeded. Please wait before sending more messages.");
    }

    let chatId = normalizePhone(phone) || phone;

    // Safety check: @lid contacts should be handled via msg.reply, not sendMessage
    if (chatId.includes("@lid")) {
      console.warn(`[WhatsApp] sendMessage called with @lid contact: ${chatId}. LID contacts must use msg.reply() instead.`);
      throw new Error("Cannot sendMessage to @lid contact. Use msg.reply() for LID contacts.");
    }

    // ── Robust LID resolution (whatsapp-web.js v1.23.0 workaround) ──
    const rawNumber = chatId.replace(/@c\.us$|@g\.us$/, '');
    let lidResolved = false;

    // Method 1: getNumberId()
    try {
      const numberId = await clientData.client.getNumberId(rawNumber);
      if (numberId && numberId._serialized) {
        chatId = numberId._serialized;
        lidResolved = true;
        console.log(`[WhatsApp] LID resolved via getNumberId: ${rawNumber} → ${chatId}`);
      } else {
        console.warn(`[WhatsApp] getNumberId returned null for ${rawNumber}`);
      }
    } catch (e) {
      console.warn(`[WhatsApp] getNumberId threw for ${rawNumber}:`, e.message);
    }

    // Method 2: isRegisteredUser() forces server lookup, then retry getNumberId()
    if (!lidResolved) {
      try {
        const isRegistered = await clientData.client.isRegisteredUser(rawNumber);
        if (isRegistered) {
          console.log(`[WhatsApp] ${rawNumber} is registered, retrying getNumberId after 500ms...`);
          await new Promise(r => setTimeout(r, 500));
          const numberId = await clientData.client.getNumberId(rawNumber);
          if (numberId && numberId._serialized) {
            chatId = numberId._serialized;
            lidResolved = true;
            console.log(`[WhatsApp] LID resolved via retry: ${rawNumber} → ${chatId}`);
          }
        } else {
          console.warn(`[WhatsApp] ${rawNumber} is NOT registered on WhatsApp`);
        }
      } catch (e) {
        console.warn(`[WhatsApp] isRegisteredUser/retry failed for ${rawNumber}:`, e.message);
      }
    }

    // Method 3: Direct internal API fallback
    if (!lidResolved) {
      try {
        const wid = await clientData.client.pupPage.evaluate(async (number) => {
          try {
            // Try QueryExist (available in some builds)
            const widObj = window.Store.WidFactory.createWid(number + '@c.us');
            const result = await window.Store.QueryExist?.queryExist(widObj);
            if (result && result.wid) return result.wid._serialized;
          } catch (_) {}
          try {
            // Fallback to Wap.queryExist
            const widObj = window.Store.WidFactory.createWid(number + '@c.us');
            const result = await window.Store.Wap.queryExist(widObj);
            if (result && result.wid) return result.wid._serialized;
          } catch (_) {}
          return null;
        }, rawNumber);
        if (wid && (wid.includes('@lid') || wid.includes('@c.us'))) {
          chatId = wid;
          lidResolved = true;
          console.log(`[WhatsApp] LID resolved via internal API: ${rawNumber} → ${chatId}`);
        }
      } catch (e) {
        console.warn(`[WhatsApp] Internal API fallback failed for ${rawNumber}:`, e.message);
      }
    }

    if (!lidResolved) {
      console.warn(`[WhatsApp] Could not resolve LID for ${rawNumber}. Message will likely fail with 'No LID for user'.`);
    }

    try {
      let result;

      if (type === "poll" && interactiveData) {
        // Send poll message
        const data = typeof interactiveData === "string" ? JSON.parse(interactiveData) : interactiveData;
        const pollOptions = (data.options || []).filter(o => o && o.trim());
        if (pollOptions.length < 2) {
          throw new Error("Poll requires at least 2 options");
        }
        const poll = new Poll(content, pollOptions, {
          allowMultipleAnswers: data.allowMultipleAnswers === true,
        });
        result = await clientData.client.sendMessage(chatId, poll);
        console.log(`[WhatsApp] Poll sent to ${chatId} with ${pollOptions.length} options`);
      } else if (type === "text" || !mediaUrl) {
        result = await clientData.client.sendMessage(chatId, content);
      } else {
        let media;

        if (mediaUrl.startsWith("http")) {
          const response = await fetch(mediaUrl);
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mimeType = response.headers.get("content-type") || "application/octet-stream";
          media = new MessageMedia(mimeType, base64, "file");
        } else {
          // Resolve web-relative paths (e.g., /uploads/media/file.jpg) to absolute filesystem paths.
          // Absolute paths (e.g., /home/user/.../file.jpg) are used as-is.
          let filePath = mediaUrl;
          if (filePath.startsWith("/uploads/") || filePath.startsWith("/media/")) {
            filePath = path.join(process.cwd(), "public", filePath);
          }

          // Check file size before loading into memory — large files crash Puppeteer
          const stats = statSync(filePath);
          const fileSizeMB = stats.size / 1024 / 1024;
          const maxSizeMB = 10;
          if (fileSizeMB > maxSizeMB) {
            throw new Error(
              `Media file too large (${fileSizeMB.toFixed(1)}MB). ` +
              `Maximum allowed is ${maxSizeMB}MB. ` +
              `Please compress or resize the file before sending.`
            );
          }

          media = MessageMedia.fromFilePath(filePath);

          // Log media info for debugging large file issues
          const base64SizeMB = (media.data.length / 1024 / 1024).toFixed(1);
          console.log(`[WhatsApp] Sending ${type} media: ${filePath} (${base64SizeMB}MB base64)`);
        }

        // Build send options based on media type
        const sendOptions = { caption: content };
        if (type === "video") {
          sendOptions.sendVideoAsGif = false;
        }

        try {
          result = await clientData.client.sendMessage(chatId, media, sendOptions);
        } catch (sendErr) {
          const errMsg = sendErr && sendErr.message ? sendErr.message : String(sendErr);
          // whatsapp-web.js has a known bug where media can throw "Evaluation failed"
          // Retry as document as last resort
          if (errMsg.includes("Evaluation failed")) {
            console.warn(`[WhatsApp] Media send failed for ${chatId}, retrying as document...`);
            try {
              const docOptions = { caption: content, sendMediaAsDocument: true };
              result = await clientData.client.sendMessage(chatId, media, docOptions);
              console.log(`[WhatsApp] Sent as document to ${chatId}`);
            } catch (docErr) {
              throw sendErr;
            }
          } else {
            throw sendErr;
          }
        }
      }

      console.log(`[WhatsApp] Message sent to ${chatId} (type: ${type || "text"})`);

      await db.insert(schema.messages).values({
        userId,
        sessionId,
        phone: chatId,
        type: type || "text",
        content,
        mediaUrl,
        interactiveData: interactiveData ? JSON.stringify(interactiveData) : null,
        status: "sent",
        sentAt: new Date(),
      });

      return result;
    } catch (error) {
      const errMsg = error && error.message ? error.message : String(error);
      console.error(`[WhatsApp] sendMessage failed for ${chatId}:`, errMsg);
      if (error && error.stack) console.error(`[WhatsApp] Stack:`, error.stack);

      await db.insert(schema.messages).values({
        userId,
        sessionId,
        phone: chatId,
        type: type || "text",
        content,
        mediaUrl,
        interactiveData: interactiveData ? JSON.stringify(interactiveData) : null,
        status: "failed",
        errorMessage: errMsg,
      });

      throw error;
    }
  }

  checkRateLimit(userId) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 30;

    let limit = this.rateLimits.get(userId);

    if (!limit || now > limit.resetTime) {
      limit = { count: 1, resetTime: now + windowMs };
      this.rateLimits.set(userId, limit);
      return true;
    }

    if (limit.count >= maxRequests) {
      return false;
    }

    limit.count++;
    return true;
  }

  async disconnectSession(sessionId, preserveAuth = false) {
    const sessionRows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!sessionRows.length) return;

    const userId = sessionRows[0].userId;
    const clientId = `${userId}_${sessionId}`;
    this.userDisconnected.add(clientId); // Mark as user-initiated
    const clientData = this.clients.get(clientId);

    if (clientData) {
      try {
        // Force-kill browser process to prevent "already running" lock errors
        const browser = clientData.client.pupBrowser;
        if (browser && browser.process && browser.process()) {
          try {
            browser.process().kill("SIGKILL");
            console.log(`[${clientId}] Browser process killed via SIGKILL`);
          } catch (killErr) {
            console.error(`[${clientId}] Failed to kill browser process:`, killErr.message);
          }
        }
        // Give the OS a moment to release the process
        await new Promise(r => setTimeout(r, 500));
        await clientData.client.destroy();
      } catch (e) {
        console.error(`[${clientId}] Error destroying client:`, e.message);
      }
      this.clients.delete(clientId);
    }

    this.qrCodes.delete(clientId);
    this.sessionStatus.delete(clientId);
    this._stopHeartbeat(clientId);

    try {
      await db.update(schema.whatsappSessions)
        .set({ status: "disconnected" })
        .where(eq(schema.whatsappSessions.id, sessionId));
    } catch (err) {
      console.error(`[${clientId}] DB update error:`, err.message);
    }

    // Only clean auth if explicitly requested (preserve for reconnects)
    if (!preserveAuth) {
      await this._cleanupAuth(clientId);
    }
  }

  /**
   * Send email notification to user when their WhatsApp session connects
   */
  async _notifyUserOfConnect(userId, sessionName, phoneNumber) {
    try {
      const users = await db.select({ email: schema.users.email, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, userId));

      if (!users.length) return;
      const user = users[0];
      if (!user.email) return;

      const displayPhone = phoneNumber ? `+${phoneNumber}` : "Unknown";

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #d1fae5;border-radius:16px;">
          <div style="text-align:center;margin-bottom:20px;">
            <h2 style="color:#10b981;margin:0;">ParroByte CRM</h2>
            <p style="color:#666;margin:5px 0 0;">WhatsApp Session Alert</p>
          </div>
          <p style="color:#333;">Hi ${user.name || "there"},</p>
          <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px;margin:20px 0;">
            <p style="color:#059669;margin:0;font-weight:bold;">
              <i style="font-style:normal;margin-right:6px;">&#x2705;</i>
              Session Connected: ${sessionName}
            </p>
            <p style="color:#065f46;margin:8px 0 0;font-size:13px;">
              Phone Number: <strong>${displayPhone}</strong><br>
              Time: ${new Date().toLocaleString()}
            </p>
          </div>
          <p style="color:#333;">Your WhatsApp session is now active and ready to send/receive messages.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${process.env.APP_URL || 'http://localhost:3000'}/sessions"
               style="background:#10b981;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
              Go to Sessions
            </a>
          </div>
          <hr style="border:none;border-top:1px solid #d1fae5;margin:20px 0;">
          <p style="color:#999;font-size:12px;text-align:center;">ParroByte CRM &copy; ${new Date().getFullYear()}</p>
        </div>
      `;

      await sendTestEmail(user.email, `WhatsApp Session Connected: ${sessionName}`, html);
      console.log(`[Notify] Connect email sent to ${user.email} for session ${sessionName}`);
    } catch (err) {
      console.error("[Notify] Failed to send connect email:", err.message);
    }
  }

  /**
   * Send email notification to user when their WhatsApp session disconnects
   */
  async _notifyUserOfDisconnect(userId, sessionId, sessionName, reason) {
    try {
      // Check if we already sent an alert for this session recently (avoid spam)
      const sessionRows = await db.select({ disconnectAlertSent: schema.whatsappSessions.disconnectAlertSent })
        .from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, sessionId));

      if (sessionRows.length && sessionRows[0].disconnectAlertSent) {
        console.log(`[Notify] Skipping disconnect email for ${sessionName} — already sent`);
        return;
      }

      // Get user email
      const users = await db.select({ email: schema.users.email, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, userId));

      if (!users.length) return;
      const user = users[0];
      if (!user.email) return;

      // Determine if disconnect was from WhatsApp side or app side
      const isAppSide = reason && (
        reason.includes("restart") ||
        reason.includes("server") ||
        reason.includes("shutdown") ||
        reason.includes("destroy")
      );
      const disconnectSource = isAppSide ? "Application" : "WhatsApp";
      const actionText = isAppSide
        ? "Your session was disconnected due to a server restart. Please log in and click <strong>Reconnect</strong> on your session to restore it."
        : "Your WhatsApp session was disconnected. This usually happens when you log out from WhatsApp on your phone or your phone loses internet connection.";

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #fce7f3;border-radius:16px;">
          <div style="text-align:center;margin-bottom:20px;">
            <h2 style="color:#ec4899;margin:0;">ParroByte CRM</h2>
            <p style="color:#666;margin:5px 0 0;">WhatsApp Session Alert</p>
          </div>
          <p style="color:#333;">Hi ${user.name || "there"},</p>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;margin:20px 0;">
            <p style="color:#dc2626;margin:0;font-weight:bold;">
              <i style="font-style:normal;margin-right:6px;">&#x26A0;</i>
              Session Disconnected: ${sessionName}
            </p>
            <p style="color:#991b1b;margin:8px 0 0;font-size:13px;">
              Source: <strong>${disconnectSource}</strong><br>
              Reason: ${reason}
            </p>
          </div>
          <p style="color:#333;">${actionText}</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${process.env.APP_URL || 'http://localhost:3000'}/sessions"
               style="background:#ec4899;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
              Go to Sessions
            </a>
          </div>
          <p style="color:#666;font-size:12px;">If you did not expect this disconnect, please check your phone's WhatsApp connection.</p>
          <hr style="border:none;border-top:1px solid #fce7f3;margin:20px 0;">
          <p style="color:#999;font-size:12px;text-align:center;">ParroByte CRM &copy; ${new Date().getFullYear()}</p>
        </div>
      `;

      await sendTestEmail(user.email, `WhatsApp Session Disconnected: ${sessionName}`, html);
      console.log(`[Notify] Disconnect email sent to ${user.email} for session ${sessionName}`);

      // Mark alert sent so we don't spam
      try {
        await db.update(schema.whatsappSessions)
          .set({ disconnectAlertSent: true })
          .where(eq(schema.whatsappSessions.id, sessionId));
      } catch (e) {}
    } catch (err) {
      console.error("[Notify] Failed to send disconnect email:", err.message);
    }
  }

  /**
   * Start a heartbeat interval to keep the WhatsApp session alive.
   * Prevents idle disconnect by periodically checking state.
   */
  _startHeartbeat(clientId, client) {
    // Clear any existing heartbeat for this client
    this._stopHeartbeat(clientId);

    const intervalId = setInterval(async () => {
      try {
        const state = await client.getState();
        if (state !== "CONNECTED") {
          console.log(`[${clientId}] Heartbeat detected non-connected state: ${state}`);
        }
      } catch (err) {
        // getState may fail if client is disconnecting — ignore
        console.log(`[${clientId}] Heartbeat check failed:`, err.message);
      }
    }, 60000); // Every 60 seconds

    if (!this._heartbeats) this._heartbeats = new Map();
    this._heartbeats.set(clientId, intervalId);
    console.log(`[${clientId}] Heartbeat started (60s interval)`);
  }

  /**
   * Stop the heartbeat interval for a client.
   */
  _stopHeartbeat(clientId) {
    if (!this._heartbeats) return;
    const intervalId = this._heartbeats.get(clientId);
    if (intervalId) {
      clearInterval(intervalId);
      this._heartbeats.delete(clientId);
      console.log(`[${clientId}] Heartbeat stopped`);
    }
  }

  /**
   * Gracefully destroy all active WhatsApp clients.
   * Call this before server shutdown to preserve auth data.
   */
  async gracefulShutdown() {
    console.log(`[WhatsAppManager] Graceful shutdown: destroying ${this.clients.size} client(s)...`);
    this._shuttingDown = true;

    // Remember which sessions were active so we can mark them for restore
    const activeSessionIds = [];
    for (const [clientId, clientData] of this.clients.entries()) {
      activeSessionIds.push(clientData.sessionId);
    }

    const promises = [];
    for (const [clientId, clientData] of this.clients.entries()) {
      promises.push(
        (async () => {
          try {
            await clientData.client.destroy();
            console.log(`[${clientId}] Client destroyed cleanly`);
          } catch (e) {
            console.error(`[${clientId}] Error during destroy:`, e.message);
          }
        })()
      );
    }
    await Promise.allSettled(promises);
    this.clients.clear();
    this.qrCodes.clear();
    this.sessionStatus.clear();
    // Clear all heartbeats
    if (this._heartbeats) {
      for (const [cid, intervalId] of this._heartbeats.entries()) {
        clearInterval(intervalId);
      }
      this._heartbeats.clear();
    }

    // Mark previously active sessions as "connecting" so restoreAllSessions
    // will pick them up on next startup. Don't mark as "disconnected".
    if (activeSessionIds.length > 0) {
      try {
        for (const sid of activeSessionIds) {
          await db.update(schema.whatsappSessions)
            .set({ status: "connecting", qrCode: null })
            .where(eq(schema.whatsappSessions.id, sid));
        }
        console.log(`[WhatsAppManager] Marked ${activeSessionIds.length} session(s) as connecting for next restore`);
      } catch (dbErr) {
        console.error("[WhatsAppManager] Failed to mark sessions for restore:", dbErr.message);
      }
    }

    this._shuttingDown = false;
    console.log("[WhatsAppManager] All clients destroyed. Shutdown complete.");
  }

  /**
   * Check if a session has valid LocalAuth data on disk.
   * Looks for the session directory and key files.
   */
  async _hasAuthData(clientId) {
    try {
      const authPath = path.join(AUTH_DIR, clientId);
      const stat = await fs.stat(authPath);
      if (!stat.isDirectory()) return false;
      // Check for Chrome profile data (Local State is always present in a valid profile)
      const localState = path.join(authPath, "session", "Local State");
      await fs.access(localState);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Restore all previously connected sessions on server startup.
   * Uses LocalAuth to reconnect without QR scan if auth data is valid.
   * 
   * Now restores ANY session that has auth data on disk, not just those
   * with DB status "connected". This fixes the issue where graceful
   * shutdown marks sessions as "disconnected" in the DB.
   */
  async restoreAllSessions() {
    try {
      // Get all sessions that are NOT currently in memory
      // Include "connected", "connecting", and "disconnected" (with auth check)
      const connectedSessions = await db.select().from(schema.whatsappSessions)
        .where(
          eq(schema.whatsappSessions.status, "connected")
        );

      const connectingSessions = await db.select().from(schema.whatsappSessions)
        .where(
          eq(schema.whatsappSessions.status, "connecting")
        );

      const qrReadySessions = await db.select().from(schema.whatsappSessions)
        .where(
          eq(schema.whatsappSessions.status, "qr_ready")
        );

      // Also check for sessions that were marked disconnected but still have auth data
      const disconnectedSessions = await db.select().from(schema.whatsappSessions)
        .where(
          eq(schema.whatsappSessions.status, "disconnected")
        );

      const sessionsToRestore = [];

      // Always restore "connected", "connecting", and "qr_ready" sessions
      for (const s of connectedSessions) {
        const clientId = `${s.userId}_${s.id}`;
        if (!this.clients.has(clientId)) {
          sessionsToRestore.push(s);
        }
      }
      for (const s of connectingSessions) {
        const clientId = `${s.userId}_${s.id}`;
        if (!this.clients.has(clientId)) {
          sessionsToRestore.push(s);
        }
      }
      for (const s of qrReadySessions) {
        const clientId = `${s.userId}_${s.id}`;
        if (!this.clients.has(clientId)) {
          sessionsToRestore.push(s);
        }
      }

      // Also restore "disconnected" sessions if they have auth data
      // (they were likely disconnected by a server restart)
      for (const s of disconnectedSessions) {
        const clientId = `${s.userId}_${s.id}`;
        if (!this.clients.has(clientId)) {
          const hasAuth = await this._hasAuthData(clientId);
          if (hasAuth) {
            sessionsToRestore.push(s);
          }
        }
      }

      // Remove duplicates
      const uniqueSessions = [];
      const seen = new Set();
      for (const s of sessionsToRestore) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          uniqueSessions.push(s);
        }
      }

      if (!uniqueSessions.length) {
        console.log("[Restore] No sessions with auth data to restore");
        return;
      }

      console.log(`[Restore] Attempting to restore ${uniqueSessions.length} session(s)...`);
      let restored = 0;
      let failed = 0;

      for (let i = 0; i < uniqueSessions.length; i++) {
        const session = uniqueSessions[i];
        const clientId = `${session.userId}_${session.id}`;
        const authPath = path.join(AUTH_DIR, clientId);

        // Stagger session restores to prevent concurrent Chromium conflicts
        if (i > 0) {
          await new Promise(r => setTimeout(r, 5000));
        }

        // Clean stale Chrome lock files before restore attempt
        const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
        for (const lock of lockFiles) {
          for (const lockDir of [authPath, path.join(authPath, "session")]) {
            try {
              await fs.unlink(path.join(lockDir, lock));
              console.log(`[Restore] Cleaned stale lock: ${lock} for ${clientId}`);
            } catch (e) {
              // Lock file may not exist — ignore
            }
          }
        }

        try {
          console.log(`[Restore] Restoring session ${session.id} (${session.sessionName}) for user ${session.userId}`);
          await this.createSession(session.userId, session.sessionName, session.id);
          restored++;
        } catch (err) {
          console.error(`[Restore] Failed to restore session ${session.id}:`, err.message);
          failed++;

          // If auth failed or data is corrupted, clean auth so next attempt uses QR
          // NOTE: "browser already running" is NOT an auth error — don't delete auth
          const errMsg = err.message || "";
          const isAuthError =
            (errMsg.includes("auth") || errMsg.includes("Auth") || errMsg.includes("LOGOUT")) &&
            !errMsg.includes("already running");
          if (isAuthError) {
            console.log(`[Restore] Auth error for session ${session.id} — clearing auth data`);
            await this._cleanupAuth(clientId);
          }

          // Mark as disconnected since restore failed
          try {
            await db.update(schema.whatsappSessions)
              .set({ status: "disconnected", qrCode: null })
              .where(eq(schema.whatsappSessions.id, session.id));
          } catch (dbErr) {}
        }
      }

      console.log(`[Restore] Complete: ${restored} restored, ${failed} failed`);
    } catch (err) {
      console.error("[Restore] Error during session restore:", err.message);
    }
  }

  getSessionStatus(sessionId, userId) {
    const clientId = `${userId}_${sessionId}`;
    const client = this.clients.get(clientId);
    let phoneNumber = null;
    try {
      if (client && client.info && client.info.wid) {
        phoneNumber = client.info.wid.user;
      }
    } catch (e) {}
    return {
      status: this.sessionStatus.get(clientId) || "disconnected",
      qrCode: this.qrCodes.get(clientId) || null,
      phoneNumber: phoneNumber,
    };
  }

  async reconnectSession(sessionId) {
    const sessionRows = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));

    if (!sessionRows.length) throw new Error("Session not found");

    const s = sessionRows[0];
    const clientId = `${s.userId}_${sessionId}`;

    // If already connected, no-op
    if (this.clients.has(clientId)) {
      console.log(`[${clientId}] Already connected, skipping reconnect`);
      return s;
    }

    // Preserve auth data so LocalAuth can restore without QR scan
    await this.disconnectSession(sessionId, true);

    // Clean Chrome lock files that may linger after force-kill
    const authPath = path.join(AUTH_DIR, clientId);
    const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    for (const lock of lockFiles) {
      for (const lockDir of [authPath, path.join(authPath, "session")]) {
        try {
          await fs.unlink(path.join(lockDir, lock));
          console.log(`[${clientId}] Cleaned lock file: ${lock}`);
        } catch (e) {
          // Lock file may not exist — ignore
        }
      }
    }

    // Wait for puppeteer browser to fully shut down before creating new client
    console.log(`[${clientId}] Waiting 5s for browser cleanup before reconnect...`);
    await new Promise(r => setTimeout(r, 5000));

    return await this.createSession(s.userId, s.sessionName, sessionId);
  }
}

export default WhatsAppManager;
