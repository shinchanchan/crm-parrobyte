import express from "express";
import { db } from "../lib/db.js";
import { eq, and, like, ilike, desc, asc, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import csvParser from "csv-parser";
import { Readable } from "stream";
import { checkCredits, chargeCredits } from "../lib/credits.js";
import { paginate } from "../lib/paginate.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const groupFilter = req.query.group || "";

    // Build base WHERE clause
    const baseWhere = isAdmin ? null : eq(schema.contacts.userId, userId);

    // Handle group filter in WHERE clause
    let whereClause = baseWhere;
    if (groupFilter) {
      whereClause = baseWhere
        ? and(baseWhere, eq(schema.contacts.group, groupFilter))
        : eq(schema.contacts.group, groupFilter);
    }

    // Paginate with server-side search
    const result = await paginate({
      db,
      schema: schema.contacts,
      req,
      where: whereClause,
      searchableColumns: ["name", "phone", "email"],
      defaultSort: { column: schema.contacts.createdAt, dir: "desc" },
    });

    // Get all groups for the filter dropdown
    let groupsQuery = isAdmin
      ? db.select({ group: schema.contacts.group }).from(schema.contacts)
      : db.select({ group: schema.contacts.group }).from(schema.contacts).where(eq(schema.contacts.userId, userId));
    const groupsResult = await groupsQuery;
    const groups = [...new Set(groupsResult.map(c => c.group).filter(Boolean))];

    res.render("pages/contacts/index", {
      title: "Contacts - ParroByte CRM",
      contacts: result.data,
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      groups,
      selectedGroup: groupFilter,
      isAdmin,
    });
  } catch (error) {
    console.error("Contacts error:", error);
    req.flash("error", "Failed to load contacts");
    res.redirect("/dashboard");
  }
});

function buildFullPhone(phone, countryCode) {
  const digits = String(phone || "").replace(/\D/g, "");
  const cc = String(countryCode || "+91").replace(/\D/g, "");
  return cc + digits;
}

router.post("/create", async (req, res) => {
  try {
    const { name, phone, email, countryCode, group, tags, notes } = req.body;
    const userId = req.session.user.id;

    const creditCheck = await checkCredits(userId, "create_contact");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/contacts");
    }

    const phoneDigits = String(phone || "").replace(/\D/g, "");
    if (!phoneDigits || phoneDigits.length < 5) {
      req.flash("error", "Phone number must have at least 5 digits");
      return res.redirect("/contacts");
    }

    const fullPhone = buildFullPhone(phone, countryCode);

    const result = await db.insert(schema.contacts).values({
      userId,
      name,
      phone: fullPhone,
      email,
      countryCode: countryCode || req.session.user.countryCode || "+91",
      group: group || "default",
      tags,
      notes,
    }).returning();

    await chargeCredits(req, "create_contact", 1, `Added contact: ${name}`, result[0].id);
    req.flash("success", `Contact added successfully (${creditCheck.cost} credits used)`);
    res.redirect("/contacts");
  } catch (error) {
    console.error("Create contact error:", error);
    req.flash("error", "Failed to add contact");
    res.redirect("/contacts");
  }
});

router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, countryCode, group, tags, notes } = req.body;

    const contact = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, id));

    if (!contact.length || (contact[0].userId !== req.session.user.id && req.session.user.role !== "admin")) {
      req.flash("error", "Unauthorized");
      return res.redirect("/contacts");
    }

    const phoneDigits = String(phone || "").replace(/\D/g, "");
    if (!phoneDigits || phoneDigits.length < 5) {
      req.flash("error", "Phone number must have at least 5 digits");
      return res.redirect("/contacts");
    }

    const fullPhone = buildFullPhone(phone, countryCode);

    await db.update(schema.contacts)
      .set({ name, phone: fullPhone, email, countryCode, group, tags, notes, updatedAt: new Date() })
      .where(eq(schema.contacts.id, id));

    req.flash("success", "Contact updated");
    res.redirect("/contacts");
  } catch (error) {
    console.error("Update contact error:", error);
    req.flash("error", "Failed to update contact");
    res.redirect("/contacts");
  }
});

router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, id));

    if (!contact.length || (contact[0].userId !== req.session.user.id && req.session.user.role !== "admin")) {
      req.flash("error", "Unauthorized");
      return res.redirect("/contacts");
    }

    await db.delete(schema.contacts).where(eq(schema.contacts.id, id));
    req.flash("success", "Contact deleted");
    res.redirect("/contacts");
  } catch (error) {
    console.error("Delete contact error:", error);
    req.flash("error", "Failed to delete contact");
    res.redirect("/contacts");
  }
});

router.post("/bulk-upload", async (req, res) => {
  try {
    if (!req.files || !req.files.csvFile) {
      req.flash("error", "Please upload a CSV file");
      return res.redirect("/contacts");
    }

    const csvFile = req.files.csvFile;
    const userId = req.session.user.id;

    const results = [];
    const stream = Readable.from(csvFile.data.toString());

    await new Promise((resolve, reject) => {
      stream.pipe(csvParser())
        .on("data", (data) => results.push(data))
        .on("end", resolve)
        .on("error", reject);
    });

    // Check credits for all valid contacts first
    const creditCheck = await checkCredits(userId, "create_contact", results.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/contacts");
    }

    let success = 0;
    let failed = 0;
    const errors = [];

    for (const row of results) {
      try {
        const name = row.name || row.Name || "";
        const phone = row.phone || row.Phone || row.mobile || row.Mobile || "";
        const email = row.email || row.Email || "";
        const group = row.group || row.Group || "default";
        const countryCode = row.countryCode || row.CountryCode || req.session.user.countryCode || "+91";

        if (!name || !phone) {
          failed++;
          errors.push(`Missing name or phone: ${JSON.stringify(row)}`);
          continue;
        }

        const phoneDigits = String(phone).replace(/\D/g, "");
        if (!phoneDigits || phoneDigits.length < 5) {
          failed++;
          errors.push(`Phone must have at least 5 digits: ${phone}`);
          continue;
        }

        const fullPhone = buildFullPhone(phone, countryCode);

        await db.insert(schema.contacts).values({
          userId,
          name,
          phone: fullPhone,
          email,
          countryCode: countryCode || "+91",
          group,
        });
        success++;
      } catch (err) {
        failed++;
        errors.push(`${err.message}: ${JSON.stringify(row)}`);
      }
    }

    // Charge credits for successful imports
    if (success > 0) {
      await chargeCredits(req, "create_contact", success, `Bulk CSV import: ${success} contacts`);
    }

    await db.insert(schema.bulkUploads).values({
      userId,
      filename: csvFile.name,
      totalRecords: results.length,
      successCount: success,
      failCount: failed,
      status: "completed",
      errors: errors.slice(0, 50).join("\n"),
    });

    req.flash("success", `Bulk upload complete: ${success} added, ${failed} failed (${success} credits used)`);
    res.redirect("/contacts");
  } catch (error) {
    console.error("Bulk upload error:", error);
    req.flash("error", "Failed to process CSV file");
    res.redirect("/contacts");
  }
});

export default router;
