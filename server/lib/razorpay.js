import Razorpay from "razorpay";
import crypto from "crypto";

function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Razorpay keys not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

/**
 * Create a Razorpay order for a plan upgrade
 */
export async function createOrder({ amount, currency = "INR", receipt, notes = {} }) {
  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    throw new Error(`Invalid amount: ${amount}. Must be a positive number.`);
  }
  const amountInPaise = Math.round(numericAmount * 100);
  if (amountInPaise < 100) {
    throw new Error(`Amount too small: ${amountInPaise} paise. Minimum is 100 paise (₹1).`);
  }

  const razorpay = getRazorpay();
  console.log("[Razorpay] Creating order:", { amount: amountInPaise, currency, receipt });

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency,
    receipt,
    notes,
  });

  console.log("[Razorpay] Order created:", { id: order.id, amount: order.amount, currency: order.currency, status: order.status });
  return order;
}

/**
 * Verify Razorpay payment signature
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return false;

  const body = orderId + "|" + paymentId;
  const expectedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(body)
    .digest("hex");

  return expectedSignature === signature;
}

/**
 * Fetch payment details from Razorpay
 */
export async function fetchPayment(paymentId) {
  const razorpay = getRazorpay();
  return razorpay.payments.fetch(paymentId);
}

/**
 * Verify Razorpay webhook signature (HMAC-SHA256 of raw body)
 * Uses RAZORPAY_WEBHOOK_SECRET if set, otherwise falls back to RAZORPAY_KEY_SECRET
 */
export function verifyWebhookSignature(body, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch (e) {
    return expected === signature;
  }
}

/**
 * Check if Razorpay is configured
 */
export function isRazorpayConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
