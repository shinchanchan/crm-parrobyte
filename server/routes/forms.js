import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { sanitizeFilename } from "../lib/sanitize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function generateSlug() {
  return "form-" + crypto.randomBytes(4).toString("hex");
}

// List all forms
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const forms = isAdmin
      ? await db.select().from(schema.enquiryForms).orderBy(desc(schema.enquiryForms.createdAt))
      : await db.select().from(schema.enquiryForms)
          .where(eq(schema.enquiryForms.userId, userId))
          .orderBy(desc(schema.enquiryForms.createdAt));

    res.render("pages/forms/index", {
      title: "Enquiry Forms - ParroByte CRM",
      forms,
      isAdmin,
      baseUrl: `${req.protocol}://${req.get("host")}`,
    });
  } catch (error) {
    console.error("Forms error:", error);
    req.flash("error", "Failed to load forms");
    res.redirect("/dashboard");
  }
});

// Public forms list (for embedding)
router.get("/public", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const forms = await db.select().from(schema.enquiryForms)
      .where(eq(schema.enquiryForms.userId, userId));

    res.render("pages/forms/publicList", {
      title: "Public Forms",
      forms,
      baseUrl: `${req.protocol}://${req.get("host")}`,
    });
  } catch (error) {
    console.error("Public forms error:", error);
    res.redirect("/forms");
  }
});

// View public form (no auth required)
router.get("/p/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const rows = await db.select().from(schema.enquiryForms)
      .where(eq(schema.enquiryForms.slug, slug));

    if (!rows.length) {
      return res.status(404).send("Form not found");
    }

    const form = rows[0];

    // Parse fields
    let parsedFields = [];
    try {
      parsedFields = JSON.parse(form.fields || "[]");
    } catch (e) {
      parsedFields = [];
    }

    // Parse testimonials
    let testimonials = [];
    try {
      testimonials = JSON.parse(form.testimonials || "[]");
    } catch (e) {
      testimonials = [];
    }

    res.render("pages/forms/public", {
      layout: false,
      baseUrl: `${req.protocol}://${req.get("host")}`,
      form: {
        ...form,
        parsedFields,
        testimonials,
      },
    });
  } catch (error) {
    console.error("Public form error:", error);
    res.status(500).send("Error loading form");
  }
});

// Submit public form (no auth required)
router.post("/p/:slug/submit", async (req, res) => {
  try {
    const { slug } = req.params;
    const data = { ...req.body };

    const rows = await db.select().from(schema.enquiryForms)
      .where(eq(schema.enquiryForms.slug, slug));

    if (!rows.length) {
      return res.status(404).json({ error: "Form not found" });
    }

    const form = rows[0];

    // Handle file uploads from form fields
    const uploadDir = path.join(__dirname, "../../public/uploads/forms", String(form.id));
    const fileFields = [];

    if (req.files) {
      // req.files can be a single file or an object of files when multiple fields
      const filesObj = req.files;
      for (const [fieldName, file] of Object.entries(filesObj)) {
        if (!file || !file.name) continue;
        const maxSizeMB = 150;
        if (file.size > maxSizeMB * 1024 * 1024) {
          return res.status(400).json({ error: `File "${file.name}" is too large. Max ${maxSizeMB}MB allowed.` });
        }
        const safeName = `${Date.now()}_${sanitizeFilename(file.name)}`;
        const savePath = path.join(uploadDir, safeName);
        await file.mv(savePath);
        // Store relative path for web access
        data[fieldName] = `/uploads/forms/${form.id}/${safeName}`;
        fileFields.push(fieldName);
      }
    }

    // Save form submission as a lead
    const submissionData = JSON.stringify(data);
    const name = data["Full Name"] || data["Name"] || data["full_name"] || "Form Lead";
    const email = data["Email"] || data["email"] || "";
    const phone = data["Phone"] || data["phone"] || data["phone_number"] || "";

    await db.insert(schema.leads).values({
      userId: form.userId,
      formId: form.id,
      name: String(name).substring(0, 100),
      email: String(email).substring(0, 320),
      phone: String(phone).substring(0, 50),
      source: "form",
      status: "new",
      notes: "Form submission from " + form.title + (fileFields.length ? ` (${fileFields.length} file(s) attached)` : ""),
      data: submissionData,
    });

    // Increment submit count
    await db.update(schema.enquiryForms)
      .set({ submitCount: (form.submitCount || 0) + 1 })
      .where(eq(schema.enquiryForms.id, form.id));

    res.json({ success: true, message: form.thankYouMessage || "Thank you!" });
  } catch (error) {
    console.error("Form submission error:", error);
    res.status(500).json({ error: "Failed to submit form" });
  }
});

// Create form
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { title, description, primaryColor, bgColor, textColor, buttonText, thankYouMessage, fieldsJson, testimonialsJson, bgMediaType, bgMediaData } = req.body;

    if (!title || !fieldsJson) {
      req.flash("error", "Title and fields are required");
      return res.redirect("/forms");
    }

    // Check credits
    const creditCheck = await checkCredits(userId, "create_form");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/forms");
    }

    // Validate JSON fields
    try {
      JSON.parse(fieldsJson || "[]");
    } catch (e) {
      req.flash("error", "Invalid form fields JSON");
      return res.redirect("/forms");
    }

    const slug = generateSlug();

    await db.insert(schema.enquiryForms).values({
      userId,
      title: String(title).substring(0, 255),
      description: description || null,
      slug,
      primaryColor: primaryColor || "#ec4899",
      bgColor: bgColor || "#ffffff",
      textColor: textColor || "#1f2937",
      fields: fieldsJson,
      buttonText: buttonText || "Submit",
      thankYouMessage: thankYouMessage || "Thank you! We will contact you soon.",
      testimonials: testimonialsJson || "[]",
      bgMediaType: bgMediaType || null,
      bgMediaData: bgMediaData || null,
      isActive: true,
    });

    await chargeCredits(req, "create_form", 1, `Created form: ${title}`);
    req.flash("success", `Form created successfully (${creditCheck.cost} credits used)`);
    res.redirect("/forms");
  } catch (error) {
    console.error("Create form error:", error);
    req.flash("error", "Failed to create form: " + error.message);
    res.redirect("/forms");
  }
});

// Update form
router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, primaryColor, bgColor, textColor, buttonText, thankYouMessage, fieldsJson, testimonialsJson, bgMediaType, bgMediaData, isActive } = req.body;

    if (!title || !fieldsJson) {
      req.flash("error", "Title and fields are required");
      return res.redirect("/forms");
    }

    // Validate JSON fields
    try {
      JSON.parse(fieldsJson || "[]");
    } catch (e) {
      req.flash("error", "Invalid form fields JSON");
      return res.redirect("/forms");
    }

    // Verify ownership
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const existing = await db.select().from(schema.enquiryForms)
      .where(eq(schema.enquiryForms.id, id));

    if (!existing.length) {
      req.flash("error", "Form not found");
      return res.redirect("/forms");
    }

    if (!isAdmin && existing[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/forms");
    }

    await db.update(schema.enquiryForms)
      .set({
        title: String(title).substring(0, 255),
        description: description || null,
        primaryColor: primaryColor || "#ec4899",
        bgColor: bgColor || "#ffffff",
        textColor: textColor || "#1f2937",
        buttonText: buttonText || "Submit",
        thankYouMessage: thankYouMessage || "Thank you! We will contact you soon.",
        fields: fieldsJson,
        testimonials: testimonialsJson || "[]",
        bgMediaType: bgMediaType || null,
        bgMediaData: bgMediaData || null,
        isActive: isActive === "on" || isActive === true,
        updatedAt: new Date(),
      })
      .where(eq(schema.enquiryForms.id, id));

    req.flash("success", "Form updated successfully");
    res.redirect("/forms");
  } catch (error) {
    console.error("Update form error:", error);
    req.flash("error", "Failed to update form: " + error.message);
    res.redirect("/forms");
  }
});

// Delete form
router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const existing = await db.select().from(schema.enquiryForms)
      .where(eq(schema.enquiryForms.id, id));

    if (!existing.length) {
      req.flash("error", "Form not found");
      return res.redirect("/forms");
    }

    if (!isAdmin && existing[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/forms");
    }

    await db.delete(schema.enquiryForms).where(eq(schema.enquiryForms.id, id));
    req.flash("success", "Form deleted");
    res.redirect("/forms");
  } catch (error) {
    console.error("Delete form error:", error);
    req.flash("error", "Failed to delete form");
    res.redirect("/forms");
  }
});

export default router;
