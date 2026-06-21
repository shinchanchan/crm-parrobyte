import express from "express";
import { db } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const router = express.Router();

// Submit feedback (public, can be used by logged-in users)
router.post("/submit", async (req, res) => {
  try {
    const { name, phone, email, message, rating } = req.body;

    if (!name || !message) {
      req.flash("error", "Name and message are required");
      return res.redirect("/logout");
    }

    await db.insert(schema.feedbacks).values({
      userId: req.session.user?.id || null,
      name: String(name).trim(),
      phone: phone ? String(phone).replace(/\D/g, "").trim() : null,
      email: email ? String(email).trim() : null,
      message: String(message).trim(),
      rating: parseInt(rating) || 5,
    });

    req.flash("success", "Thank you for your feedback!");
    res.redirect("/logout/do");
  } catch (error) {
    console.error("[Feedback] Submit error:", error.message);
    req.flash("error", "Failed to submit feedback. Please try again.");
    res.redirect("/logout");
  }
});

// Admin: List all feedbacks
router.get("/admin", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      req.flash("error", "Unauthorized");
      return res.redirect("/dashboard");
    }

    const feedbacks = await db.select().from(schema.feedbacks)
      .orderBy(desc(schema.feedbacks.createdAt));

    res.render("pages/admin/feedbacks", {
      title: "Customer Feedback - ParroByte CRM",
      feedbacks,
      user: req.session.user,
    });
  } catch (error) {
    console.error("[Feedback] Admin list error:", error.message);
    req.flash("error", "Failed to load feedbacks");
    res.redirect("/dashboard");
  }
});

// Admin: Mark feedback as read
router.post("/admin/read/:id", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const id = parseInt(req.params.id);
    await db.update(schema.feedbacks)
      .set({ isRead: true })
      .where(eq(schema.feedbacks.id, id));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete feedback
router.post("/admin/delete/:id", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      req.flash("error", "Unauthorized");
      return res.redirect("/dashboard");
    }

    const id = parseInt(req.params.id);
    await db.delete(schema.feedbacks).where(eq(schema.feedbacks.id, id));
    req.flash("success", "Feedback deleted");
    res.redirect("/feedback/admin");
  } catch (error) {
    console.error("[Feedback] Delete error:", error.message);
    req.flash("error", "Failed to delete feedback");
    res.redirect("/feedback/admin");
  }
});

export default router;
