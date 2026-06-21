import express from "express";
import { db } from "../lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import { paginate } from "../lib/paginate.js";
import { sanitizeFilename } from "../lib/sanitize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload directories exist
async function ensureUploadDirs() {
  const dirs = [
    path.join(process.cwd(), "public/uploads/media"),
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}
ensureUploadDirs().catch(() => {});

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const whereClause = isAdmin ? null : eq(schema.templates.userId, userId);

    const result = await paginate({
      db,
      schema: schema.templates,
      req,
      where: whereClause,
      searchableColumns: ["name", "content"],
      defaultSort: { column: schema.templates.createdAt, dir: "desc" },
    });

    res.render("pages/templates/index", {
      title: "Templates - ParroByte CRM",
      templates: result.data,
      allTemplates: result.data, // for option response dropdowns
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      isAdmin,
    });
  } catch (error) {
    console.error("Templates error:", error);
    req.flash("error", "Failed to load templates");
    res.redirect("/dashboard");
  }
});

router.post("/create", async (req, res) => {
  try {
    const { name, type, content, mediaCaption } = req.body;
    const userId = req.session.user.id;

    // Build variables JSON — include poll options + option responses if type is poll
    let variables = req.body.variables || null;
    if (type === 'poll' && req.body.pollOptions) {
      const pollOptions = req.body.pollOptions.split('\n').map(o => o.trim()).filter(Boolean);
      const optionResponses = {};
      pollOptions.forEach((opt, idx) => {
        const respId = req.body['optionResponse_' + idx];
        if (respId) {
          optionResponses[opt] = { templateId: parseInt(respId) };
        }
      });
      variables = JSON.stringify({
        pollOptions,
        allowMultipleAnswers: req.body.pollAllowMultiple === 'true',
        optionResponses: Object.keys(optionResponses).length ? optionResponses : undefined,
      });
    }

    const creditCheck = await checkCredits(userId, "create_template");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/templates");
    }

    let mediaUrl = req.body.mediaUrl || null;

    if (req.files && req.files.mediaFile) {
      const file = req.files.mediaFile;
      const maxSizeMB = 150;
      if (file.size > maxSizeMB * 1024 * 1024) {
        req.flash("error", `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed is ${maxSizeMB}MB. Please compress or resize the file before uploading.`);
        return res.redirect("/templates");
      }
      const uploadDir = path.join(process.cwd(), "public/uploads/media");
      const fileName = `${Date.now()}_${sanitizeFilename(file.name)}`;
      const uploadPath = path.join(uploadDir, fileName);
      await file.mv(uploadPath);
      mediaUrl = `/uploads/media/${fileName}`;
    }

    await db.insert(schema.templates).values({
      userId,
      name,
      type,
      content,
      mediaUrl,
      mediaCaption,
      variables,
    }).returning();

    await chargeCredits(req, "create_template", 1, `Created template: ${name}`);
    req.flash("success", `Template created successfully (${creditCheck.cost} credits used)`);
    res.redirect("/templates");
  } catch (error) {
    console.error("Create template error:", error);
    req.flash("error", "Failed to create template");
    res.redirect("/templates");
  }
});

router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, content, mediaCaption } = req.body;

    // Build variables JSON — include poll options + option responses if type is poll
    let variables = req.body.variables || null;
    if (type === 'poll' && req.body.pollOptions) {
      const pollOptions = req.body.pollOptions.split('\n').map(o => o.trim()).filter(Boolean);
      const optionResponses = {};
      pollOptions.forEach((opt, idx) => {
        const respId = req.body['optionResponse_' + idx];
        if (respId) {
          optionResponses[opt] = { templateId: parseInt(respId) };
        }
      });
      variables = JSON.stringify({
        pollOptions,
        allowMultipleAnswers: req.body.pollAllowMultiple === 'true',
        optionResponses: Object.keys(optionResponses).length ? optionResponses : undefined,
      });
    }

    const template = await db.select().from(schema.templates)
      .where(eq(schema.templates.id, id));

    if (!template.length || (template[0].userId !== req.session.user.id && req.session.user.role !== "admin")) {
      req.flash("error", "Unauthorized");
      return res.redirect("/templates");
    }

    let mediaUrl = req.body.mediaUrl || template[0].mediaUrl;

    if (req.files && req.files.mediaFile) {
      const file = req.files.mediaFile;
      const maxSizeMB = 150;
      if (file.size > maxSizeMB * 1024 * 1024) {
        req.flash("error", `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed is ${maxSizeMB}MB. Please compress or resize the file before uploading.`);
        return res.redirect("/templates");
      }
      const uploadDir = path.join(process.cwd(), "public/uploads/media");
      const fileName = `${Date.now()}_${file.name}`;
      const uploadPath = path.join(uploadDir, fileName);
      await file.mv(uploadPath);
      mediaUrl = `/uploads/media/${fileName}`;
    }

    await db.update(schema.templates)
      .set({ name, type, content, mediaUrl, mediaCaption, variables, updatedAt: new Date() })
      .where(eq(schema.templates.id, id));

    req.flash("success", "Template updated");
    res.redirect("/templates");
  } catch (error) {
    req.flash("error", "Failed to update template");
    res.redirect("/templates");
  }
});

router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const template = await db.select().from(schema.templates)
      .where(eq(schema.templates.id, id));

    if (!template.length || (template[0].userId !== req.session.user.id && req.session.user.role !== "admin")) {
      req.flash("error", "Unauthorized");
      return res.redirect("/templates");
    }

    await db.delete(schema.templates).where(eq(schema.templates.id, id));
    req.flash("success", "Template deleted");
    res.redirect("/templates");
  } catch (error) {
    req.flash("error", "Failed to delete template");
    res.redirect("/templates");
  }
});

export default router;
