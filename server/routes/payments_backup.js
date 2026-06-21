import express from "express";
import { db } from "../lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { createOrder, verifyPaymentSignature, fetchPayment, isRazorpayConfigured, verifyWebhookSignature } from "../lib/razorpay.js";
import { addCredits } from "../lib/credits.js";
import { generateInvoicePdf } from "../lib/invoicePdf.js";
import { sendInvoiceEmail } from "../lib/mail.js";

const router = express.Router();

const CREDIT_PACKAGES = {
  starter: { credits: 100 },
  pro: { credits: 500 },
  business: { credits: 2000 },
  enterprise: { credits: 10000 },
};

/**
 * POST /payments/create-order
 * Body: { packageId, packageName, amount, credits }
 * Creates a Razorpay order for credit purchase
 */
router.post("/create-order", async (req, res) => {
  try {
    if (!isRazorpayConfigured()) {
      return res.status(500).json({ success: false, error: "Razorpay not configured" });
    }

    const userId = req.session.user.id;
    const { packageId, packageName, amount, credits } = req.body;

    if (!packageId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, error: "Invalid package details" });
    }

    // Get user details
    const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!userRows.length) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    const user = userRows[0];

    const pkgCredits = credits || (CREDIT_PACKAGES[packageId]?.credits || 0);
    console.log("[Payments] Creating order for credits:", packageId, "amount:", amount, "credits:", pkgCredits);

    // Create pending invoice first
    const invoiceResult = await db.insert(schema.invoices).values({
      userId,
      planName: packageId,
      amount: amount,
      currency: "INR",
      status: "pending",
      notes: `Purchase ${pkgCredits} credits (${packageName})`,
    }).returning();
    const invoice = invoiceResult[0];

    // Create Razorpay order
    const order = await createOrder({
      amount: parseFloat(amount),
      currency: "INR",
      receipt: `inv_${invoice.id}`,
      notes: {
        userId: String(userId),
        packageId: String(packageId),
        credits: String(pkgCredits),
        invoiceId: String(invoice.id),
      },
    });

    // Update invoice with Razorpay order ID
    await db.update(schema.invoices)
      .set({ razorpayOrderId: order.id })
      .where(eq(schema.invoices.id, invoice.id));

    res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      invoiceId: invoice.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      prefill: {
        name: user.name || "",
        email: user.email || "",
        contact: user.phone || "",
      },
      notes: `Purchase ${pkgCredits} credits`,
    });
  } catch (error) {
    console.error("[Payments] Create order error:", error.message, error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /payments/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, invoiceId }
 * Verifies payment and adds credits to user account
 */
router.post("/verify", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, invoiceId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: "Missing payment details" });
    }

    // Verify signature
    const isValid = verifyPaymentSignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (!isValid) {
      if (invoiceId) {
        await db.update(schema.invoices)
          .set({ status: "failed", notes: "Signature verification failed" })
          .where(eq(schema.invoices.id, invoiceId));
      }
      return res.status(400).json({ success: false, error: "Invalid payment signature" });
    }

    // Fetch payment details from Razorpay
    let payment;
    try {
      payment = await fetchPayment(razorpay_payment_id);
    } catch (err) {
      console.error("[Payments] Fetch payment error:", err.message);
    }

    // Find invoice
    const invoiceRows = await db.select().from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId));
    if (!invoiceRows.length) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }
    const invoice = invoiceRows[0];

    // Update invoice as paid
    await db.update(schema.invoices)
      .set({
        status: "paid",
        transactionId: razorpay_payment_id,
        razorpayOrderId: razorpay_order_id,
        paymentMethod: "razorpay",
        paidAt: new Date(),
        notes: payment ? `Paid via Razorpay. Payment status: ${payment.status}` : "Paid via Razorpay",
      })
      .where(eq(schema.invoices.id, invoice.id));

    // Add credits to user account
    const pkgCredits = CREDIT_PACKAGES[invoice.planName]?.credits || 0;
    if (pkgCredits > 0) {
      await addCredits(userId, pkgCredits, "topup", `Purchased ${pkgCredits} credits via Razorpay`, invoice.id);
      console.log(`[Payments] Added ${pkgCredits} credits to user ${userId}`);
    }

    // Generate and email PDF invoice
    try {
      const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      const user = userRows[0];
      const invoiceData = {
        invoiceId: invoice.id,
        date: new Date().toLocaleDateString("en-IN"),
        status: "paid",
        userName: user?.name || "Customer",
        userEmail: user?.email || "",
        description: invoice.notes || `Credit purchase`,
        packageName: invoice.planName,
        amount: invoice.amount,
        transactionId: razorpay_payment_id,
        orderId: razorpay_order_id,
      };
      const pdfBuffer = await generateInvoicePdf(invoiceData);
      await sendInvoiceEmail(user?.email, user?.name, invoiceData, pdfBuffer);
      console.log(`[Payments] Invoice PDF emailed for invoice ${invoice.id}`);
    } catch (pdfErr) {
      console.error("[Payments] Invoice PDF/email failed:", pdfErr.message);
    }

    res.json({ success: true, message: `Payment verified! ${pkgCredits} credits added to your account.` });
  } catch (error) {
    console.error("[Payments] Verify error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /payments/webhook
 * Razorpay webhook handler for async payment confirmation
 * VERIFIES Razorpay signature to prevent fake credit injection
 */
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"] || "";
    const body = JSON.stringify(req.body);

    // Verify webhook signature
    const isValid = verifyWebhookSignature(body, signature);
    if (!isValid) {
      console.error("[Payments] Webhook signature verification FAILED");
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    const event = req.body;

    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (payment && payment.notes?.invoiceId) {
        const invoiceId = parseInt(payment.notes.invoiceId);
        const userId = parseInt(payment.notes.userId);
        const packageId = payment.notes.packageId;

        // Update invoice
        await db.update(schema.invoices)
          .set({
            status: "paid",
            transactionId: payment.id,
            razorpayOrderId: payment.order_id,
            paymentMethod: "razorpay",
            paidAt: new Date(),
            notes: `Paid via webhook. Payment status: ${payment.status}`,
          })
          .where(eq(schema.invoices.id, invoiceId));

        // Add credits
        const pkgCredits = CREDIT_PACKAGES[packageId]?.credits || 0;
        if (pkgCredits > 0) {
          await addCredits(userId, pkgCredits, "topup", `Purchased ${pkgCredits} credits via webhook`, invoiceId);
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("[Payments] Webhook error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
