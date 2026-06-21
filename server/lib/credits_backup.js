import { db } from "./db.js";
import { eq, and, gte, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import fs from "fs";

function creditLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync("/home/vallarasu/Downloads/automation-whatsapp/kimi3/app/credit-debug.log", line); } catch (e) {}
  console.log(msg);
}

/**
 * Atomically deduct credits using raw SQL to prevent race conditions.
 * Returns { success, deducted, balance, isFree } or { success: false, error }
 */
async function atomicDeductCredits(userId, totalCost, description, serviceKey, referenceId) {
  creditLog(`Atomic deduct: userId=${userId}, totalCost=${totalCost}, serviceKey=${serviceKey}`);
  // Use a single atomic UPDATE ... SET credits = credits - x WHERE credits >= x
  // This prevents negative balances under concurrent requests
  const result = await db.execute(sql`
    UPDATE users
    SET credits = ROUND((credits - ${totalCost})::numeric, 2),
        updated_at = NOW()
    WHERE id = ${userId}
      AND credits >= ${totalCost}
    RETURNING credits
  `);

  creditLog(`UPDATE result: rows=${result.rows?.length || 0}, rowCount=${result.rowCount}`);
  if (!result.rows.length) {
    creditLog(`Deduction failed: no rows returned (insufficient credits or user not found)`);
    return { success: false, error: "Insufficient credits or concurrent deduction conflict" };
  }

  const newBalance = parseFloat(result.rows[0].credits);
  creditLog(`Deduction success: newBalance=${newBalance}`);

  await db.insert(schema.creditTransactions).values({
    userId,
    type: "debit",
    amount: -totalCost,
    balanceAfter: newBalance,
    serviceKey,
    description: description || `${serviceKey} deducted`,
    referenceId,
  });

  return { success: true, deducted: totalCost, balance: newBalance };
}

/** Default credit costs for services (in rupees, 2 decimal places) */
const DEFAULT_CREDIT_CONFIGS = [
  { serviceKey: "send_message", serviceName: "Send WhatsApp Message", cost: 0.10, description: "Per outgoing WhatsApp message sent (single or bulk per contact) — ₹0.10" },
  { serviceKey: "poll_message", serviceName: "Send Poll WhatsApp Message", cost: 0.15, description: "Per outgoing WhatsApp poll message sent (single or bulk per contact) — ₹0.15" },
  { serviceKey: "incoming_message", serviceName: "Incoming Message Handle", cost: 0.00, description: "Per incoming WhatsApp message processed (auto-reply, webhook, etc.) — ₹0.00 (FREE)" },
  { serviceKey: "ai_reply", serviceName: "Universal AI Response", cost: 0.25, description: "Per AI-generated response via Ollama or configured AI provider — ₹0.25" },
  { serviceKey: "create_contact", serviceName: "Add Contact", cost: 0.50, description: "Per contact created or imported via CSV — ₹0.50" },
  { serviceKey: "create_template", serviceName: "Create Template", cost: 1.00, description: "Per message template created — ₹1.00" },
  { serviceKey: "scrape", serviceName: "Business Scraper", cost: 2.00, description: "Per scraped business record from Google Maps — ₹2.00" },
  { serviceKey: "schedule_message", serviceName: "Schedule Message", cost: 0.10, description: "Per scheduled message contact — ₹0.10" },
  { serviceKey: "auto_reply", serviceName: "Auto Reply Rule", cost: 3.00, description: "Per auto-reply rule created — ₹3.00" },
  { serviceKey: "create_session", serviceName: "WhatsApp Session", cost: 5.00, description: "Per WhatsApp session connected — ₹5.00" },
  { serviceKey: "social_automation", serviceName: "Social Automation Rule", cost: 3.00, description: "Per social automation rule — ₹3.00" },
  { serviceKey: "api_key", serviceName: "API Key", cost: 5.00, description: "Per API key generated — ₹5.00" },
  { serviceKey: "webhook", serviceName: "Webhook", cost: 2.00, description: "Per webhook created — ₹2.00" },
  { serviceKey: "create_form", serviceName: "Enquiry Form", cost: 2.00, description: "Per enquiry form created — ₹2.00" },
  { serviceKey: "lead_import", serviceName: "Lead Import", cost: 0.50, description: "Per lead imported or created — ₹0.50" },
  { serviceKey: "youtube_rule", serviceName: "YouTube Reply Rule", cost: 3.00, description: "Per YouTube reply rule — ₹3.00" },
  { serviceKey: "instagram_rule", serviceName: "Instagram Reply Rule", cost: 3.00, description: "Per Instagram reply rule — ₹3.00" },
  { serviceKey: "send_email", serviceName: "Send Email", cost: 0.50, description: "Per email sent (single or bulk per contact) — ₹0.50" },
  { serviceKey: "create_email_template", serviceName: "Create Email Template", cost: 1.00, description: "Per email template created — ₹1.00" },
  { serviceKey: "create_email_automation", serviceName: "Create Email Automation", cost: 3.00, description: "Per email auto-reply rule — ₹3.00" },
  { serviceKey: "whatsapp_api_message", serviceName: "WhatsApp API Message", cost: 1.00, description: "Per message sent via Meta WhatsApp Business API — ₹1.00" },
  { serviceKey: "whatsapp_api_template", serviceName: "WhatsApp API Template", cost: 5.00, description: "Per template submission to Meta for approval — ₹5.00" },
  { serviceKey: "session_questionnaire", serviceName: "Session Questionnaire", cost: 2.00, description: "Per questionnaire attached to WhatsApp session — ₹2.00" },
];

/** Seed default credit configs. Adds missing ones without overwriting existing. */
export async function seedCreditConfigs() {
  const existing = await db.select().from(schema.creditConfigs);
  const existingKeys = new Set(existing.map(e => e.serviceKey));

  for (const cfg of DEFAULT_CREDIT_CONFIGS) {
    if (!existingKeys.has(cfg.serviceKey)) {
      await db.insert(schema.creditConfigs).values(cfg);
      console.log("[Credits] Seeded missing config:", cfg.serviceKey);
    }
  }

  if (existing.length === 0) {
    console.log("[Credits] Seeded all default credit configs");
  }
}

/** Get credit config for a service */
export async function getCreditConfig(serviceKey) {
  const rows = await db.select().from(schema.creditConfigs).where(eq(schema.creditConfigs.serviceKey, serviceKey));
  // If a DB row exists, always use it (admin override). Don't fall back to default.
  // isActive only controls UI visibility, not whether the config is applied.
  if (rows.length) {
    return { ...rows[0], cost: parseFloat(rows[0].cost) };
  }
  const fallback = DEFAULT_CREDIT_CONFIGS.find(c => c.serviceKey === serviceKey);
  return fallback ? { ...fallback, cost: parseFloat(fallback.cost), freeQuota: 0 } : null;
}

/** Get credit cost for a service */
export async function getCreditCost(serviceKey) {
  const cfg = await getCreditConfig(serviceKey);
  return cfg ? cfg.cost : 1;
}

/** Get all active credit configs */
export async function getAllCreditConfigs() {
  const rows = await db.select().from(schema.creditConfigs).where(eq(schema.creditConfigs.isActive, true));
  return rows.map(r => ({ ...r, cost: parseFloat(r.cost) }));
}

/** Get ALL credit configs (including inactive) — for admin panel */
export async function getAllCreditConfigsAdmin() {
  const rows = await db.select().from(schema.creditConfigs);
  return rows.map(r => ({ ...r, cost: parseFloat(r.cost) }));
}

/** Get all visible services (for sidebar/menu filtering) */
export async function getVisibleServices() {
  const rows = await db.select().from(schema.creditConfigs).where(eq(schema.creditConfigs.isVisible, true));
  return new Set(rows.map(r => r.serviceKey));
}

/** Get user credit balance */
export async function getUserCredits(userId) {
  const rows = await db.select({ credits: schema.users.credits }).from(schema.users).where(eq(schema.users.id, userId));
  return rows.length ? parseFloat(rows[0].credits) : 0;
}

/** Get user's free usage count for a service in current month */
async function getFreeUsageCount(userId, serviceKey) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const result = await db.select({ count: sql`count(*)` })
    .from(schema.creditTransactions)
    .where(
      and(
        eq(schema.creditTransactions.userId, userId),
        eq(schema.creditTransactions.serviceKey, serviceKey),
        eq(schema.creditTransactions.type, "debit"),
        gte(schema.creditTransactions.createdAt, startOfMonth)
      )
    );
  return parseInt(result[0]?.count || 0, 10);
}

/** Check if user has enough credits (does NOT deduct). Respects free quota. */
export async function checkCredits(userId, serviceKey, quantity = 1) {
  creditLog(`checkCredits: userId=${userId}, serviceKey=${serviceKey}, qty=${quantity}`);
  const cfg = await getCreditConfig(serviceKey);
  const cost = cfg ? cfg.cost : 1;
  const freeQuota = cfg ? (cfg.freeQuota || 0) : 0;
  const totalCost = parseFloat((cost * quantity).toFixed(2));
  const balance = await getUserCredits(userId);
  creditLog(`checkCredits result: cost=${cost}, freeQuota=${freeQuota}, totalCost=${totalCost}, balance=${balance}`);

  // Check free quota
  if (freeQuota > 0) {
    const used = await getFreeUsageCount(userId, serviceKey);
    const remainingFree = Math.max(0, freeQuota - used);
    if (remainingFree >= quantity) {
      creditLog(`checkCredits: free quota applied (${remainingFree} remaining)`);
      return { allowed: true, balance, cost: 0, isFree: true, freeRemaining: remainingFree - quantity };
    }
  }

  if (balance < totalCost) {
    creditLog(`checkCredits: insufficient balance`);
    return {
      allowed: false,
      balance,
      cost: totalCost,
      message: `Insufficient credits. This action requires ₹${totalCost} credits. You have ₹${balance} credits. Please top up.`,
    };
  }
  creditLog(`checkCredits: allowed, totalCost=${totalCost}`);
  return { allowed: true, balance, cost: totalCost, isFree: false };
}

/** Deduct credits from user and log transaction. Respects free quota.
 *  Uses atomic SQL UPDATE to prevent race conditions (negative balances).
 */
export async function deductCredits(userId, serviceKey, quantity = 1, description = "", referenceId = null) {
  creditLog(`deductCredits: userId=${userId}, serviceKey=${serviceKey}, qty=${quantity}`);
  const cfg = await getCreditConfig(serviceKey);
  creditLog(`getCreditConfig result: ${cfg ? JSON.stringify({ cost: cfg.cost, freeQuota: cfg.freeQuota, isActive: cfg.isActive }) : 'null'}`);
  const cost = cfg ? cfg.cost : 1;
  const freeQuota = cfg ? (cfg.freeQuota || 0) : 0;
  const totalCost = parseFloat((cost * quantity).toFixed(2));
  creditLog(`computed totalCost=${totalCost}`);

  // Check if fully within free quota
  if (freeQuota > 0) {
    const used = await getFreeUsageCount(userId, serviceKey);
    const remainingFree = Math.max(0, freeQuota - used);
    creditLog(`freeQuota=${freeQuota}, used=${used}, remaining=${remainingFree}`);
    if (remainingFree >= quantity) {
      // Free usage - don't deduct credits but log it as debit with 0 cost
      // NOTE: free quota has a minor race condition under extreme concurrency
      const current = await getUserCredits(userId);
      await db.insert(schema.creditTransactions).values({
        userId,
        type: "debit",
        amount: 0,
        balanceAfter: current,
        serviceKey,
        description: description ? `(FREE) ${description}` : `(FREE) ${serviceKey} x${quantity}`,
        referenceId,
      });
      creditLog(`Free usage applied. No credits deducted.`);
      return { success: true, deducted: 0, balance: current, isFree: true };
    }
  }

  // Atomic deduction prevents negative balances under concurrent requests
  const result = await atomicDeductCredits(userId, totalCost, description, serviceKey, referenceId);
  if (!result.success) {
    // Fallback: read current balance for error message
    const balance = await getUserCredits(userId);
    creditLog(`Deduction failed: ${result.error}, balance=${balance}`);
    return { success: false, error: `Insufficient credits. Need ₹${totalCost}, have ₹${balance}`, balance };
  }
  creditLog(`Deduction complete: deducted=${result.deducted}, balance=${result.balance}`);
  return result;
}

/** Add credits (top-up or bonus) — atomic UPDATE */
export async function addCredits(userId, amount, type = "topup", description = "", referenceId = null) {
  const amt = parseFloat(parseFloat(amount).toFixed(2));

  const result = await db.execute(sql`
    UPDATE users
    SET credits = ROUND((credits + ${amt})::numeric, 2),
        updated_at = NOW()
    WHERE id = ${userId}
    RETURNING credits
  `);

  const newBalance = result.rows.length ? parseFloat(result.rows[0].credits) : 0;

  await db.insert(schema.creditTransactions).values({
    userId,
    type,
    amount: amt,
    balanceAfter: newBalance,
    description: description || `${type} of ₹${amt} credits`,
    referenceId,
  });

  return { success: true, added: amt, balance: newBalance };
}


/** Middleware: check credits before allowing action */
export function requireCredits(serviceKey, getQuantity = () => 1) {
  return async (req, res, next) => {
    try {
      const userId = req.session.user.id;
      const qty = typeof getQuantity === "function" ? getQuantity(req) : 1;
      const result = await checkCredits(userId, serviceKey, qty);
      if (!result.allowed) {
        req.flash("error", result.message);
        return res.redirect("back");
      }
      req.creditInfo = result;
      next();
    } catch (err) {
      console.error("[requireCredits] Error:", err.message);
      req.flash("error", "Credit check failed");
      return res.redirect("back");
    }
  };
}

/** Middleware wrapper that deducts after successful action */
export async function chargeCredits(req, serviceKey, quantity = 1, description = "", referenceId = null) {
  // Support both req object and direct userId (for background workers)
  let userId;
  let hasSession = false;
  if (typeof req === 'number' || typeof req === 'string') {
    userId = parseInt(req);
  } else if (req && req.session && req.session.user) {
    userId = req.session.user.id;
    hasSession = true;
  } else if (req && req.userId) {
    userId = req.userId;
  } else {
    console.error(`[Credits] chargeCredits called with invalid req:`, typeof req, req);
    throw new Error("Invalid request object passed to chargeCredits");
  }
  creditLog(`chargeCredits called: userId=${userId}, serviceKey=${serviceKey}, qty=${quantity}, hasSession=${hasSession}`);
  const result = await deductCredits(userId, serviceKey, quantity, description, referenceId);
  // Sync session credits so UI shows fresh balance immediately
  if (hasSession && result.success && typeof result.balance === 'number') {
    req.session.user.credits = result.balance;
  }
  return result;
}
