import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const router = express.Router();

// List all poll auto-responses for the user
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const responses = await db.select()
      .from(schema.pollAutoResponses)
      .where(isAdmin ? undefined : eq(schema.pollAutoResponses.userId, userId))
      .orderBy(desc(schema.pollAutoResponses.createdAt));

    const templates = await db.select()
      .from(schema.templates)
      .where(isAdmin ? undefined : eq(schema.templates.userId, userId));

    const templateMap = new Map(templates.map(t => [t.id, t]));

    res.render("pages/pollAutoResponses/index", {
      title: "Poll Auto-Responses - ParroByte CRM",
      responses,
      templates,
      templateMap,
      isAdmin,
    });
  } catch (error) {
    console.error("Poll auto-responses error:", error);
    req.flash("error", "Failed to load poll auto-responses");
    res.redirect("/dashboard");
  }
});

// Create a new poll auto-response
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { pollName, optionName, templateId, responseContent } = req.body;

    if (!pollName || !optionName || !responseContent) {
      req.flash("error", "Poll name, option name, and response are required");
      return res.redirect("/poll-auto-responses");
    }

    // Verify template ownership if templateId provided
    let finalContent = responseContent;
    if (templateId) {
      const tRows = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, parseInt(templateId)));
      if (tRows.length && (tRows[0].userId === userId || isAdmin)) {
        finalContent = tRows[0].content;
      }
    }

    // Get user's connected sessions for the dropdown
    const sessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.userId, userId));
    const sessionId = sessions.length ? sessions[0].id : null;

    await db.insert(schema.pollAutoResponses).values({
      userId,
      sessionId: sessionId || 0,
      pollName: pollName.trim(),
      optionName: optionName.trim(),
      responseContent: finalContent,
      templateId: templateId ? parseInt(templateId) : null,
      isActive: true,
    });

    req.flash("success", "Poll auto-response created");
    res.redirect("/poll-auto-responses");
  } catch (error) {
    console.error("Create poll auto-response error:", error);
    req.flash("error", "Failed to create poll auto-response");
    res.redirect("/poll-auto-responses");
  }
});

// Toggle active status
router.post("/toggle/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const id = parseInt(req.params.id);

    const rows = await db.select().from(schema.pollAutoResponses)
      .where(eq(schema.pollAutoResponses.id, id));
    if (!rows.length || (rows[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/poll-auto-responses");
    }

    await db.update(schema.pollAutoResponses)
      .set({ isActive: !rows[0].isActive })
      .where(eq(schema.pollAutoResponses.id, id));

    req.flash("success", "Status updated");
    res.redirect("/poll-auto-responses");
  } catch (error) {
    console.error("Toggle poll auto-response error:", error);
    req.flash("error", "Failed to update status");
    res.redirect("/poll-auto-responses");
  }
});

// Delete a poll auto-response
router.post("/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const id = parseInt(req.params.id);

    const rows = await db.select().from(schema.pollAutoResponses)
      .where(eq(schema.pollAutoResponses.id, id));
    if (!rows.length || (rows[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/poll-auto-responses");
    }

    await db.delete(schema.pollAutoResponses)
      .where(eq(schema.pollAutoResponses.id, id));

    req.flash("success", "Poll auto-response deleted");
    res.redirect("/poll-auto-responses");
  } catch (error) {
    console.error("Delete poll auto-response error:", error);
    req.flash("error", "Failed to delete");
    res.redirect("/poll-auto-responses");
  }
});

export default router;
