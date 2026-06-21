import dotenv from "dotenv";
dotenv.config();

import express from "express";
import expressLayouts from "express-ejs-layouts";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import session from "express-session";
import cookieParser from "cookie-parser";
import flash from "connect-flash";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fileUpload from "express-fileupload";
import cors from "cors";
import cron from "node-cron";
import { db } from "./server/lib/db.js";
import { eq, and, lte, inArray } from "drizzle-orm";
import * as schema from "./db/schema.js";

// Routes
import authRoutes from "./server/routes/auth.js";
import dashboardRoutes from "./server/routes/dashboard.js";
import sessionRoutes from "./server/routes/sessions.js";
import contactRoutes from "./server/routes/contacts.js";
import templateRoutes from "./server/routes/templates.js";
import messageRoutes from "./server/routes/messages.js";
import scheduleRoutes from "./server/routes/schedule.js";
import autoReplyRoutes from "./server/routes/autoReply.js";
import apiKeyRoutes from "./server/routes/apiKeys.js";
import webhookRoutes from "./server/routes/webhooks.js";
import adminRoutes from "./server/routes/admin.js";
import developerRoutes from "./server/routes/developer.js";
import helpRoutes from "./server/routes/help.js";
import formRoutes from "./server/routes/forms.js";
import leadRoutes from "./server/routes/leads.js";
import scraperRoutes from "./server/routes/scraper.js";
import bulkRoutes from "./server/routes/bulk.js";
import apiPollRoutes from "./server/routes/apiPolls.js";
import pollResultsRoutes from "./server/routes/pollResults.js";
import pollAutoResponseRoutes from "./server/routes/pollAutoResponses.js";
import billingRoutes from "./server/routes/billing.js";
import paymentRoutes from "./server/routes/payments.js";
import landingEnquiryRoutes from "./server/routes/landingEnquiries.js";
import emailRoutes, { processScheduledEmails } from "./server/routes/email.js";
import aiConfigRoutes from "./server/routes/aiConfig.js";
import socialAutomationRoutes from "./server/routes/socialAutomation.js";
import enterpriseRoutes from "./server/routes/enterprise.js";

import facebookRoutes from "./server/routes/facebook.js";
import leadUrlRoutes from "./server/routes/leadUrls.js";
import youtubeRoutes from "./server/routes/youtube.js";
import instagramRoutes from "./server/routes/instagram.js";
import metaWhatsappRoutes from "./server/routes/metaWhatsApp.js";
import questionnaireRoutes from "./server/routes/questionnaires.js";
import feedbackRoutes from "./server/routes/feedback.js";

// WhatsApp Manager
import WhatsAppManager from "./whatsapp/manager.js";

// AI Queue Processor
import { startAiQueueProcessor, stopAiQueueProcessor } from "./server/lib/aiQueueProcessor.js";

import { seedCreditConfigs, getUserCredits, getAllCreditConfigs, getVisibleServices, getUserActiveSubscription, checkCredits, chargeCredits, deductCredits } from "./server/lib/credits.js";
import { processAllUsers as processYouTubeComments } from "./server/lib/youtube.js";
import { processAllUsers as processInstagramComments, handleWebhookPayload } from "./server/lib/instagram.js";
import { handleWebhookDm, handleWebhookComment, refreshAllTokens } from "./server/lib/instagramAutomation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== PROCESS-LEVEL CRASH PROTECTION =====
// Puppeteer + whatsapp-web.js can throw unhandled errors that crash Node.
// These handlers prevent the server from going down.
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught Exception:", err.message);
  console.error(err.stack);
  // DO NOT exit - keep the server running
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRITICAL] Unhandled Rejection at:", promise, "reason:", reason);
  // DO NOT exit - keep the server running
});

const app = express();
app.set("trust proxy", 1); // Required: app runs behind nginx on VPS
const PORT = process.env.PORT || 4000;

// WhatsApp Manager instance
const waManager = new WhatsAppManager();

// Per-user last API send time tracker (developer API 30s gap enforcement)
const apiLastSendTime = new Map(); // userId -> timestamp

// Security middleware - CSP allows inline scripts for EJS templates
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://*.razorpay.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      connectSrc: ["'self'", "https://*.razorpay.com", "wss://*.razorpay.com"],
      frameSrc: ["'self'", "https://*.razorpay.com"],
      frameAncestors: ["'self'", "https://*.razorpay.com"],
    },
  },
  referrerPolicy: {
    policy: "strict-origin-when-cross-origin",
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));

// Permissions-Policy: allow Razorpay checkout sensors & payment features
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(self), camera=(self), geolocation=(self), gyroscope=(self), magnetometer=(self), microphone=(self), payment=(self \"https://checkout.razorpay.com\"), usb=(self)"
  );
  next();
});

// Rate limiting - general protection
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Stricter rate limiting for auth routes (brute force protection)
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 attempts per 5 minutes
  message: "Too many authentication attempts. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
app.use("/auth/login", authLimiter);
app.use("/auth/register", authLimiter);
app.use("/auth/forgot-password", authLimiter);
app.use("/auth/verify-otp", authLimiter);
app.use("/auth/verify-login-otp", authLimiter);
app.use("/auth/resend-otp", authLimiter);
app.use("/auth/resend-login-otp", authLimiter);

// Public endpoint rate limiting (spam protection)
const publicLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: "Too many requests. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/landing/submit", publicLimiter);
app.use("/enterprise", publicLimiter);
app.use("/email/incoming", publicLimiter);
app.use("/api/lead-url", publicLimiter);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());
app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 200 * 1024 * 1024 },
  abortOnLimit: true,
  responseOnLimit: "File size limit exceeded. Max allowed is 200MB.",
}));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || "whatsapp-crm-secret-key-2024",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: "lax",
  },
}));

app.use(flash());

// Static files
app.use(express.static(path.join(__dirname, "public")));

// EJS setup
app.use(expressLayouts);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("layout", "layout");

// Global middleware for auth and flash messages
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  res.locals.info = req.flash("info");
  res.locals.warnings = req.flash("warning");
  res.locals.path = req.path;
  res.locals.baseUrl = `${req.protocol}://${req.get('host')}`;
  res.locals.year = new Date().getFullYear();
  res.locals.themeColor = req.session.user?.themeColor || "#ec4899";

  // ===== CREDITS: inject credit balance, subscription, and visible services =====
  if (req.session.user) {
    try {
      res.locals.planFeatures = {}; // kept for sidebar compat
      res.locals.creditBalance = await getUserCredits(req.session.user.id);
      res.locals.creditConfigs = await getAllCreditConfigs();
      res.locals.visibleServices = await getVisibleServices();
      res.locals.activeSubscription = await getUserActiveSubscription(req.session.user.id);
    } catch (e) {
      res.locals.planFeatures = {};
      res.locals.creditBalance = 0;
      res.locals.visibleServices = new Set();
      res.locals.activeSubscription = null;
    }
  } else {
    res.locals.planFeatures = {};
    res.locals.visibleServices = new Set();
    res.locals.activeSubscription = null;
  }

  // Expose Razorpay key ID to frontend for checkout
  res.locals.razorpayKeyId = process.env.RAZORPAY_KEY_ID || "";

  // ===== SINGLE LOGIN ENFORCEMENT =====
  // If user is logged in, verify their session token matches DB
  if (req.session.user && req.session.user._token) {
    try {
      const rows = await db.select({ sessionToken: schema.users.sessionToken }).from(schema.users)
        .where(eq(schema.users.id, req.session.user.id));

      // If DB token doesn't match session token, force logout
      if (rows.length && rows[0].sessionToken !== req.session.user._token) {
        console.log(`[SingleLogin] User ${req.session.user.id} logged in elsewhere. Invalidating old session.`);
        req.session.destroy();
        req.flash("error", "You have been logged out because you logged in from another device.");
        return res.redirect("/auth/login");
      }
    } catch (err) {
      console.error("[SingleLogin] Check error:", err.message);
    }
  }

  next();
});

// Auth middleware
export function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.flash("error", "Please login to access this page");
    return res.redirect("/auth/login");
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    req.flash("error", "Admin access required");
    return res.redirect("/dashboard");
  }
  next();
}

// CORS for public API routes (lead URLs, push/pull APIs)
app.use("/api", cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// Make waManager available to routes
app.use((req, res, next) => {
  req.waManager = waManager;
  next();
});

// Routes - each protected route also checks plan features
app.use("/auth", authRoutes);
app.use("/dashboard", requireAuth, dashboardRoutes);
app.use("/sessions", requireAuth, sessionRoutes);
app.use("/contacts", requireAuth, contactRoutes);
app.use("/templates", requireAuth, templateRoutes);
app.use("/messages", requireAuth, messageRoutes);
app.use("/schedule", requireAuth, scheduleRoutes);
app.use("/auto-reply", requireAuth, autoReplyRoutes);
app.use("/api-keys", requireAuth, apiKeyRoutes);
app.use("/webhooks", requireAuth, webhookRoutes);
app.use("/admin", requireAuth, requireAdmin, adminRoutes);
app.use("/developer", requireAuth, developerRoutes);
app.use("/help", requireAuth, helpRoutes);
app.use("/forms", (req, res, next) => {
  if (req.path.startsWith("/p/")) return next();
  requireAuth(req, res, next);
}, formRoutes);
app.use("/leads", requireAuth, leadRoutes);
app.use("/scraper", requireAuth, scraperRoutes);
app.use("/bulk", requireAuth, bulkRoutes);
app.use("/polls", requireAuth, pollResultsRoutes);
app.use("/poll-auto-responses", requireAuth, pollAutoResponseRoutes);
app.use("/api/polls", apiPollRoutes);
app.use("/billing", requireAuth, billingRoutes);
app.use("/payments", requireAuth, paymentRoutes);
app.use("/landing", landingEnquiryRoutes);
app.use("/email", requireAuth, emailRoutes);
app.use("/ai-config", requireAuth, aiConfigRoutes);
app.use("/social-automation", requireAuth, socialAutomationRoutes);
app.use("/youtube", requireAuth, youtubeRoutes);

// Instagram webhook routes (public - Meta sends without session)
app.get("/instagram/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expectedToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;

  if (!expectedToken) {
    console.error("[Instagram Webhook] Verify token not configured");
    return res.status(500).send("Webhook verify token not configured");
  }

  if (mode === "subscribe" && token === expectedToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Instagram webhook events
app.post("/instagram/webhook", express.json(), async (req, res) => {
  try {
    const body = req.body;
    console.log("[Instagram Webhook] POST received. Object:", body?.object, "entries:", body?.entry?.length || 0);
    res.status(200).send("EVENT_RECEIVED");

    setImmediate(async () => {
      try {
        if (body.object !== "instagram" && body.object !== "page") return;

        for (const entry of body.entry || []) {
          const recipientId = entry.id;

          // Handle messaging events (DMs)
          if (entry.messaging && entry.messaging.length > 0) {
            for (const messagingEvent of entry.messaging) {
              try {
                await handleWebhookDm(messagingEvent, recipientId);
              } catch (err) {
                console.error("[Instagram Webhook] DM error:", err.message);
              }
            }
          }

          // Handle changes events (comments, mentions)
          if (entry.changes && entry.changes.length > 0) {
            for (const change of entry.changes) {
              try {
                if (change.value?.item === "comment" || change.field === "mentions") {
                  await handleWebhookComment(change.value);
                }
              } catch (err) {
                console.error("[Instagram Webhook] Comment error:", err.message);
              }
            }
          }
        }
      } catch (err) {
        console.error("[Instagram Webhook] Processing error:", err.message);
      }
    });
  } catch (error) {
    res.status(200).send("EVENT_RECEIVED");
  }
});

app.use("/instagram", requireAuth, instagramRoutes);
app.use("/social-automation/facebook", requireAuth, facebookRoutes);
app.use("/enterprise", enterpriseRoutes);
app.use("/lead-urls", requireAuth, leadUrlRoutes);
// Meta WhatsApp API: webhook endpoints are public (Meta sends without session cookie)
// The route handler itself verifies webhook signatures and ownership
app.use("/meta-whatsapp", metaWhatsappRoutes);
app.use("/questionnaires", requireAuth, questionnaireRoutes);
app.use("/feedback", feedbackRoutes);

// Privacy Policy page (needed for Meta/Facebook app verification)
app.get("/privacy", async (req, res) => {
  res.render("pages/privacy", { title: "Privacy Policy - ParroByte CRM" });
});

// Terms & Conditions page
app.get("/terms", async (req, res) => {
  res.render("pages/terms", { title: "Terms & Conditions - ParroByte CRM" });
});

// Home route
app.get("/", async (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  try {
    const creditConfigs = await getAllCreditConfigs();
    const servicePackages = await db.select().from(schema.servicePackages)
      .where(eq(schema.servicePackages.isActive, true))
      .orderBy(schema.servicePackages.sortOrder);
    const subscriptionPlans = await db.select().from(schema.subscriptionPlans)
      .where(eq(schema.subscriptionPlans.isActive, true))
      .orderBy(schema.subscriptionPlans.sortOrder);
    res.render("pages/landing", {
      title: "ParroByte CRM - Home",
      creditConfigs,
      servicePackages,
      subscriptionPlans,
    });
  } catch (e) {
    res.render("pages/landing", { title: "ParroByte CRM - Home" });
  }
});

const execAsync = promisify(exec);

// ── Health & Monitoring Endpoints ──
app.get("/health", async (req, res) => {
  const os = await import("os");
  const freeMemPercent = (os.freemem() / os.totalmem()) * 100;
  const loadAvg = os.loadavg();
  const sessionCount = req.waManager ? req.waManager.clients.size : 0;
  const maxSessions = req.waManager ? req.waManager.getMaxSessions() : 0;

  res.json({
    status: freeMemPercent < 5 ? "critical" : freeMemPercent < 15 ? "warning" : "healthy",
    uptime: process.uptime(),
    memory: {
      totalGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
      freeGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(1),
      freePercent: freeMemPercent.toFixed(1),
    },
    cpu: {
      load1m: loadAvg[0].toFixed(2),
      load5m: loadAvg[1].toFixed(2),
      cores: os.cpus().length,
    },
    whatsapp: {
      activeSessions: sessionCount,
      maxSessions,
    },
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

// Queue stats (admin only)
app.get("/api/queue-stats", requireAuth, async (req, res) => {
  try {
    const { getQueueStats } = await import("./server/lib/queue.js");
    const stats = await getQueueStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upload recorded audio from browser mic (converts to MP3 for maximum WhatsApp compatibility)
app.post("/uploads/audio", requireAuth, async (req, res) => {
  try {
    console.log("[Upload Audio] Request received. Files keys:", Object.keys(req.files || {}));
    if (!req.files || !req.files.audio) {
      console.error("[Upload Audio] No req.files.audio present");
      return res.status(400).json({ success: false, error: "No audio file received" });
    }
    const audio = req.files.audio;
    console.log("[Upload Audio] Received file:", audio.name, "size:", audio.size, "mimetype:", audio.mimetype);
    const maxSizeMB = 150;
    if (audio.size > maxSizeMB * 1024 * 1024) {
      return res.status(400).json({ success: false, error: `Audio too large (${(audio.size / 1024 / 1024).toFixed(1)}MB). Max ${maxSizeMB}MB.` });
    }
    const uploadDir = path.join(process.cwd(), "public/uploads/media");
    await fs.mkdir(uploadDir, { recursive: true });

    const timestamp = Date.now();
    const tempFile = path.join(uploadDir, `tmp_${timestamp}_${audio.name || 'audio'}`);
    const outFile = `audio_${timestamp}.mp3`;
    const outPath = path.join(uploadDir, outFile);

    // Save uploaded file to temp location
    await audio.mv(tempFile);
    console.log("[Upload Audio] Saved temp file:", tempFile);

    // Convert to MP3 using ffmpeg for maximum WhatsApp compatibility
    try {
      const cmd = `ffmpeg -fflags +genpts -i "${tempFile}" -map 0:a:0 -c:a libmp3lame -b:a 128k -ac 1 -ar 44100 -y "${outPath}"`;
      console.log("[Upload Audio] Running:", cmd);
      await execAsync(cmd);
      await fs.unlink(tempFile);
      console.log(`[Upload Audio] Converted to MP3: ${outFile}`);
    } catch (ffmpegErr) {
      console.warn(`[Upload Audio] ffmpeg MP3 conversion failed, trying M4A fallback:`, ffmpegErr.message || ffmpegErr);
      // Fallback: try AAC M4A
      const fallbackFile = `audio_${timestamp}.m4a`;
      const fallbackPath = path.join(uploadDir, fallbackFile);
      try {
        await execAsync(`ffmpeg -fflags +genpts -i "${tempFile}" -map 0:a:0 -c:a aac -b:a 128k -ac 1 -ar 44100 -y "${fallbackPath}"`);
        await fs.unlink(tempFile);
        res.json({ success: true, mediaUrl: `/uploads/media/${fallbackFile}`, fileName: fallbackFile });
        return;
      } catch (aacErr) {
        console.warn(`[Upload Audio] AAC fallback also failed, using original:`, aacErr.message || aacErr);
        await fs.rename(tempFile, outPath.replace('.mp3', '.ogg'));
        res.json({ success: true, mediaUrl: `/uploads/media/audio_${timestamp}.ogg`, fileName: `audio_${timestamp}.ogg` });
        return;
      }
    }

    res.json({ success: true, mediaUrl: `/uploads/media/${outFile}`, fileName: outFile });
  } catch (err) {
    console.error("[Upload Audio] Error:", err.message || err);
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// ============================================================
// PUBLIC API ENDPOINTS (No session auth required)
// ============================================================

// Helper: Authenticate via Bearer token API key
async function authenticateApiKey(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: "Missing or invalid Authorization header. Use: Bearer <apiKey>", status: 401 };

  const apiKey = match[1];
  const keyData = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.apiKey, apiKey));

  if (!keyData.length || !keyData[0].isActive) {
    return { error: "Invalid or revoked API key", status: 401 };
  }

  // Update last used timestamp
  try {
    await db.update(schema.apiKeys)
      .set({ lastUsed: new Date() })
      .where(eq(schema.apiKeys.id, keyData[0].id));
  } catch (e) {}

  return { userId: keyData[0].userId, apiKeyId: keyData[0].id, sessionId: keyData[0].sessionId };
}

// API: Send WhatsApp message via API key
// POST /api/messages/send
// Headers: Authorization: Bearer <apiKey>
// Body (JSON): { phone: "919876543210", message: "Hello", type: "text", mediaUrl: "https://...", sessionId: optional }
// Body (multipart): phone=...&message=...&type=image&mediaFile=@file.jpg
app.post("/api/messages/send", async (req, res) => {
  try {
    // 1. Authenticate via API key
    const auth = await authenticateApiKey(req);
    if (auth.error) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    const { userId, sessionId: apiKeySessionId } = auth;
    const { phone, message, type, mediaUrl, sessionId } = req.body;

    // Handle file upload (multipart/form-data)
    let finalMediaUrl = mediaUrl || null;
    if (req.files && req.files.mediaFile) {
      const uploadedFile = req.files.mediaFile;
      const maxSizeMB = 150;
      if (uploadedFile.size > maxSizeMB * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: `File too large (${(uploadedFile.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed is ${maxSizeMB}MB.`
        });
      }
      const uploadDir = path.join(process.cwd(), "public", "uploads", "media");
      if (!existsSync(uploadDir)) {
        mkdirSync(uploadDir, { recursive: true });
      }
      const safeName = `${Date.now()}_${uploadedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const savePath = path.join(uploadDir, safeName);
      await uploadedFile.mv(savePath);
      finalMediaUrl = path.join("/uploads", "media", safeName);
    }

    // 2. Validate required fields
    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, error: "Phone number is required" });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: "Message is required" });
    }

    // 3. Find WhatsApp session
    // Priority: 1) Request body sessionId, 2) API key's default session, 3) Shared admin session, 4) First connected session
    let targetSessionId = sessionId ? parseInt(sessionId) : null;

    if (!targetSessionId && apiKeySessionId) {
      targetSessionId = apiKeySessionId;
    }

    if (!targetSessionId) {
      // Check for shared admin session first
      const sharedSessions = await db.select().from(schema.whatsappSessions)
        .where(and(
          eq(schema.whatsappSessions.isShared, true),
          eq(schema.whatsappSessions.status, "connected")
        ));
      if (sharedSessions.length) {
        targetSessionId = sharedSessions[0].id;
      }
    }

    if (!targetSessionId) {
      // Auto-select the first connected session for this user
      const sessions = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.userId, userId));

      const connectedSession = sessions.find(s => s.status === "connected");
      if (!connectedSession) {
        return res.status(400).json({
          success: false,
          error: "No connected WhatsApp session found. Please connect a session first or specify sessionId."
        });
      }
      targetSessionId = connectedSession.id;
    }

    // 4. Verify session belongs to user (or is shared) and is connected
    const sessionCheck = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, targetSessionId));

    if (!sessionCheck.length || (sessionCheck[0].userId !== userId && !sessionCheck[0].isShared)) {
      return res.status(403).json({ success: false, error: "Session not found or does not belong to your account" });
    }

    if (sessionCheck[0].status !== "connected") {
      return res.status(400).json({
        success: false,
        error: `Session status is "${sessionCheck[0].status}". Please ensure the session is connected.`,
      });
    }

    // 5. Check credits
    const creditService = (type || "text") === "poll" ? "poll_message" : "send_message";
    const creditCheck = await checkCredits(userId, creditService, 1);
    if (!creditCheck.allowed) {
      return res.status(402).json({ success: false, error: creditCheck.message });
    }

    // 6. Enforce 30-second gap per user for developer API calls
    const lastApiTime = apiLastSendTime.get(userId) || 0;
    const waitMs = Math.max(0, 30000 - (Date.now() - lastApiTime));
    if (waitMs > 0) {
      console.log(`[API] Rate limiting user ${userId}: waiting ${waitMs}ms before sending...`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // 7. Send the message
    const result = await waManager.sendMessage(
      targetSessionId,
      phone.trim(),
      message,
      type || "text",
      finalMediaUrl
    );

    // 8. Deduct credits
    let creditResult = null;
    try {
      creditResult = await deductCredits(userId, creditService, 1, `API message sent to ${phone.trim()}`);
    } catch (creditErr) {
      console.error(`[API] Credit deduction failed for user ${userId}:`, creditErr.message);
    }

    // Update last send time
    apiLastSendTime.set(userId, Date.now());

    // 9. Return success response with credit info
    res.json({
      success: true,
      message: "Message sent successfully",
      data: {
        phone: phone.trim(),
        type: type || "text",
        sessionId: targetSessionId,
        sessionName: sessionCheck[0].sessionName,
        sentAt: new Date().toISOString(),
      },
      credits: {
        service: creditService,
        cost: creditCheck.cost,
        deducted: creditResult?.deducted ?? 0,
        balance: creditResult?.balance ?? creditCheck.balance,
        isFree: creditResult?.isFree ?? false,
      },
    });
  } catch (error) {
    console.error("[API /messages/send] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get user's connected sessions (for API key users to know which sessionId to use)
app.get("/api/sessions", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    const sessions = await db.select({
      id: schema.whatsappSessions.id,
      sessionName: schema.whatsappSessions.sessionName,
      phoneNumber: schema.whatsappSessions.phoneNumber,
      status: schema.whatsappSessions.status,
    }).from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.userId, auth.userId));

    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Public Lead URL API — submit leads from external websites
// POST /api/lead-url/:slug
// Headers: X-API-Key: <apiKey>
// Body: { name, email, phone, ...customFields }
app.post("/api/lead-url/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const apiKey = req.headers["x-api-key"] || req.headers["X-API-Key"] || "";

    const rows = await db.select().from(schema.leadUrls)
      .where(eq(schema.leadUrls.slug, slug));

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Lead URL not found", code: 404 });
    }

    const leadUrl = rows[0];

    if (!leadUrl.isActive) {
      return res.status(403).json({ success: false, error: "Lead URL is inactive", code: 403 });
    }

    if (leadUrl.apiKey !== apiKey) {
      return res.status(401).json({ success: false, error: "Invalid API key", code: 401 });
    }

    const data = req.body;

    // Extract known fields
    const name = data.name || data.Name || data.full_name || data.fullName || "";
    const email = data.email || data.Email || data.mail || "";
    const phone = data.phone || data.Phone || data.mobile || data.phone_number || "";
    const status = data.status || "new";

    // Build notes from remaining fields
    let labels = [];
    try { labels = JSON.parse(leadUrl.labels || "[]"); } catch (e) {}

    const extraFields = {};
    labels.forEach(lbl => {
      const key = lbl.toLowerCase().replace(/\s+/g, "_");
      if (data[lbl] !== undefined) extraFields[lbl] = data[lbl];
      else if (data[key] !== undefined) extraFields[lbl] = data[key];
    });

    const notes = Object.entries(extraFields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    await db.insert(schema.leads).values({
      userId: leadUrl.userId,
      source: "api",
      name: String(name).substring(0, 255) || null,
      phone: String(phone).substring(0, 50) || null,
      email: String(email).substring(0, 320) || null,
      status,
      notes: notes.substring(0, 2000) || null,
      data: JSON.stringify(extraFields).substring(0, 2000) || null,
    });

    // Increment submit count
    await db.update(schema.leadUrls)
      .set({ submitCount: (leadUrl.submitCount || 0) + 1 })
      .where(eq(schema.leadUrls.id, leadUrl.id));

    res.status(201).json({
      success: true,
      message: "Lead submitted successfully",
      code: 201,
    });
  } catch (error) {
    console.error("[API /api/lead-url] Error:", error.message);
    res.status(500).json({ success: false, error: error.message, code: 500 });
  }
});

// API endpoint for WhatsApp webhook
// POST /api/webhook/:apiKey
// Body: { event: "message.received", data: { from, body, timestamp } }
app.post("/api/webhook/:apiKey", async (req, res) => {
  try {
    const { apiKey } = req.params;
    const keyData = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.apiKey, apiKey));

    if (!keyData.length || !keyData[0].isActive) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }

    const { event, data } = req.body || {};
    const userId = keyData[0].userId;

    // Log the webhook event
    console.log(`[Webhook] Received event "${event}" for user ${userId}`);

    // Log webhook payload for debugging
    console.log(`[Webhook] Payload for user ${userId}:`, JSON.stringify(data || req.body).substring(0, 500));

    res.json({ success: true, received: true, event });
  } catch (error) {
    console.error("[Webhook] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// LEAD PUSH / PULL API (No session auth required)
// ============================================================

// Push API: Create a lead via API key
// POST /api/v1/leads/push
// Headers: Authorization: Bearer <apiKey>
// Body: { name, phone, email, source, status, notes, tags, data }
app.post("/api/v1/leads/push", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) {
      return res.status(auth.status).json({ success: false, error: auth.error, code: auth.status });
    }

    const { userId } = auth;
    const { name, phone, email, source, status, notes, tags, data } = req.body;

    if (!name && !phone && !email) {
      return res.status(400).json({ success: false, error: "At least one of name, phone, or email is required", code: 400 });
    }

    const result = await db.insert(schema.leads).values({
      userId,
      source: source || "api",
      name: name ? String(name).substring(0, 255) : null,
      phone: phone ? String(phone).substring(0, 50) : null,
      email: email ? String(email).substring(0, 320) : null,
      status: status || "new",
      notes: notes ? String(notes).substring(0, 2000) : null,
      tags: tags ? String(tags).substring(0, 500) : null,
      data: data ? JSON.stringify(data).substring(0, 2000) : null,
    }).returning();

    res.status(201).json({
      success: true,
      message: "Lead created successfully",
      code: 201,
      lead: result[0],
    });
  } catch (error) {
    console.error("[API /api/v1/leads/push] Error:", error.message);
    res.status(500).json({ success: false, error: error.message, code: 500 });
  }
});

// Pull API: Get leads via API key
// POST /api/v1/leads/pull
// Headers: Authorization: Bearer <apiKey>
// Body: { limit: 50, offset: 0, status, source, search }
app.post("/api/v1/leads/pull", async (req, res) => {
  try {
    const auth = await authenticateApiKey(req);
    if (auth.error) {
      return res.status(auth.status).json({ success: false, error: auth.error, code: auth.status });
    }

    const { userId } = auth;
    const { limit: rawLimit = 50, offset: rawOffset = 0, status, source, search } = req.body;
    const limit = parseInt(rawLimit, 10) || 50;
    const offset = parseInt(rawOffset, 10) || 0;

    let query = db.select().from(schema.leads).where(eq(schema.leads.userId, userId));

    // Note: Drizzle doesn't easily support dynamic AND chaining in a single query builder,
    // so we do filtering in-memory for simplicity on the pull endpoint
    const allLeads = await query;

    let filtered = allLeads;
    if (status) filtered = filtered.filter(l => l.status === status);
    if (source) filtered = filtered.filter(l => l.source === source);
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(l =>
        (l.name && l.name.toLowerCase().includes(s)) ||
        (l.phone && l.phone.toLowerCase().includes(s)) ||
        (l.email && l.email.toLowerCase().includes(s))
      );
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    res.json({
      success: true,
      code: 200,
      total,
      limit,
      offset,
      leads: paginated,
    });
  } catch (error) {
    console.error("[API /api/v1/leads/pull] Error:", error.message);
    res.status(500).json({ success: false, error: error.message, code: 500 });
  }
});

// Logout - Show feedback form first
app.get("/logout", requireAuth, async (req, res) => {
  const user = req.session.user;
  res.render("pages/auth/feedback-logout", {
    title: "Feedback - ParroByte CRM",
    layout: false,
    userName: user?.name || '',
    userEmail: user?.email || '',
  });
});

// Actual logout (after feedback or skip)
app.get("/logout/do", async (req, res) => {
  if (req.session.user) {
    try {
      await db.update(schema.users)
        .set({ sessionToken: null })
        .where(eq(schema.users.id, req.session.user.id));
    } catch (err) {
      console.error("Logout DB cleanup error:", err.message);
    }
  }
  req.session.destroy();
  res.redirect("/");
});

// 404 handler
app.use((req, res) => {
  res.status(404).render("pages/404", { title: "Page Not Found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render("pages/error", { title: "Error", error: err.message });
});

// ===== Scheduled messages cron job (INLINE) =====
// Finds pending scheduled messages and sends them directly
cron.schedule("*/1 * * * *", async () => {
  setImmediate(async () => {
    try {
      const now = new Date();
      const scheduled = await db.select().from(schema.scheduledMessages)
        .where(
          and(
            eq(schema.scheduledMessages.status, "pending"),
            lte(schema.scheduledMessages.scheduleTime, now)
          )
        );

      if (!scheduled.length) return;
      console.log(`[Cron] Processing ${scheduled.length} scheduled message(s) inline`);

      for (const msg of scheduled) {
        try {
          await db.update(schema.scheduledMessages)
            .set({ status: "processing" })
            .where(eq(schema.scheduledMessages.id, msg.id));

          const rawContactIds = JSON.parse(msg.contactIds);
          const contactIds = (Array.isArray(rawContactIds) ? rawContactIds : [rawContactIds])
            .map(id => parseInt(id, 10))
            .filter(id => !isNaN(id));

          if (contactIds.length === 0) {
            await db.update(schema.scheduledMessages)
              .set({ status: "failed" })
              .where(eq(schema.scheduledMessages.id, msg.id));
            continue;
          }

          const targetContacts = await db.select().from(schema.contacts)
            .where(and(
              eq(schema.contacts.userId, msg.userId),
              inArray(schema.contacts.id, contactIds)
            ));

          if (!targetContacts.length) {
            await db.update(schema.scheduledMessages)
              .set({ status: "failed" })
              .where(eq(schema.scheduledMessages.id, msg.id));
            continue;
          }

          // Send messages inline with waManager

          let sent = 0;
          let failed = 0;
          for (const contact of targetContacts) {
            try {
              let personalizedContent = msg.content;
              if (contact.name) personalizedContent = personalizedContent.replace(/\{\{name\}\}/gi, contact.name);
              if (contact.email) personalizedContent = personalizedContent.replace(/\{\{email\}\}/gi, contact.email);
              if (contact.phone) personalizedContent = personalizedContent.replace(/\{\{phone\}\}/gi, contact.phone);

              await waManager.sendMessage(msg.sessionId, contact.phone, personalizedContent, msg.type, msg.mediaUrl);
              sent++;
              const randomGap = Math.floor(Math.random() * 20000) + 30000; // 30000-50000ms
              console.log(`[Scheduled] Waiting ${(randomGap / 1000).toFixed(1)}s before next scheduled message...`);
              await new Promise(r => setTimeout(r, randomGap));
            } catch (e) {
              failed++;
              console.error(`[Cron] Scheduled msg ${msg.id} contact ${contact.phone} failed:`, e.message);
            }
          }

          await db.update(schema.scheduledMessages)
            .set({ status: "completed", completedAt: new Date(), sentCount: sent, failedCount: failed })
            .where(eq(schema.scheduledMessages.id, msg.id));

          console.log(`[Cron] Scheduled msg ${msg.id} completed: ${sent} sent, ${failed} failed`);
        } catch (err) {
          console.error(`[Cron] Scheduled msg ${msg.id} error:`, err.message);
        }
      }
    } catch (error) {
      console.error("[Cron] Job error:", error.message);
    }
  });
});

// ===== YouTube comment auto-reply cron (every 10 minutes) =====
cron.schedule("*/10 * * * *", async () => {
  setImmediate(async () => {
    try {
      console.log("[Cron] Processing YouTube comments...");
      const results = await processYouTubeComments();
      const totalReplies = results.reduce((sum, r) => sum + (r.replies || 0), 0);
      if (totalReplies > 0) {
        console.log(`[Cron] YouTube: ${totalReplies} auto-replies sent`);
      }
    } catch (error) {
      console.error("[Cron] YouTube processing error:", error.message);
    }
  });
});

// ===== Instagram comment auto-reply cron (every 10 minutes, offset by 5 min from YouTube) =====
cron.schedule("*/10 * * * *", async () => {
  setImmediate(async () => {
    try {
      console.log("[Cron] Processing Instagram comments...");
      const results = await processInstagramComments();
      const totalReplies = results.reduce((sum, r) => sum + (r.replies || 0), 0);
      if (totalReplies > 0) {
        console.log(`[Cron] Instagram: ${totalReplies} auto-replies sent`);
      }
    } catch (error) {
      console.error("[Cron] Instagram processing error:", error.message);
    }
  });
});

// ===== Instagram token refresh cron (every 6 hours) =====
cron.schedule("0 */6 * * *", async () => {
  setImmediate(async () => {
    try {
      console.log("[Cron] Refreshing Instagram tokens...");
      await refreshAllTokens();
    } catch (error) {
      console.error("[Cron] Token refresh error:", error.message);
    }
  });
});

// ===== Scheduled emails cron (every 1 minute) =====
cron.schedule("*/1 * * * *", async () => {
  setImmediate(async () => {
    try {
      await processScheduledEmails();
    } catch (error) {
      console.error("[Cron] Scheduled emails error:", error.message);
    }
  });
});

// Initialize and start server
async function startServer() {
  try {
    // Seed default credit configs if empty
    try {
      await seedCreditConfigs();
    } catch (e) {
      console.error("[Startup] Credit config seed error:", e.message);
    }

    app.listen(PORT, () => {
      console.log(`ParroByte CRM Server running on port ${PORT}`);
    });

    // Start AI queue processor for background auto-reply
    startAiQueueProcessor(waManager);

    // Restore previously connected WhatsApp sessions using LocalAuth
    // If auth data is valid, sessions reconnect without QR scan
    setTimeout(() => {
      waManager.restoreAllSessions().catch(err => {
        console.error("[Startup] Session restore error:", err.message);
      });
    }, 3000); // Wait 3s for server to fully start before restoring

    // Graceful shutdown handlers
    async function shutdown(signal) {
      console.log(`\n[Shutdown] ${signal} received. Cleaning up...`);

      // 1. Gracefully destroy all WhatsApp clients (preserves LocalAuth data)
      try {
        await waManager.gracefulShutdown();
      } catch (e) {
        console.error("[Shutdown] waManager gracefulShutdown error:", e.message);
      }

      // 2. Stop AI queue processor
      stopAiQueueProcessor();

      console.log("[Shutdown] Cleanup complete. Exiting.");
      process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Global unhandled rejection handler — catches Puppeteer navigation errors
    // from whatsapp-web.js without crashing the server
    process.on("unhandledRejection", (reason, promise) => {
      const errMsg = reason?.message || String(reason);
      if (errMsg.includes("Execution context was destroyed") || errMsg.includes("Protocol error")) {
        console.warn("[WhatsApp] Unhandled Puppeteer navigation error (non-fatal):", errMsg);
        // The disconnected event handler will auto-reconnect if needed
        return;
      }
      console.error("[CRITICAL] Unhandled Rejection at:", promise, "reason:", reason);
    });

    // Also handle uncaught exit to try cleanup
    process.on("exit", () => {
      stopAiQueueProcessor();
    });

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();

export default app;
