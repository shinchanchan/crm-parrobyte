import express from "express";
import { db } from "../lib/db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const router = express.Router();

// GET - Social Automation dashboard
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;

    const fbAccounts = await db.select().from(schema.socialAccounts)
      .where(and(eq(schema.socialAccounts.userId, userId), eq(schema.socialAccounts.platform, "facebook")));
    const igAccounts = await db.select().from(schema.socialAccounts)
      .where(and(eq(schema.socialAccounts.userId, userId), eq(schema.socialAccounts.platform, "instagram")));

    const automations = await db.select().from(schema.socialAutomations)
      .where(eq(schema.socialAutomations.userId, userId));

    res.render("pages/socialAutomation/index", {
      title: "Social Automation - ParroByte CRM",
      fbAccounts,
      igAccounts,
      automations,
    });
  } catch (error) {
    console.error("Social automation error:", error);
    req.flash("error", "Failed to load social automation");
    res.redirect("/dashboard");
  }
});

// POST - Create automation rule
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountId, platform, name, triggerType, triggerValue, responseType, responseContent, aiPrompt } = req.body;

    // Verify accountId belongs to user
    if (accountId) {
      const acct = await db.select().from(schema.socialAccounts)
        .where(eq(schema.socialAccounts.id, parseInt(accountId)));
      if (!acct.length || (acct[0].userId !== userId)) {
        req.flash("error", "Unauthorized: social account does not belong to you");
        return res.redirect("/social-automation");
      }
    }

    await db.insert(schema.socialAutomations).values({
      userId,
      accountId: parseInt(accountId),
      platform,
      name,
      triggerType,
      triggerValue,
      responseType,
      responseContent,
      aiPrompt: responseType === "ai" ? aiPrompt : null,
    });

    req.flash("success", platform + " automation rule created");
    res.redirect("/social-automation");
  } catch (error) {
    console.error("Create social automation error:", error);
    req.flash("error", "Failed to create automation");
    res.redirect("/social-automation");
  }
});

// POST - Update automation
router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, triggerType, triggerValue, responseType, responseContent, aiPrompt, isActive } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const existing = await db.select().from(schema.socialAutomations)
      .where(eq(schema.socialAutomations.id, id));
    if (!existing.length || (existing[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/social-automation");
    }

    await db.update(schema.socialAutomations)
      .set({
        name,
        triggerType,
        triggerValue,
        responseType,
        responseContent,
        aiPrompt: responseType === "ai" ? aiPrompt : null,
        isActive: isActive === "on" || isActive === true,
        updatedAt: new Date(),
      })
      .where(eq(schema.socialAutomations.id, id));

    req.flash("success", "Automation updated");
    res.redirect("/social-automation");
  } catch (error) {
    req.flash("error", "Failed to update");
    res.redirect("/social-automation");
  }
});

// POST - Delete automation
router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const existing = await db.select().from(schema.socialAutomations)
      .where(eq(schema.socialAutomations.id, id));
    if (!existing.length || (existing[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/social-automation");
    }

    await db.delete(schema.socialAutomations).where(eq(schema.socialAutomations.id, id));
    req.flash("success", "Automation deleted");
    res.redirect("/social-automation");
  } catch (error) {
    req.flash("error", "Failed to delete");
    res.redirect("/social-automation");
  }
});

// POST - Toggle automation active/inactive
router.post("/toggle/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const rows = await db.select().from(schema.socialAutomations)
      .where(eq(schema.socialAutomations.id, id));
    if (!rows.length) return res.json({ success: false });
    if (rows[0].userId !== userId && !isAdmin) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    await db.update(schema.socialAutomations)
      .set({ isActive: !rows[0].isActive, updatedAt: new Date() })
      .where(eq(schema.socialAutomations.id, id));

    res.json({ success: true, isActive: !rows[0].isActive });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// POST - Connect Facebook account (placeholder for future OAuth)
router.post("/connect/facebook", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountName, pageId, accessToken } = req.body;

    // Deactivate existing FB accounts first
    await db.update(schema.socialAccounts)
      .set({ isActive: false })
      .where(and(eq(schema.socialAccounts.userId, userId), eq(schema.socialAccounts.platform, "facebook")));

    await db.insert(schema.socialAccounts).values({
      userId,
      platform: "facebook",
      accountName: accountName || "Facebook Page",
      pageId,
      accessToken,
      isActive: true,
    });

    req.flash("success", "Facebook account connected! DM automation is ready.");
    res.redirect("/social-automation");
  } catch (error) {
    console.error("Connect FB error:", error);
    req.flash("error", "Failed to connect Facebook");
    res.redirect("/social-automation");
  }
});

// POST - Connect Instagram account (placeholder for future OAuth)
router.post("/connect/instagram", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountName, pageId, accessToken } = req.body;

    // Deactivate existing IG accounts first
    await db.update(schema.socialAccounts)
      .set({ isActive: false })
      .where(and(eq(schema.socialAccounts.userId, userId), eq(schema.socialAccounts.platform, "instagram")));

    await db.insert(schema.socialAccounts).values({
      userId,
      platform: "instagram",
      accountName: accountName || "Instagram Account",
      pageId,
      accessToken,
      isActive: true,
    });

    req.flash("success", "Instagram account connected! DM automation is ready.");
    res.redirect("/social-automation");
  } catch (error) {
    console.error("Connect IG error:", error);
    req.flash("error", "Failed to connect Instagram");
    res.redirect("/social-automation");
  }
});

// POST - Disconnect social account
router.post("/disconnect/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.update(schema.socialAccounts)
      .set({ isActive: false, accessToken: null, refreshToken: null })
      .where(eq(schema.socialAccounts.id, id));
    req.flash("success", "Account disconnected");
    res.redirect("/social-automation");
  } catch (error) {
    req.flash("error", "Failed to disconnect");
    res.redirect("/social-automation");
  }
});

export default router;
