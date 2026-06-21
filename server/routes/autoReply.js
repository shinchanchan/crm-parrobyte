import express from "express";
import { db } from "../lib/db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    
    let rules = isAdmin
      ? await db.select().from(schema.autoReplies)
      : await db.select().from(schema.autoReplies).where(eq(schema.autoReplies.userId, userId));
    
    let sessions = isAdmin
      ? await db.select().from(schema.whatsappSessions)
      : await db.select().from(schema.whatsappSessions)
          .where(
            eq(schema.whatsappSessions.userId, userId)
          );
    // Also include shared sessions for non-admins
    if (!isAdmin) {
      const shared = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.isShared, true));
      const existingIds = new Set(sessions.map(s => s.id));
      for (const s of shared) {
        if (!existingIds.has(s.id)) sessions.push(s);
      }
    }
    
    res.render("pages/autoReply/index", {
      title: "Auto Reply - ParroByte CRM",
      rules,
      sessions,
      isAdmin,
    });
  } catch (error) {
    console.error("Auto reply error:", error);
    req.flash("error", "Failed to load auto reply rules");
    res.redirect("/dashboard");
  }
});

router.post("/create", async (req, res) => {
  try {
    const { name, sessionId, triggerType, triggerValue, responseType, responseContent, aiPrompt, priority } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // If sessionId provided, verify it belongs to the user or is shared
    if (sessionId) {
      const sessionCheck = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, sessionId));
      if (!sessionCheck.length || (sessionCheck[0].userId !== userId && !isAdmin && !sessionCheck[0].isShared)) {
        req.flash("error", "Unauthorized: session does not belong to your account");
        return res.redirect("/auto-reply");
      }
    }

    // Check credits
    const creditCheck = await checkCredits(userId, "auto_reply");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/auto-reply");
    }

    await db.insert(schema.autoReplies).values({
      userId,
      sessionId: sessionId || null,
      name,
      triggerType,
      triggerValue,
      responseType,
      responseContent,
      aiPrompt: responseType === "ai" ? aiPrompt : null,
      priority: parseInt(priority) || 1,
    });

    await chargeCredits(req, "auto_reply", 1, `Created auto-reply rule: ${name}`);
    req.flash("success", `Auto reply rule created (${creditCheck.cost} credits used)`);
    res.redirect("/auto-reply");
  } catch (error) {
    console.error("Create auto reply error:", error);
    req.flash("error", "Failed to create auto reply rule");
    res.redirect("/auto-reply");
  }
});

router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sessionId, triggerType, triggerValue, responseType, responseContent, aiPrompt, priority, isActive } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const rule = await db.select().from(schema.autoReplies)
      .where(eq(schema.autoReplies.id, id));

    if (!rule.length || (rule[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/auto-reply");
    }

    // If sessionId provided, verify it belongs to the user or is shared
    if (sessionId) {
      const sessionCheck = await db.select().from(schema.whatsappSessions)
        .where(eq(schema.whatsappSessions.id, sessionId));
      if (!sessionCheck.length || (sessionCheck[0].userId !== userId && !isAdmin && !sessionCheck[0].isShared)) {
        req.flash("error", "Unauthorized: session does not belong to your account");
        return res.redirect("/auto-reply");
      }
    }

    await db.update(schema.autoReplies)
      .set({
        name,
        sessionId: sessionId || null,
        triggerType,
        triggerValue,
        responseType,
        responseContent,
        aiPrompt: responseType === "ai" ? aiPrompt : null,
        priority: parseInt(priority) || 1,
        isActive: isActive === "on" || isActive === true,
        updatedAt: new Date(),
      })
      .where(eq(schema.autoReplies.id, id));

    req.flash("success", "Auto reply rule updated");
    res.redirect("/auto-reply");
  } catch (error) {
    req.flash("error", "Failed to update rule");
    res.redirect("/auto-reply");
  }
});

router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const rule = await db.select().from(schema.autoReplies)
      .where(eq(schema.autoReplies.id, id))
      ;
    
    if (!rule.length || (rule[0].userId !== req.session.user.id && req.session.user.role !== "admin")) {
      req.flash("error", "Unauthorized");
      return res.redirect("/auto-reply");
    }
    
    await db.delete(schema.autoReplies).where(eq(schema.autoReplies.id, id));
    req.flash("success", "Auto reply rule deleted");
    res.redirect("/auto-reply");
  } catch (error) {
    req.flash("error", "Failed to delete rule");
    res.redirect("/auto-reply");
  }
});

export default router;
