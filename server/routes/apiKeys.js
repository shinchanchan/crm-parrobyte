import express from "express";
import { db } from "../lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import crypto from "crypto";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;

    const keys = await db.select().from(schema.apiKeys)
      .where(eq(schema.apiKeys.userId, userId));

    const sessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.userId, userId));

    // Include shared sessions for non-admins
    const sharedSessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.isShared, true));
    const existingIds = new Set(sessions.map(s => s.id));
    for (const s of sharedSessions) {
      if (!existingIds.has(s.id)) sessions.push(s);
    }

    // Build a session lookup map for display
    const sessionMap = new Map();
    sessions.forEach(s => sessionMap.set(s.id, s));

    res.render("pages/developer/apiKeys", {
      title: "API Keys - ParroByte CRM",
      keys,
      sessions,
      sessionMap,
    });
  } catch (error) {
    console.error("API keys error:", error);
    req.flash("error", "Failed to load API keys");
    res.redirect("/dashboard");
  }
});

router.post("/create", async (req, res) => {
  try {
    const { keyName, sessionId, permissions } = req.body;
    const userId = req.session.user.id;

    // Check credits
    const creditCheck = await checkCredits(userId, "api_key");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/api-keys");
    }

    const apiKey = `wcrm_${crypto.randomBytes(32).toString("hex")}`;

    // Validate sessionId if provided (allow shared sessions)
    let linkedSessionId = null;
    if (sessionId) {
      const sessionCheck = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, parseInt(sessionId)));
      if (sessionCheck.length && (sessionCheck[0].userId === userId || sessionCheck[0].isShared)) {
        linkedSessionId = parseInt(sessionId);
      }
    }

    await db.insert(schema.apiKeys).values({
      userId,
      keyName: keyName && keyName.trim() ? keyName.trim() : `API Key ${new Date().toLocaleDateString()}`,
      apiKey,
      sessionId: linkedSessionId,
      permissions: JSON.stringify(permissions || []),
    });

    await chargeCredits(req, "api_key", 1, `Created API key: ${keyName}`);
    req.flash("success", `API Key created: ${apiKey} (${creditCheck.cost} credits used)`);
    res.redirect("/api-keys");
  } catch (error) {
    console.error("Create API key error:", error);
    req.flash("error", "Failed to create API key");
    res.redirect("/api-keys");
  }
});

router.post("/update-session/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionId } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const keyRows = await db.select().from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));

    if (!keyRows.length) {
      req.flash("error", "API key not found");
      return res.redirect("/api-keys");
    }

    if (keyRows[0].userId !== userId && !isAdmin) {
      req.flash("error", "Unauthorized");
      return res.redirect("/api-keys");
    }

    // Validate sessionId if provided (allow shared sessions)
    let linkedSessionId = null;
    if (sessionId) {
      const sessionCheck = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, parseInt(sessionId)));
      if (sessionCheck.length && (sessionCheck[0].userId === userId || isAdmin || sessionCheck[0].isShared)) {
        linkedSessionId = parseInt(sessionId);
      }
    }

    await db.update(schema.apiKeys)
      .set({ sessionId: linkedSessionId })
      .where(eq(schema.apiKeys.id, id));

    req.flash("success", "API key session updated");
    res.redirect("/api-keys");
  } catch (error) {
    console.error("Update API key session error:", error);
    req.flash("error", "Failed to update API key session");
    res.redirect("/api-keys");
  }
});

router.post("/revoke/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const keyRows = await db.select().from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));

    if (!keyRows.length) {
      req.flash("error", "API key not found");
      return res.redirect("/api-keys");
    }

    if (keyRows[0].userId !== userId && !isAdmin) {
      req.flash("error", "Unauthorized");
      return res.redirect("/api-keys");
    }

    await db.update(schema.apiKeys)
      .set({ isActive: false })
      .where(eq(schema.apiKeys.id, id));

    req.flash("success", "API key revoked");
    res.redirect("/api-keys");
  } catch (error) {
    console.error("Revoke API key error:", error);
    req.flash("error", "Failed to revoke API key");
    res.redirect("/api-keys");
  }
});

export default router;
