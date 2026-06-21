import express from "express";
import { db } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { sendLandingEnquiryEmail } from "../lib/mail.js";

const router = express.Router();

// Public: Submit landing page enquiry
router.post("/submit", async (req, res) => {
  try {
    const { name, enterpriseName, phone, email, message } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Name is required" });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, error: "Phone number is required" });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, error: "Email is required" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: "Invalid email address" });
    }

    const enquiry = await db.insert(schema.landingEnquiries).values({
      name: name.trim(),
      enterpriseName: enterpriseName ? enterpriseName.trim() : null,
      phone: phone.trim(),
      email: email.trim(),
      message: message ? message.trim() : null,
    }).returning();

    // Send email notification to admin
    try {
      await sendLandingEnquiryEmail(enquiry[0]);
    } catch (mailErr) {
      console.error("[LandingEnquiry] Email notification failed:", mailErr.message);
    }

    res.json({ success: true, message: "Enquiry submitted successfully! We will contact you soon." });
  } catch (error) {
    console.error("[LandingEnquiry] Submit error:", error);
    res.status(500).json({ success: false, error: "Failed to submit enquiry" });
  }
});

// Admin: List all landing enquiries
router.get("/api/enquiries", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }
    const enquiries = await db.select().from(schema.landingEnquiries)
      .orderBy(desc(schema.landingEnquiries.createdAt));
    res.json({ success: true, enquiries });
  } catch (error) {
    console.error("[LandingEnquiry] List error:", error);
    res.status(500).json({ success: false, error: "Failed to load enquiries" });
  }
});

// Admin: Update enquiry status
router.post("/api/enquiries/:id/status", async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ["new", "contacted", "qualified", "converted", "lost"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }

    await db.update(schema.landingEnquiries)
      .set({ status })
      .where(eq(schema.landingEnquiries.id, parseInt(id)));

    res.json({ success: true, message: "Status updated" });
  } catch (error) {
    console.error("[LandingEnquiry] Status update error:", error);
    res.status(500).json({ success: false, error: "Failed to update status" });
  }
});

export default router;
