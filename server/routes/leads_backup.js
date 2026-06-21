import express from "express";
import { db } from "../lib/db.js";
import { eq, and, or, ilike, desc, sql, inArray } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { paginate } from "../lib/paginate.js";
import { checkCredits, chargeCredits, deductCredits } from "../lib/credits.js";
import { getEmailConfig, buildTransporter } from "../routes/email.js";
import { triggerWebhook } from "../lib/webhookTrigger.js";
import path from "path";
import fs from "fs/promises";

const router = express.Router();

// List all leads
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const source = req.query.source || "";
    const status = req.query.status || "";
    const search = req.query.search || "";
    const dateFrom = req.query.dateFrom || "";
    const dateTo = req.query.dateTo || "";
    const formFilter = req.query.formFilter || "";

    // Build WHERE conditions array
    const conditions = [];

    // Base: user filter (non-admin only)
    if (!isAdmin) {
      conditions.push(eq(schema.leads.userId, userId));
    }

    // Exclude poll votes from leads list by default (they clutter the view)
    if (source !== "poll_vote") {
      conditions.push(sql`${schema.leads.source} != 'poll_vote'`);
    }

    // Global search across name, phone, email
    if (search) {
      conditions.push(
        or(
          ilike(schema.leads.name, `%${search}%`),
          ilike(schema.leads.phone, `%${search}%`),
          ilike(schema.leads.email, `%${search}%`)
        )
      );
    }

    // Source filter
    if (source) {
      conditions.push(eq(schema.leads.source, source));
    }

    // Status filter
    if (status) {
      conditions.push(eq(schema.leads.status, status));
    }

    // Form filter (by formId, or for old leads by notes containing form title)
    let selectedForm = null;
    if (formFilter) {
      const formIdNum = parseInt(formFilter);
      // Try to get form title for old lead matching
      const formRows = await db.select().from(schema.enquiryForms)
        .where(eq(schema.enquiryForms.id, formIdNum));
      selectedForm = formRows.length ? formRows[0] : null;

      if (selectedForm) {
        // Match leads with formId OR old leads where notes contain form title
        conditions.push(
          or(
            eq(schema.leads.formId, formIdNum),
            ilike(schema.leads.notes, `%${selectedForm.title}%`)
          )
        );
      } else {
        conditions.push(eq(schema.leads.formId, formIdNum));
      }
    }

    // Date range filter
    if (dateFrom) {
      conditions.push(sql`DATE(${schema.leads.createdAt}) >= ${dateFrom}`);
    }
    if (dateTo) {
      conditions.push(sql`DATE(${schema.leads.createdAt}) <= ${dateTo}`);
    }

    // Build final WHERE
    const whereClause = conditions.length > 1 ? and(...conditions) : conditions.length === 1 ? conditions[0] : null;

    const result = await paginate({
      db,
      schema: schema.leads,
      req,
      where: whereClause,
      searchableColumns: ["name", "phone", "email", "createdAt"],
      defaultSort: { column: schema.leads.createdAt, dir: "desc" },
      extraParams: { search, source, status, formFilter, dateFrom, dateTo },
    });

    // Get forms for reference
    let forms = [];
    if (isAdmin) {
      forms = await db.select().from(schema.enquiryForms);
    } else {
      forms = await db.select().from(schema.enquiryForms).where(eq(schema.enquiryForms.userId, userId));
    }

    const sessions = isAdmin
      ? await db.select().from(schema.whatsappSessions)
      : await db.select().from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId));

    const templates = isAdmin
      ? await db.select().from(schema.templates)
      : await db.select().from(schema.templates).where(eq(schema.templates.userId, userId));

    // Email config and templates for "Send Email" feature
    const emailConfig = await getEmailConfig(userId);
    const emailTemplates = isAdmin
      ? await db.select().from(schema.emailTemplates).orderBy(desc(schema.emailTemplates.createdAt))
      : await db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.userId, userId)).orderBy(desc(schema.emailTemplates.createdAt));

    // Build form field definitions map for dynamic column rendering
    const formFieldsMap = {};
    for (const form of forms) {
      try {
        const fields = JSON.parse(form.fields || '[]');
        formFieldsMap[form.id] = fields;
      } catch (e) { formFieldsMap[form.id] = []; }
    }

    res.render("pages/leads/index", {
      title: "Leads - ParroByte CRM",
      leads: result.data,
      pagination: result.pagination,
      columnFilters: result.columnFilters,
      sortCol: result.sortCol,
      sortDir: result.sortDir,
      forms,
      formFieldsMap,
      sessions,
      templates,
      emailConfig,
      emailTemplates,
      sourceFilter: source,
      statusFilter: status,
      formFilter,
      search: req.query.search || "",
      dateFrom: req.query.dateFrom || "",
      dateTo: req.query.dateTo || "",
      isAdmin,
    });
  } catch (error) {
    console.error("Leads error:", error);
    req.flash("error", "Failed to load leads");
    res.redirect("/dashboard");
  }
});

// CSV escape helper
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/"/g, '""');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str}"`;
  }
  return str;
}

// Download leads as CSV
router.get("/download-csv", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const source = req.query.source || "";
    const status = req.query.status || "";
    const search = req.query.search || "";
    const dateFrom = req.query.dateFrom || "";
    const dateTo = req.query.dateTo || "";
    const formFilter = req.query.formFilter || "";

    // Build same WHERE conditions as list view
    const conditions = [];
    if (!isAdmin) conditions.push(eq(schema.leads.userId, userId));
    if (search) {
      conditions.push(or(
        ilike(schema.leads.name, `%${search}%`),
        ilike(schema.leads.phone, `%${search}%`),
        ilike(schema.leads.email, `%${search}%`)
      ));
    }
    // Apply column-specific filters
    const searchableColumns = ["name", "phone", "email", "createdAt"];
    for (const col of searchableColumns) {
      let val = req.query[`search_${col}`] || "";
      if (Array.isArray(val)) val = val.find(v => v && String(v).trim()) || "";
      val = String(val).trim();
      if (val) {
        const tableCol = schema.leads[col];
        if (tableCol) conditions.push(sql`${tableCol}::text ILIKE ${`%${val}%`}`);
      }
    }
    if (source) conditions.push(eq(schema.leads.source, source));
    if (status) conditions.push(eq(schema.leads.status, status));
    if (formFilter) {
      const formIdNum = parseInt(formFilter);
      const formRows = await db.select().from(schema.enquiryForms).where(eq(schema.enquiryForms.id, formIdNum));
      const selectedForm = formRows.length ? formRows[0] : null;
      if (selectedForm) {
        conditions.push(or(
          eq(schema.leads.formId, formIdNum),
          ilike(schema.leads.notes, `%${selectedForm.title}%`)
        ));
      } else {
        conditions.push(eq(schema.leads.formId, formIdNum));
      }
    }
    if (dateFrom) conditions.push(sql`DATE(${schema.leads.createdAt}) >= ${dateFrom}`);
    if (dateTo) conditions.push(sql`DATE(${schema.leads.createdAt}) <= ${dateTo}`);

    const whereClause = conditions.length > 1 ? and(...conditions) : conditions.length === 1 ? conditions[0] : null;

    let allLeads;
    if (whereClause) {
      allLeads = await db.select().from(schema.leads).where(whereClause).orderBy(desc(schema.leads.createdAt));
    } else {
      allLeads = await db.select().from(schema.leads).orderBy(desc(schema.leads.createdAt));
    }

    // Discover all unique form field keys across leads
    const allFieldKeys = new Set();
    for (const lead of allLeads) {
      if (lead.data) {
        try {
          const obj = JSON.parse(lead.data);
          Object.keys(obj).forEach(k => allFieldKeys.add(k));
        } catch (e) {}
      }
    }
    const dynamicKeys = Array.from(allFieldKeys).filter(k => !['name','email','phone','full_name','phone_number'].includes(k));

    // Build CSV
    const headers = ['S.No', 'ID', 'Name', 'Phone', 'Email', 'Country Code', 'Source', 'Status', 'Tags', 'Notes', 'Date', ...dynamicKeys];
    let csv = headers.map(escapeCsv).join(',') + '\n';

    allLeads.forEach((lead, idx) => {
      let dataObj = {};
      if (lead.data) {
        try { dataObj = JSON.parse(lead.data); } catch (e) {}
      }
      const row = [
        idx + 1,
        lead.id,
        lead.name,
        lead.phone,
        lead.email,
        lead.countryCode,
        lead.source,
        lead.status,
        lead.tags,
        lead.notes,
        lead.createdAt ? new Date(lead.createdAt).toLocaleString() : '',
        ...dynamicKeys.map(k => dataObj[k] !== undefined ? dataObj[k] : '')
      ];
      csv += row.map(escapeCsv).join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (error) {
    console.error("CSV export error:", error);
    req.flash("error", "Failed to export CSV");
    res.redirect("/leads");
  }
});

// Create lead manually
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, phone, email, countryCode, notes, tags } = req.body;

    // Check credits
    const creditCheck = await checkCredits(userId, "lead_import");
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/leads");
    }

    await db.insert(schema.leads).values({
      userId,
      source: "manual",
      name,
      phone,
      email,
      countryCode: countryCode || "+1",
      notes,
      tags,
      status: "new",
    });

    await chargeCredits(req, "lead_import", 1, `Created lead: ${name}`);
    req.flash("success", `Lead added (${creditCheck.cost} credits used)`);
    res.redirect("/leads");
  } catch (error) {
    req.flash("error", "Failed to add lead");
    res.redirect("/leads");
  }
});

// Update lead status
router.post("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, tags } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const lead = await db.select().from(schema.leads).where(eq(schema.leads.id, id));
    if (!lead.length || (lead[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/leads");
    }

    await db.update(schema.leads)
      .set({ status, notes, tags, updatedAt: new Date() })
      .where(eq(schema.leads.id, id));

    req.flash("success", "Lead updated");
    res.redirect("/leads");
  } catch (error) {
    req.flash("error", "Failed to update lead");
    res.redirect("/leads");
  }
});

// Delete lead
router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const lead = await db.select().from(schema.leads).where(eq(schema.leads.id, id));
    if (!lead.length || (lead[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/leads");
    }

    await db.delete(schema.leads).where(eq(schema.leads.id, id));
    req.flash("success", "Lead deleted");
    res.redirect("/leads");
  } catch (error) {
    req.flash("error", "Failed to delete lead");
    res.redirect("/leads");
  }
});

// Bulk delete leads
router.post("/delete-bulk", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { leadIds } = req.body;

    let ids = [];
    if (typeof leadIds === 'string' && leadIds.startsWith('[')) {
      try { ids = JSON.parse(leadIds).map(Number).filter(id => !isNaN(id) && id > 0); } catch (e) {}
    } else if (Array.isArray(leadIds)) {
      ids = leadIds.map(Number).filter(id => !isNaN(id) && id > 0);
    } else if (leadIds) {
      const n = Number(leadIds);
      if (!isNaN(n) && n > 0) ids = [n];
    }

    if (!ids.length) {
      req.flash("error", "No leads selected");
      return res.redirect("/leads");
    }

    // Fetch leads and verify ownership
    const leads = await db.select().from(schema.leads).where(inArray(schema.leads.id, ids));
    const deletableIds = leads.filter(l => l.userId === userId || isAdmin).map(l => l.id);

    if (!deletableIds.length) {
      req.flash("error", "Unauthorized or no valid leads selected");
      return res.redirect("/leads");
    }

    await db.delete(schema.leads).where(inArray(schema.leads.id, deletableIds));
    req.flash("success", `Deleted ${deletableIds.length} lead(s)`);
    res.redirect("/leads");
  } catch (error) {
    console.error("Bulk delete error:", error);
    req.flash("error", "Failed to delete leads");
    res.redirect("/leads");
  }
});

// Import scraped business to leads
router.post("/import-scraped", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { businessIds } = req.body;
    const ids = JSON.parse(businessIds || "[]");

    const businesses = await db.select().from(schema.scrapedBusinesses)
      .where(eq(schema.scrapedBusinesses.userId, userId));

    // Fetch jobs to get location info
    const jobs = await db.select().from(schema.scrapingJobs)
      .where(eq(schema.scrapingJobs.userId, userId));
    const jobMap = new Map(jobs.map(j => [j.id, j]));

    const toImport = businesses.filter(b => ids.includes(String(b.id)));

    // Check credits
    const creditCheck = await checkCredits(userId, "lead_import", toImport.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/leads");
    }

    // Helper: normalize scraped phone — remove + and leading 0, store as 91<10-digit>
    function normalizeScrapedPhone(rawPhone) {
      if (!rawPhone) return { phone: '', countryCode: '+91' };
      let digits = String(rawPhone).replace(/\D/g, '');
      // Remove leading 0
      if (digits.startsWith('0')) digits = digits.substring(1);
      // If already 12 digits starting with 91, keep as-is
      if (digits.startsWith('91') && digits.length === 12) {
        return { phone: digits, countryCode: '+91' };
      }
      // If starts with other country code and > 10 digits
      if (digits.length > 10) {
        return { phone: digits, countryCode: '+' + digits.substring(0, digits.length - 10) };
      }
      // 10 digits — add 91 prefix
      if (digits.length === 10) {
        return { phone: '91' + digits, countryCode: '+91' };
      }
      return { phone: digits, countryCode: '+91' };
    }

    let imported = 0;
    for (const b of toImport) {
      try {
        const job = jobMap.get(b.jobId);
        const { phone, countryCode } = normalizeScrapedPhone(b.phone);
        if (!phone) continue;

        await db.insert(schema.leads).values({
          userId,
          source: "scraper",
          name: b.name,
          phone,
          countryCode,
          email: b.email || "",
          address: b.address,
          data: JSON.stringify({
            website: b.website,
            category: b.category,
            businessType: b.category,
            location: job?.location || '',
            sourceUrl: b.sourceUrl,
            email: b.email || "",
          }),
          notes: `Business Type: ${b.category || 'N/A'} | Location: ${job?.location || 'N/A'} | Source: Google Maps Scraper | Email: ${b.email || 'N/A'}`,
          status: "new",
        });

        await db.update(schema.scrapedBusinesses)
          .set({ importedToLeads: true })
          .where(eq(schema.scrapedBusinesses.id, b.id));

        imported++;
      } catch (e) {}
    }

    if (imported > 0) {
      await chargeCredits(req, "lead_import", imported, `Imported ${imported} scraped businesses to leads`);
    }
    req.flash("success", `${imported} businesses imported to leads`);
    res.redirect("/leads");
  } catch (error) {
    req.flash("error", "Failed to import");
    res.redirect("/leads");
  }
});

// Send WhatsApp to lead
router.post("/send-whatsapp", async (req, res) => {
  try {
    const { leadIds, sessionId, message, templateId, messageType, mediaUrl } = req.body;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const ids = JSON.parse(leadIds || "[]");

    // Verify session ownership and in-memory connection status
    const sessionCheck = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, sessionId));
    if (!sessionCheck.length || (sessionCheck[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized: session does not belong to your account");
      return res.redirect("/leads");
    }
    const memStatus = req.waManager.getSessionStatus(sessionId, sessionCheck[0].userId);
    if (memStatus.status !== "connected") {
      console.log(`[Leads] Session ${sessionId} memory status=${memStatus.status}. Attempting reconnect...`);
      try {
        await req.waManager.reconnectSession(sessionId);
        await new Promise(r => setTimeout(r, 3000));
        const reconnected = req.waManager.getSessionStatus(sessionId, sessionCheck[0].userId);
        if (reconnected.status !== "connected") {
          throw new Error("Session reconnect failed");
        }
      } catch (reconnectErr) {
        console.error(`[Leads] Session ${sessionId} reconnect failed:`, reconnectErr.message);
        req.flash("error", "WhatsApp session is disconnected. Please go to WhatsApp Sessions and reconnect it.");
        return res.redirect("/leads");
      }
    }

    // If template selected, fetch template content
    let finalMessage = message;
    let msgType = messageType || "text";
    let media = mediaUrl || null;
    let interactiveData = null;
    if (templateId) {
      const templateRows = await db.select().from(schema.templates)
        .where(eq(schema.templates.id, parseInt(templateId)));
      if (templateRows.length && (templateRows[0].userId === userId || isAdmin)) {
        finalMessage = templateRows[0].content;
        msgType = templateRows[0].type || "text";
        media = templateRows[0].mediaUrl || null;

        // Parse poll options from template variables
        if (msgType === 'poll' && templateRows[0].variables) {
          try {
            const vars = JSON.parse(templateRows[0].variables);
            if (vars.pollOptions && vars.pollOptions.length >= 2) {
              interactiveData = {
                options: vars.pollOptions,
                allowMultipleAnswers: vars.allowMultipleAnswers === true,
              };
            }
          } catch (e) {}
        }
      }
    }

    if (!finalMessage || !finalMessage.trim()) {
      req.flash("error", "Message cannot be empty");
      return res.redirect("/leads");
    }

    const leadsData = await db.select().from(schema.leads)
      .where(eq(schema.leads.userId, userId));

    const targetLeads = leadsData.filter(l => ids.includes(String(l.id)) && l.phone);

    // Check credits
    const creditService = msgType === "poll" ? "poll_message" : "send_message";
    const creditCheck = await checkCredits(userId, creditService, targetLeads.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/leads");
    }

    // Helper: replace template variables with lead data
    function fillVars(text, lead) {
      if (!text) return text;
      return text
        .replace(/\{\{name\}\}/gi, lead.name || '')
        .replace(/\{\{email\}\}/gi, lead.email || '')
        .replace(/\{\{phone\}\}/gi, lead.phone || '')
        .replace(/\{\{address\}\}/gi, lead.address || '')
        .replace(/\{\{status\}\}/gi, lead.status || '')
        .replace(/\{\{notes\}\}/gi, lead.notes || '')
        .replace(/\{\{tags\}\}/gi, lead.tags || '')
        .replace(/\{\{countryCode\}\}/gi, lead.countryCode || '')
        .replace(/\{\{id\}\}/gi, String(lead.id));
    }

    const results = [];

    for (let i = 0; i < targetLeads.length; i++) {
      const lead = targetLeads[i];
      const personalizedMessage = fillVars(finalMessage, lead);
      try {
        await req.waManager.sendMessage(sessionId, lead.phone, personalizedMessage, msgType, media, interactiveData);
        results.push({ phone: lead.phone, status: "success" });

        await db.update(schema.leads)
          .set({ lastContactedAt: new Date() })
          .where(eq(schema.leads.id, lead.id));
      } catch (err) {
        results.push({ phone: lead.phone, status: "failed", error: err.message });
      }

      // 35-second gap between messages to avoid WhatsApp rate limits
      if (i < targetLeads.length - 1) {
        await new Promise(r => setTimeout(r, 35000));
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    let deductedCredits = 0;
    if (successCount > 0) {
      try {
        const creditResult = await chargeCredits(req, creditService, successCount, `Sent WhatsApp to ${successCount} lead(s)`);
        deductedCredits = creditResult.deducted || 0;
      } catch (creditErr) {
        req.flash("error", `Message sent but credit deduction failed: ${creditErr.message}`);
      }
    }
    req.flash("success", `Sent to ${successCount} leads (₹${deductedCredits} credits deducted)`);
    res.redirect("/leads");
  } catch (error) {
    req.flash("error", "Failed to send messages");
    res.redirect("/leads");
  }
});

// Send Email to leads
router.post("/send-email", async (req, res) => {
  try {
    const { leadIds, subject, body, isHtml, templateId } = req.body;
    const userId = req.session.user.id;
    const ids = JSON.parse(leadIds || "[]");

    if (!ids.length) {
      req.flash("error", "Select at least one lead");
      return res.redirect("/leads");
    }
    if (!subject || !subject.trim()) {
      req.flash("error", "Subject is required");
      return res.redirect("/leads");
    }
    if (!body || !body.trim()) {
      req.flash("error", "Message body is required");
      return res.redirect("/leads");
    }

    // Get email config
    const config = await getEmailConfig(userId);
    if (!config) {
      req.flash("error", "Please configure your email settings first at Email > Settings");
      return res.redirect("/leads");
    }

    // Check credits
    const creditCheck = await checkCredits(userId, "send_email", ids.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/leads");
    }

    // Fetch leads
    const leadsData = await db.select().from(schema.leads)
      .where(eq(schema.leads.userId, userId));
    const targetLeads = leadsData.filter(l => ids.includes(String(l.id)) && l.email);

    if (!targetLeads.length) {
      req.flash("error", "None of the selected leads have an email address");
      return res.redirect("/leads");
    }

    // Handle template attachments if templateId provided
    const attachments = [];
    if (templateId) {
      const tmpl = await db.select().from(schema.emailTemplates)
        .where(and(eq(schema.emailTemplates.id, parseInt(templateId)), eq(schema.emailTemplates.userId, userId)));
      if (tmpl.length && tmpl[0].attachments) {
        try {
          const tmplAttachments = JSON.parse(tmpl[0].attachments);
          for (const att of tmplAttachments) {
            const attPath = path.join(process.cwd(), "public", att.path);
            try {
              const data = await fs.readFile(attPath);
              attachments.push({ filename: att.filename, content: data });
            } catch (e) {
              console.error("[Leads Email] Failed to read template attachment:", attPath, e.message);
            }
          }
        } catch (e) {
          console.error("[Leads Email] Failed to parse template attachments:", e.message);
        }
      }
    }

    const transporter = buildTransporter(config);
    let sentCount = 0;
    let failedCount = 0;

    // Helper: replace template variables with lead data
    function fillVars(text, lead) {
      if (!text) return text;
      return text
        .replace(/\{\{name\}\}/gi, lead.name || '')
        .replace(/\{\{email\}\}/gi, lead.email || '')
        .replace(/\{\{phone\}\}/gi, lead.phone || '')
        .replace(/\{\{address\}\}/gi, lead.address || '')
        .replace(/\{\{status\}\}/gi, lead.status || '')
        .replace(/\{\{notes\}\}/gi, lead.notes || '')
        .replace(/\{\{tags\}\}/gi, lead.tags || '')
        .replace(/\{\{countryCode\}\}/gi, lead.countryCode || '')
        .replace(/\{\{id\}\}/gi, String(lead.id));
    }

    for (let i = 0; i < targetLeads.length; i++) {
      const lead = targetLeads[i];
      const filledSubject = fillVars(subject, lead);
      const filledBody = fillVars(body, lead);
      try {
        await transporter.sendMail({
          from: `"${config.fromName || config.emailUser}" <${config.fromEmail || config.emailUser}>`,
          to: lead.email,
          subject: filledSubject,
          [isHtml === "true" || isHtml === true ? "html" : "text"]: filledBody,
          attachments,
          headers: {
            "X-Mailer": "ParroByte-CRM",
            "List-Unsubscribe": `<mailto:${config.emailUser}?subject=unsubscribe>`,
          },
        });
        sentCount++;

        // Log email
        await db.insert(schema.emailMessages).values({
          userId,
          templateId: templateId ? parseInt(templateId) : null,
          direction: "outbound",
          fromEmail: config.fromEmail || config.emailUser,
          toEmail: lead.email,
          subject: filledSubject,
          body: filledBody,
          attachments: attachments.length ? JSON.stringify(attachments.map(a => ({ filename: a.filename, size: a.content?.length || 0 }))) : null,
          status: "sent",
          contactId: lead.id,
          sentAt: new Date(),
        });

        // Update lastContactedAt
        await db.update(schema.leads)
          .set({ lastContactedAt: new Date() })
          .where(eq(schema.leads.id, lead.id));

        triggerWebhook(userId, "email.sent", { to: lead.email, subject: filledSubject });
      } catch (err) {
        failedCount++;
        console.error(`[Leads Email] Failed to send to ${lead.email}:`, err.message);
      }

      // Small delay between sends to avoid SMTP rate limits
      if (i < targetLeads.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Deduct credits for successful sends
    if (sentCount > 0) {
      try {
        await deductCredits(userId, "send_email", sentCount, `Email to ${sentCount} lead(s)`);
      } catch (e) {
        console.error("[Leads Email] Credit deduction failed:", e.message);
      }
    }

    req.flash("success", `Emails sent: ${sentCount} successful, ${failedCount} failed`);
    res.redirect("/leads");
  } catch (error) {
    console.error("Send email to leads error:", error);
    req.flash("error", "Failed to send emails: " + error.message);
    res.redirect("/leads");
  }
});

export default router;
