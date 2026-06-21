import express from "express";
import { db } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import crypto from "crypto";

const router = express.Router();

function generateSlug() {
  return "lead-" + crypto.randomBytes(4).toString("hex");
}

function generateApiKey() {
  return "lk_" + crypto.randomBytes(24).toString("hex");
}

// List all lead URLs
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const leadUrls = isAdmin
      ? await db.select().from(schema.leadUrls).orderBy(desc(schema.leadUrls.createdAt))
      : await db.select().from(schema.leadUrls)
          .where(eq(schema.leadUrls.userId, userId))
          .orderBy(desc(schema.leadUrls.createdAt));

    res.render("pages/leadUrls/index", {
      title: "Lead URLs - ParroByte CRM",
      leadUrls,
      isAdmin,
      baseUrl: `${req.protocol}://${req.get("host")}`,
    });
  } catch (error) {
    console.error("Lead URLs error:", error);
    req.flash("error", "Failed to load lead URLs");
    res.redirect("/dashboard");
  }
});

// Create lead URL
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { title, labelsJson } = req.body;

    if (!title || !labelsJson) {
      req.flash("error", "Title and labels are required");
      return res.redirect("/lead-urls");
    }

    let labels = [];
    try {
      labels = JSON.parse(labelsJson);
      if (!Array.isArray(labels) || labels.length === 0) {
        throw new Error("Labels must be a non-empty array");
      }
    } catch (e) {
      req.flash("error", "Invalid labels format");
      return res.redirect("/lead-urls");
    }

    const slug = generateSlug();
    const apiKey = generateApiKey();

    await db.insert(schema.leadUrls).values({
      userId,
      title: String(title).substring(0, 255),
      slug,
      labels: JSON.stringify(labels),
      apiKey,
      isActive: true,
    });

    req.flash("success", "Lead URL created successfully");
    res.redirect("/lead-urls");
  } catch (error) {
    console.error("Create lead URL error:", error);
    req.flash("error", "Failed to create lead URL");
    res.redirect("/lead-urls");
  }
});

// Update lead URL
router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, labelsJson, isActive } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const existing = await db.select().from(schema.leadUrls)
      .where(eq(schema.leadUrls.id, id));

    if (!existing.length) {
      req.flash("error", "Lead URL not found");
      return res.redirect("/lead-urls");
    }

    if (!isAdmin && existing[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/lead-urls");
    }

    let labels = existing[0].labels;
    if (labelsJson) {
      try {
        const parsed = JSON.parse(labelsJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          labels = JSON.stringify(parsed);
        }
      } catch (e) {
        req.flash("error", "Invalid labels format");
        return res.redirect("/lead-urls");
      }
    }

    await db.update(schema.leadUrls)
      .set({
        title: String(title).substring(0, 255),
        labels,
        isActive: isActive === "on" || isActive === true,
        updatedAt: new Date(),
      })
      .where(eq(schema.leadUrls.id, id));

    req.flash("success", "Lead URL updated successfully");
    res.redirect("/lead-urls");
  } catch (error) {
    console.error("Update lead URL error:", error);
    req.flash("error", "Failed to update lead URL");
    res.redirect("/lead-urls");
  }
});

// Delete lead URL
router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const existing = await db.select().from(schema.leadUrls)
      .where(eq(schema.leadUrls.id, id));

    if (!existing.length) {
      req.flash("error", "Lead URL not found");
      return res.redirect("/lead-urls");
    }

    if (!isAdmin && existing[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/lead-urls");
    }

    await db.delete(schema.leadUrls).where(eq(schema.leadUrls.id, id));
    req.flash("success", "Lead URL deleted");
    res.redirect("/lead-urls");
  } catch (error) {
    console.error("Delete lead URL error:", error);
    req.flash("error", "Failed to delete lead URL");
    res.redirect("/lead-urls");
  }
});

export default router;
