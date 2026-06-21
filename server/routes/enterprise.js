import express from "express";
import { db } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { sendTestEmail } from "../lib/mail.js";

const router = express.Router();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// GET - Enterprise enquiry page (public)
router.get("/", async (req, res) => {
  try {
    let enquiries = [];
    try {
      if (req.session.user && req.session.user.role === "admin") {
        enquiries = await db.select().from(schema.enterpriseEnquiries).orderBy(desc(schema.enterpriseEnquiries.createdAt));
      }
    } catch (e) { /* table may not exist yet */ }

    res.render("pages/enterprise/index", {
      title: "Enterprise Plan - ParroByte CRM",
      layout: false,
      enquiries,
      isAdmin: req.session.user?.role === "admin" || false,
      baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    });
  } catch (error) {
    console.error("Enterprise page error:", error);
    res.status(500).send("Error loading page");
  }
});

// POST - Submit enterprise enquiry
router.post("/submit", async (req, res) => {
  try {
    const { companyName, employeeCount, businessType, email, phone, countryCode, requirements } = req.body;

    if (!companyName || !employeeCount || !businessType || !email || !phone) {
      return res.json({ success: false, error: "All required fields must be filled" });
    }

    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000);

    let enquiryId;
    const existing = await db.select().from(schema.enterpriseEnquiries)
      .where(eq(schema.enterpriseEnquiries.email, email));

    if (existing.length) {
      await db.update(schema.enterpriseEnquiries)
        .set({ emailOtp: otp, emailOtpExpiry: otpExpiry, status: "pending" })
        .where(eq(schema.enterpriseEnquiries.id, existing[0].id));
      enquiryId = existing[0].id;
    } else {
      const result = await db.insert(schema.enterpriseEnquiries).values({
        companyName,
        employeeCount,
        businessType,
        email,
        phone,
        countryCode: countryCode || "+1",
        emailOtp: otp,
        emailOtpExpiry: otpExpiry,
        requirements: requirements || "",
        status: "pending",
      }).returning();
      enquiryId = result[0].id;
    }

    const emailSent = await sendTestEmail(
      email,
      "Enterprise Plan - Email Verification",
      `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:30px;background:linear-gradient(135deg,#fdf2f8 0%,#fce7f3 100%);border-radius:16px;">
        <h2 style="color:#db2777;text-align:center;margin-bottom:20px;">Email Verification</h2>
        <p style="color:#4b5563;font-size:14px;">Hello from <strong>${companyName}</strong>,</p>
        <p style="color:#4b5563;font-size:14px;">Thank you for your interest in our Enterprise Plan. Please use the OTP below to verify your email:</p>
        <div style="background:#fff;border-radius:12px;padding:20px;text-align:center;margin:20px 0;box-shadow:0 2px 10px rgba(0,0,0,0.05);">
          <p style="font-size:32px;font-weight:bold;color:#db2777;letter-spacing:8px;margin:0;">${otp}</p>
          <p style="color:#9ca3af;font-size:12px;margin-top:10px;">Valid for 15 minutes</p>
        </div>
        <p style="color:#6b7280;font-size:12px;text-align:center;">If you did not request this, please ignore this email.</p>
      </div>`
    );

    if (!emailSent) {
      return res.json({ success: false, error: "Failed to send verification email. Please try again." });
    }

    res.json({ success: true, enquiryId, message: "OTP sent to your email. Please verify." });
  } catch (error) {
    console.error("Enterprise submit error:", error);
    res.json({ success: false, error: "Failed to submit enquiry: " + error.message });
  }
});

// POST - Verify OTP
router.post("/verify-otp", async (req, res) => {
  try {
    const { enquiryId, otp } = req.body;

    const rows = await db.select().from(schema.enterpriseEnquiries)
      .where(eq(schema.enterpriseEnquiries.id, enquiryId));

    if (!rows.length) return res.json({ success: false, error: "Enquiry not found" });
    if (rows[0].emailVerified) return res.json({ success: false, error: "Email already verified" });
    if (rows[0].emailOtp !== otp) return res.json({ success: false, error: "Invalid OTP" });
    if (new Date() > new Date(rows[0].emailOtpExpiry)) return res.json({ success: false, error: "OTP expired" });

    await db.update(schema.enterpriseEnquiries)
      .set({ emailVerified: true, status: "contacted" })
      .where(eq(schema.enterpriseEnquiries.id, enquiryId));

    // Send confirmation to customer
    await sendTestEmail(
      rows[0].email,
      "Enterprise Plan Enquiry Received",
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:30px;background:linear-gradient(135deg,#fdf2f8 0%,#fce7f3 100%);border-radius:16px;">
        <h2 style="color:#db2777;text-align:center;">Thank You, ${rows[0].companyName}!</h2>
        <p style="color:#4b5563;font-size:14px;">We have received your Enterprise Plan enquiry. Our team will contact you within 24 hours.</p>
      </div>`
    );

    // Send notification to admin
    const adminEmail = process.env.ADMIN_EMAIL || "admin@whatsappcrm.com";
    await sendTestEmail(
      adminEmail,
      `New Enterprise Enquiry: ${rows[0].companyName}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:30px;background:linear-gradient(135deg,#fef9c3 0%,#fde047 100%);border-radius:16px;">
        <h2 style="color:#b45309;text-align:center;">New Enterprise Enquiry!</h2>
        <div style="background:#fff;border-radius:12px;padding:20px;margin:20px 0;">
          <p style="font-size:13px;color:#374151;margin:6px 0;"><strong>Company:</strong> ${rows[0].companyName}</p>
          <p style="font-size:13px;color:#374151;margin:6px 0;"><strong>Employees:</strong> ${rows[0].employeeCount}</p>
          <p style="font-size:13px;color:#374151;margin:6px 0;"><strong>Type:</strong> ${rows[0].businessType}</p>
          <p style="font-size:13px;color:#374151;margin:6px 0;"><strong>Email:</strong> ${rows[0].email}</p>
          <p style="font-size:13px;color:#374151;margin:6px 0;"><strong>Phone:</strong> ${rows[0].countryCode} ${rows[0].phone}</p>
          <p style="font-size:13px;color:#374151;margin:6px 0;"><strong>Requirements:</strong> ${rows[0].requirements || "N/A"}</p>
        </div>
      </div>`
    );

    res.json({ success: true, message: "Email verified! We will contact you within 24 hours." });
  } catch (error) {
    console.error("OTP verify error:", error);
    res.json({ success: false, error: "Verification failed" });
  }
});

// POST - Resend OTP
router.post("/resend-otp", async (req, res) => {
  try {
    const { enquiryId } = req.body;
    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000);

    const rows = await db.select().from(schema.enterpriseEnquiries)
      .where(eq(schema.enterpriseEnquiries.id, enquiryId));

    if (!rows.length) return res.json({ success: false, error: "Not found" });

    await db.update(schema.enterpriseEnquiries)
      .set({ emailOtp: otp, emailOtpExpiry: otpExpiry })
      .where(eq(schema.enterpriseEnquiries.id, enquiryId));

    await sendTestEmail(
      rows[0].email,
      "Enterprise Plan - New OTP",
      `<div style="font-family:Arial,sans-serif;text-align:center;padding:40px;"><h2 style="color:#db2777;">Your New OTP</h2><p style="font-size:32px;font-weight:bold;color:#db2777;letter-spacing:8px;">${otp}</p><p style="color:#9ca3af;font-size:12px;">Valid for 15 minutes</p></div>`
    );

    res.json({ success: true, message: "New OTP sent!" });
  } catch (error) {
    res.json({ success: false, error: "Failed to resend OTP" });
  }
});

// GET - Admin view all enquiries (JSON API)
router.get("/api/enquiries", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
    const enquiries = await db.select().from(schema.enterpriseEnquiries)
      .orderBy(desc(schema.enterpriseEnquiries.createdAt));
    res.json({ enquiries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Admin update enquiry status
router.post("/api/enquiries/:id/status", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
    const { id } = req.params;
    const { status, notes } = req.body;

    await db.update(schema.enterpriseEnquiries)
      .set({ status, notes: notes || null, updatedAt: new Date() })
      .where(eq(schema.enterpriseEnquiries.id, id));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
