import puppeteer from "puppeteer";
import { db } from "./db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const INVOICE_HTML_TEMPLATE = (data) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Inter', 'Segoe UI', sans-serif; }
    body { background: #fff; color: #1f2937; padding: 40px; }
    .invoice { max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; padding-bottom: 20px; border-bottom: 3px solid #ec4899; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-icon { width: 48px; height: 48px; background: linear-gradient(135deg, #ec4899, #f472b6); border-radius: 12px; display: flex; align-items: center; justify-content: center; color: white; font-size: 24px; }
    .brand h1 { font-size: 24px; color: #ec4899; }
    .brand p { font-size: 12px; color: #9ca3af; }
    .invoice-meta { text-align: right; }
    .invoice-meta h2 { font-size: 28px; color: #ec4899; margin-bottom: 8px; }
    .invoice-meta p { font-size: 13px; color: #6b7280; margin-bottom: 4px; }
    .section { margin-bottom: 30px; }
    .section-title { font-size: 14px; font-weight: 700; color: #374151; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
    .info-block p { font-size: 13px; color: #6b7280; margin-bottom: 4px; }
    .info-block h4 { font-size: 15px; color: #1f2937; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background: #fdf2f8; color: #be185d; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 16px; text-align: left; border-bottom: 2px solid #fbcfe8; }
    td { padding: 14px 16px; font-size: 14px; border-bottom: 1px solid #f3f4f6; }
    tr:last-child td { border-bottom: none; }
    .total-row { background: #fdf2f8; font-weight: 700; }
    .total-row td { color: #be185d; font-size: 16px; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-paid { background: #d1fae5; color: #047857; }
    .status-pending { background: #fef3c7; color: #b45309; }
    .footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #f3f4f6; text-align: center; }
    .footer p { font-size: 12px; color: #9ca3af; }
    .amount { font-weight: 700; color: #1f2937; }
  </style>
</head>
<body>
  <div class="invoice">
    <div class="header">
      <div class="brand">
        <div class="brand-icon">&#9993;</div>
        <div>
          <h1>ParroByte CRM</h1>
          <p>Credit-Based Business Automation</p>
        </div>
      </div>
      <div class="invoice-meta">
        <h2>INVOICE</h2>
        <p><strong>Invoice #:</strong> INV-${data.invoiceId}</p>
        <p><strong>Date:</strong> ${data.date}</p>
        <p><strong>Status:</strong> <span class="status-badge ${data.status === 'paid' ? 'status-paid' : 'status-pending'}">${data.status.toUpperCase()}</span></p>
      </div>
    </div>

    <div class="section">
      <div class="info-grid">
        <div class="info-block">
          <p class="section-title">Billed To</p>
          <h4>${data.userName}</h4>
          <p>${data.userEmail}</p>
        </div>
        <div class="info-block">
          <p class="section-title">Payment Details</p>
          <p><strong>Method:</strong> Razorpay</p>
          <p><strong>Transaction ID:</strong> ${data.transactionId || 'N/A'}</p>
          <p><strong>Order ID:</strong> ${data.orderId || 'N/A'}</p>
        </div>
      </div>
    </div>

    <div class="section">
      <p class="section-title">Item Details</p>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Package</th>
            <th style="text-align:right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${data.description}</td>
            <td>${data.packageName}</td>
            <td style="text-align:right" class="amount">₹${data.amount}</td>
          </tr>
          <tr class="total-row">
            <td colspan="2" style="text-align:right">Total Paid</td>
            <td style="text-align:right">₹${data.amount}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="footer">
      <p>Thank you for choosing ParroByte CRM!</p>
      <p style="margin-top:8px">For support, contact us at support@parrobyte.com</p>
      <p style="margin-top:16px; font-size:11px; color:#d1d5db;">This is a computer-generated invoice and does not require a signature.</p>
    </div>
  </div>
</body>
</html>`;

export async function generateInvoicePdf(invoiceData) {
  let browser = null;
  try {
    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: chromePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    const html = INVOICE_HTML_TEMPLATE(invoiceData);
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return pdfBuffer;
  } catch (err) {
    console.error("[InvoicePDF] Generation failed:", err.message);
    throw err;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}
