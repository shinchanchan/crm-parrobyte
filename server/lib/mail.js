import nodemailer from "nodemailer";

// Create reusable transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
});

export async function sendOtpEmail(to, name, otp) {
  const mailOptions = {
    from: `"ParroByte CRM" <${process.env.SMTP_USER || "noreply@whatsappcrm.com"}>`,
    to,
    subject: "Your Email Verification Code",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #fce7f3;border-radius:16px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="color:#ec4899;margin:0;">ParroByte CRM</h2>
          <p style="color:#666;margin:5px 0 0;">Email Verification</p>
        </div>
        <p style="color:#333;">Hi ${name || "there"},</p>
        <p style="color:#333;">Your email verification code is:</p>
        <div style="text-align:center;margin:30px 0;">
          <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#ec4899;background:#fdf2f8;padding:15px 30px;border-radius:12px;display:inline-block;">${otp}</span>
        </div>
        <p style="color:#666;font-size:13px;">This code will expire in 10 minutes. If you didn't request this, please ignore this email.</p>
        <hr style="border:none;border-top:1px solid #fce7f3;margin:20px 0;">
        <p style="color:#999;font-size:12px;text-align:center;">ParroByte CRM &copy; ${new Date().getFullYear()}</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("OTP email sent:", info.messageId);
    return { success: true };
  } catch (error) {
    console.error("Email send error:", error.message);
    return { success: false, error: error.message };
  }
}

export async function sendPasswordResetEmail(to, name, code) {
  const mailOptions = {
    from: `"ParroByte CRM" <${process.env.SMTP_USER || "noreply@whatsappcrm.com"}>`,
    to,
    subject: "Password Reset Request - ParroByte CRM",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #fce7f3;border-radius:16px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="color:#ec4899;margin:0;">ParroByte CRM</h2>
          <p style="color:#666;margin:5px 0 0;">Password Reset</p>
        </div>
        <p style="color:#333;">Hi ${name || "there"},</p>
        <p style="color:#333;">We received a request to reset your password. Your password reset code is:</p>
        <div style="text-align:center;margin:30px 0;">
          <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#ec4899;background:#fdf2f8;padding:15px 30px;border-radius:12px;display:inline-block;">${code}</span>
        </div>
        <p style="color:#666;font-size:13px;">This code will expire in <strong>15 minutes</strong>. If you did not request a password reset, please ignore this email or contact support.</p>
        <hr style="border:none;border-top:1px solid #fce7f3;margin:20px 0;">
        <p style="color:#999;font-size:12px;text-align:center;">ParroByte CRM &copy; ${new Date().getFullYear()}</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Password reset email sent:", info.messageId);
    return { success: true };
  } catch (error) {
    console.error("Password reset email error:", error.message);
    return { success: false, error: error.message };
  }
}

export async function sendTestEmail(to, subject, html) {
  const mailOptions = {
    from: `"ParroByte CRM" <${process.env.SMTP_USER || "noreply@whatsappcrm.com"}>`,
    to,
    subject,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function sendLandingEnquiryEmail(enquiry) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "noreply@whatsappcrm.com";
  const mailOptions = {
    from: `"ParroByte CRM" <${process.env.SMTP_USER || "noreply@whatsappcrm.com"}>`,
    to: adminEmail,
    subject: `New Landing Page Enquiry from ${enquiry.name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #fce7f3;border-radius:16px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="color:#ec4899;margin:0;">ParroByte CRM</h2>
          <p style="color:#666;margin:5px 0 0;">New Landing Page Enquiry</p>
        </div>
        <div style="background:#fdf2f8;padding:15px;border-radius:12px;margin:20px 0;">
          <p style="margin:0 0 8px;color:#333;"><strong>Name:</strong> ${enquiry.name}</p>
          <p style="margin:0 0 8px;color:#333;"><strong>Enterprise:</strong> ${enquiry.enterpriseName || "N/A"}</p>
          <p style="margin:0 0 8px;color:#333;"><strong>Phone:</strong> ${enquiry.phone}</p>
          <p style="margin:0 0 8px;color:#333;"><strong>Email:</strong> ${enquiry.email}</p>
          <p style="margin:0;color:#333;"><strong>Message:</strong> ${enquiry.message || "-"}</p>
        </div>
        <p style="color:#666;font-size:13px;">Submitted on ${new Date(enquiry.createdAt).toLocaleString()}</p>
        <hr style="border:none;border-top:1px solid #fce7f3;margin:20px 0;">
        <p style="color:#999;font-size:12px;text-align:center;">ParroByte CRM &copy; ${new Date().getFullYear()}</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("[Mail] Landing enquiry email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("[Mail] Landing enquiry email failed:", error.message);
    return { success: false, error: error.message };
  }
}

export async function sendInvoiceEmail(to, name, invoiceData, pdfBuffer) {
  const mailOptions = {
    from: `"ParroByte CRM" <${process.env.SMTP_USER || "noreply@whatsappcrm.com"}>`,
    to,
    subject: `Invoice #INV-${invoiceData.invoiceId} - ParroByte CRM`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #fce7f3;border-radius:16px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="color:#ec4899;margin:0;">ParroByte CRM</h2>
          <p style="color:#666;margin:5px 0 0;">Payment Confirmation</p>
        </div>
        <p style="color:#333;">Hi ${name || "there"},</p>
        <p style="color:#333;">Thank you for your purchase! Your payment has been received successfully.</p>
        <div style="background:#fdf2f8;padding:15px;border-radius:12px;margin:20px 0;">
          <p style="margin:0;color:#be185d;font-weight:bold;">Invoice #INV-${invoiceData.invoiceId}</p>
          <p style="margin:5px 0 0;color:#666;font-size:13px;">Amount: ₹${invoiceData.amount}</p>
          <p style="margin:5px 0 0;color:#666;font-size:13px;">Package: ${invoiceData.packageName}</p>
        </div>
        <p style="color:#666;font-size:13px;">Your invoice is attached to this email. Credits have been added to your account.</p>
        <hr style="border:none;border-top:1px solid #fce7f3;margin:20px 0;">
        <p style="color:#999;font-size:12px;text-align:center;">ParroByte CRM &copy; ${new Date().getFullYear()}</p>
      </div>
    `,
    attachments: [
      {
        filename: `Invoice_INV-${invoiceData.invoiceId}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("[Mail] Invoice email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("[Mail] Invoice email failed:", error.message);
    return { success: false, error: error.message };
  }
}
