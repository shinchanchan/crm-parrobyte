import { db } from "../lib/db.js";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";

/** Get plan limits from DB (single source of truth) */
export async function getPlanLimits(planName) {
  const planRows = await db.select().from(schema.plans).where(eq(schema.plans.name, planName));
  if (!planRows.length) {
    return { maxSessions: 1, maxContacts: 100, maxTemplates: 5, maxScrapeRecords: 10 };
  }
  const p = planRows[0];
  return {
    maxSessions: p.maxSessions ?? 1,
    maxContacts: p.maxContacts ?? 100,
    maxTemplates: p.maxTemplates ?? 5,
    maxScrapeRecords: p.maxScrapeRecords ?? 10,
  };
}

/** Get the effective max sessions for a user.
 *  Priority: 1) user.maxSessions admin override, 2) default 1
 *  Note: Default is 1 for all users. Admin must explicitly increase per-user.
 */
export async function getUserMaxSessions(userId) {
  const userRows = await db.select({ plan: schema.users.plan, maxSessions: schema.users.maxSessions }).from(schema.users).where(eq(schema.users.id, userId));
  if (!userRows.length) return 1;
  const user = userRows[0];

  // Admin override takes highest priority
  if (user.maxSessions !== null && user.maxSessions !== undefined) {
    return user.maxSessions;
  }

  // Default: every user gets 1 session unless admin overrides
  return 1;
}

/** Get a user's current plan limits + usage */
export async function getUserPlanStatus(userId) {
  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!userRows.length) return null;
  const user = userRows[0];
  const limits = await getPlanLimits(user.plan || "free");
  const maxSessions = await getUserMaxSessions(userId);

  const [sessionResult, contactResult, templateResult] = await Promise.all([
    db.select({ count: sql`count(*)` }).from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId)),
    db.select({ count: sql`count(*)` }).from(schema.contacts).where(eq(schema.contacts.userId, userId)),
    db.select({ count: sql`count(*)` }).from(schema.templates).where(eq(schema.templates.userId, userId)),
  ]);

  const sessionCount = parseInt(sessionResult[0]?.count || 0, 10);
  const contactCount = parseInt(contactResult[0]?.count || 0, 10);
  const templateCount = parseInt(templateResult[0]?.count || 0, 10);

  return {
    plan: user.plan,
    planExpiry: user.planExpiry,
    isExpired: user.planExpiry ? new Date(user.planExpiry) < new Date() : false,
    limits: { ...limits, maxSessions },
    usage: {
      sessions: sessionCount,
      contacts: contactCount,
      templates: templateCount,
    },
  };
}

export async function checkPlanLimit(userId, resourceType) {
  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!userRows.length) return { allowed: false, message: "User not found" };

  const user = userRows[0];
  const plan = user.plan || "free";
  const limits = await getPlanLimits(plan);

  let currentCount = 0;

  switch (resourceType) {
    case "sessions": {
      const maxSessions = await getUserMaxSessions(userId);
      const rows = await db.select({ count: sql`count(*)` }).from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId));
      currentCount = parseInt(rows[0]?.count || 0, 10);
      if (currentCount >= maxSessions) {
        return {
          allowed: false,
          message: `Session limit reached: You are allowed max ${maxSessions} WhatsApp session(s). You currently have ${currentCount}. Please contact admin to increase your limit or upgrade your plan.`,
          current: currentCount,
          limit: maxSessions,
          resource: "sessions",
        };
      }
      break;
    }

    case "contacts": {
      const rows = await db.select({ count: sql`count(*)` }).from(schema.contacts).where(eq(schema.contacts.userId, userId));
      currentCount = parseInt(rows[0]?.count || 0, 10);
      if (currentCount >= limits.maxContacts) {
        return {
          allowed: false,
          message: `Plan limit reached: ${plan.toUpperCase()} plan allows max ${limits.maxContacts} contacts. You currently have ${currentCount}. Please upgrade your plan.`,
          current: currentCount,
          limit: limits.maxContacts,
          resource: "contacts",
        };
      }
      break;
    }

    case "templates": {
      const rows = await db.select({ count: sql`count(*)` }).from(schema.templates).where(eq(schema.templates.userId, userId));
      currentCount = parseInt(rows[0]?.count || 0, 10);
      if (currentCount >= limits.maxTemplates) {
        return {
          allowed: false,
          message: `Plan limit reached: ${plan.toUpperCase()} plan allows max ${limits.maxTemplates} templates. You currently have ${currentCount}. Please upgrade your plan.`,
          current: currentCount,
          limit: limits.maxTemplates,
          resource: "templates",
        };
      }
      break;
    }

    case "scraper":
      return { allowed: true };

    default:
      return { allowed: true };
  }

  return { allowed: true, current: currentCount, limit: resourceType === "sessions" ? await getUserMaxSessions(userId) : limits[resourceType] };
}

// Middleware for checking limits
export function enforcePlanLimit(resourceType) {
  return async (req, res, next) => {
    const userId = req.session.user.id;
    const result = await checkPlanLimit(userId, resourceType);

    if (!result.allowed) {
      req.flash("error", result.message);
      return res.redirect("back");
    }

    next();
  };
}

// Middleware for scraper limit (per-job)
export async function checkScraperLimit(userId, requestedMax) {
  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!userRows.length) return { allowed: false, message: "User not found" };

  const plan = userRows[0].plan || "free";
  const limits = await getPlanLimits(plan);

  if (requestedMax > limits.maxScrapeRecords) {
    return {
      allowed: false,
      message: `Plan limit: ${plan.toUpperCase()} allows max ${limits.maxScrapeRecords} records per scrape. Requested ${requestedMax}.`,
      maxAllowed: limits.maxScrapeRecords,
    };
  }

  return { allowed: true, maxAllowed: limits.maxScrapeRecords };
}

/** Middleware: check if plan has expired. If so, redirect to billing with upgrade prompt */
export function requireActivePlan(req, res, next) {
  const user = req.session.user;
  if (!user) return res.redirect("/auth/login");
  if (user.role === "admin") return next();

  const expiry = user.planExpiry;
  if (expiry && new Date(expiry) < new Date()) {
    req.flash("error", "Your plan has expired. Please renew your subscription to continue.");
    return res.redirect("/billing");
  }
  next();
}
