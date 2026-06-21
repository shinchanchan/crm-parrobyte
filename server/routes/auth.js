import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { body, validationResult } from "express-validator";
import { db } from "../lib/db.js";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../lib/mail.js";
import { addCredits } from "../lib/credits.js";

const router = express.Router();

// Generate secure password hash
function generateSecurePassword(password) {
  const salt = bcrypt.genSaltSync(12);
  return bcrypt.hashSync(password, salt);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// Generate 6-digit OTP
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Generate session token for single-login enforcement
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ============== REGISTRATION ==============

router.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("pages/auth/register", { title: "Register - ParroByte CRM", layout: false });
});

router.post("/register", [
  body("name").trim().isLength({ min: 2, max: 255 }),
  body("email").isEmail().normalizeEmail(),
  body("password").isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash("error", "Please check your input and try again");
      return res.redirect("/auth/register");
    }

    const { name, email, password, countryCode } = req.body;

    // Check if email exists
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing.length) {
      req.flash("error", "Email already registered");
      return res.redirect("/auth/register");
    }

    // Generate OTP
    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const hashedPassword = generateSecurePassword(password);

    const result = await db.insert(schema.users).values({
      name,
      email,
      password: hashedPassword,
      role: "user",
      credits: 10,
      plan: "free",
      maxSessions: 1,
      countryCode: countryCode || "+1",
      isActive: true,
      emailVerified: false,
      emailOtp: otp,
      emailOtpExpiry: otpExpiry,
      sessionToken: null,
    }).returning();

    const newUser = result[0];

    // Give 50 free signup credits
    await addCredits(newUser.id, 20, "signup_bonus", "Welcome bonus for new user");

    // Send OTP email
    const emailResult = await sendOtpEmail(email, name, otp);
    if (!emailResult.success) {
      console.error("Failed to send OTP email:", emailResult.error);
    }

    // Store pending verification in session
    req.session.pendingVerification = { userId: newUser.id, email };

    req.flash("success", "Account created! Please verify your email with the OTP sent to your inbox.");
    res.redirect("/auth/verify-otp");
  } catch (error) {
    console.error("Registration error:", error);
    req.flash("error", "Registration failed. Please try again.");
    res.redirect("/auth/register");
  }
});

// ============== OTP VERIFICATION ==============

router.get("/verify-otp", async (req, res) => {
  if (!req.session.pendingVerification) {
    return res.redirect("/auth/login");
  }
  res.render("pages/auth/verify-otp", {
    title: "Verify Email - ParroByte CRM",
    layout: false,
    email: req.session.pendingVerification.email,
  });
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { otp } = req.body;
    const pending = req.session.pendingVerification;

    if (!pending) {
      req.flash("error", "Verification session expired");
      return res.redirect("/auth/login");
    }

    const users = await db.select().from(schema.users).where(eq(schema.users.id, pending.userId));
    if (!users.length) {
      req.flash("error", "User not found");
      return res.redirect("/auth/register");
    }

    const user = users[0];

    // Check OTP
    if (user.emailOtp !== otp) {
      req.flash("error", "Invalid OTP. Please try again.");
      return res.redirect("/auth/verify-otp");
    }

    // Check expiry
    if (user.emailOtpExpiry && new Date(user.emailOtpExpiry) < new Date()) {
      req.flash("error", "OTP expired. Please request a new one.");
      return res.redirect("/auth/verify-otp");
    }

    // Mark email verified
    await db.update(schema.users)
      .set({ emailVerified: true, emailOtp: null, emailOtpExpiry: null })
      .where(eq(schema.users.id, user.id));

    // Clear pending verification
    delete req.session.pendingVerification;

    // Auto-login after verification
    const sessionToken = generateSessionToken();
    await db.update(schema.users)
      .set({ sessionToken, lastLogin: new Date() })
      .where(eq(schema.users.id, user.id));

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      credits: user.credits,
      avatar: user.avatar,
      countryCode: user.countryCode,
      themeColor: user.themeColor || "#ec4899",
      _token: sessionToken,
    };

    req.flash("success", "Email verified! Welcome aboard.");
    res.redirect("/dashboard");
  } catch (error) {
    console.error("OTP verify error:", error);
    req.flash("error", "Verification failed");
    res.redirect("/auth/verify-otp");
  }
});

// Resend OTP
router.post("/resend-otp", async (req, res) => {
  try {
    const pending = req.session.pendingVerification;
    if (!pending) {
      req.flash("error", "Session expired. Please register again.");
      return res.redirect("/auth/register");
    }

    const users = await db.select().from(schema.users).where(eq(schema.users.id, pending.userId));
    if (!users.length) {
      req.flash("error", "User not found");
      return res.redirect("/auth/register");
    }

    const user = users[0];
    const newOtp = generateOtp();
    const newExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await db.update(schema.users)
      .set({ emailOtp: newOtp, emailOtpExpiry: newExpiry })
      .where(eq(schema.users.id, user.id));

    const emailResult = await sendOtpEmail(user.email, user.name, newOtp);
    if (!emailResult.success) {
      console.error("Failed to resend OTP:", emailResult.error);
    }

    req.flash("success", "New OTP sent to your email!");
    res.redirect("/auth/verify-otp");
  } catch (error) {
    req.flash("error", "Failed to resend OTP");
    res.redirect("/auth/verify-otp");
  }
});

// ============== LOGIN ==============

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("pages/auth/login", { title: "Login - ParroByte CRM", layout: false });
});

router.post("/login", [
  body("email").isEmail().normalizeEmail(),
  body("password").isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash("error", "Invalid input data");
      return res.redirect("/auth/login");
    }

    const { email, password } = req.body;

    const users = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!users.length) {
      req.flash("error", "Invalid email or password");
      return res.redirect("/auth/login");
    }

    const user = users[0];

    if (!user.isActive) {
      req.flash("error", "Account is disabled");
      return res.redirect("/auth/login");
    }

    // Check email verified (first-time registration)
    if (!user.emailVerified) {
      const newOtp = generateOtp();
      const newExpiry = new Date(Date.now() + 10 * 60 * 1000);
      await db.update(schema.users)
        .set({ emailOtp: newOtp, emailOtpExpiry: newExpiry })
        .where(eq(schema.users.id, user.id));

      await sendOtpEmail(user.email, user.name, newOtp);
      req.session.pendingVerification = { userId: user.id, email: user.email };

      req.flash("error", "Email not verified. Please verify with the OTP sent to your email.");
      return res.redirect("/auth/verify-otp");
    }

    if (!verifyPassword(password, user.password)) {
      req.flash("error", "Invalid email or password");
      return res.redirect("/auth/login");
    }

    // ===== OTP REQUIRED ON EVERY LOGIN =====
    // Password is correct - now send login OTP
    const loginOtp = generateOtp();
    const loginOtpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await db.update(schema.users)
      .set({ emailOtp: loginOtp, emailOtpExpiry: loginOtpExpiry })
      .where(eq(schema.users.id, user.id));

    const emailResult = await sendOtpEmail(user.email, user.name, loginOtp);
    if (!emailResult.success) {
      console.error("[Login OTP] Failed to send:", emailResult.error);
      req.flash("error", "Failed to send login OTP. Please try again.");
      return res.redirect("/auth/login");
    }

    // Store pending login in session (not fully logged in yet)
    req.session.pendingLogin = {
      userId: user.id,
      email: user.email,
    };

    // Show loading page while OTP is being delivered
    res.render("pages/auth/sending-otp", {
      title: "Sending OTP - ParroByte CRM",
      layout: false,
      email: user.email,
    });
  } catch (error) {
    console.error("Login error:", error);
    req.flash("error", "An error occurred. Please try again.");
    res.redirect("/auth/login");
  }
});

// ===== LOGIN OTP VERIFICATION =====
// Separate endpoint from registration OTP - completes login after OTP

router.get("/verify-login-otp", async (req, res) => {
  if (!req.session.pendingLogin) {
    return res.redirect("/auth/login");
  }
  res.render("pages/auth/verify-login-otp", {
    title: "Verify Login - ParroByte CRM",
    layout: false,
    email: req.session.pendingLogin.email,
  });
});

router.post("/verify-login-otp", async (req, res) => {
  try {
    const { otp } = req.body;
    const pending = req.session.pendingLogin;

    if (!pending) {
      req.flash("error", "Login session expired. Please login again.");
      return res.redirect("/auth/login");
    }

    const users = await db.select().from(schema.users).where(eq(schema.users.id, pending.userId));
    if (!users.length) {
      req.flash("error", "User not found");
      return res.redirect("/auth/login");
    }

    const user = users[0];

    // Check OTP match
    if (user.emailOtp !== otp) {
      req.flash("error", "Invalid OTP. Please try again.");
      return res.redirect("/auth/verify-login-otp");
    }

    // Check OTP expiry
    if (user.emailOtpExpiry && new Date(user.emailOtpExpiry) < new Date()) {
      req.flash("error", "OTP expired. Please login again to receive a new one.");
      delete req.session.pendingLogin;
      return res.redirect("/auth/login");
    }

    // OTP verified - clear OTP and complete login
    await db.update(schema.users)
      .set({ emailOtp: null, emailOtpExpiry: null })
      .where(eq(schema.users.id, user.id));

    // ===== SINGLE LOGIN ENFORCEMENT =====
    const sessionToken = generateSessionToken();

    await db.update(schema.users)
      .set({ sessionToken, lastLogin: new Date() })
      .where(eq(schema.users.id, user.id));

    delete req.session.pendingLogin;

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      credits: user.credits,
      avatar: user.avatar,
      countryCode: user.countryCode,
      themeColor: user.themeColor || "#ec4899",
      _token: sessionToken,
    };

    // Auto-cleanup old bulk message jobs: keep only latest 100 per user
    try {
      const cleanupResult = await db.execute(sql`
        DELETE FROM bulk_message_jobs
        WHERE user_id = ${user.id}
        AND id NOT IN (
          SELECT id FROM bulk_message_jobs
          WHERE user_id = ${user.id}
          ORDER BY created_at DESC
          LIMIT 100
        )
      `);
      if (cleanupResult.rowCount > 0) {
        console.log(`[LoginCleanup] Removed ${cleanupResult.rowCount} old bulk job(s) for user ${user.id}`);
      }
    } catch (cleanupErr) {
      console.error("[LoginCleanup] Failed:", cleanupErr.message);
    }

    req.flash("success", `Welcome back, ${user.name}!`);
    res.redirect("/dashboard");
  } catch (error) {
    console.error("Login OTP verify error:", error);
    req.flash("error", "Verification failed. Please try again.");
    res.redirect("/auth/verify-login-otp");
  }
});

// Resend login OTP
router.post("/resend-login-otp", async (req, res) => {
  try {
    const pending = req.session.pendingLogin;
    if (!pending) {
      req.flash("error", "Session expired. Please login again.");
      return res.redirect("/auth/login");
    }

    const users = await db.select().from(schema.users).where(eq(schema.users.id, pending.userId));
    if (!users.length) {
      req.flash("error", "User not found");
      return res.redirect("/auth/login");
    }

    const user = users[0];
    const newOtp = generateOtp();
    const newExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await db.update(schema.users)
      .set({ emailOtp: newOtp, emailOtpExpiry: newExpiry })
      .where(eq(schema.users.id, user.id));

    await sendOtpEmail(user.email, user.name, newOtp);

    req.flash("success", "New OTP sent to your email!");
    res.redirect("/auth/verify-login-otp");
  } catch (error) {
    req.flash("error", "Failed to resend OTP");
    res.redirect("/auth/verify-login-otp");
  }
});

// ============== FORGOT PASSWORD ==============

router.get("/forgot-password", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("pages/auth/forgot-password", { title: "Forgot Password - ParroByte CRM", layout: false });
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      req.flash("error", "Please enter your email address");
      return res.redirect("/auth/forgot-password");
    }

    const users = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!users.length) {
      // Don't reveal if email exists
      req.flash("success", "If an account exists with this email, you will receive a password reset code.");
      return res.redirect("/auth/forgot-password");
    }

    const user = users[0];
    // Generate a secure 6-digit reset code (dedicated column, no collision)
    const resetCode = generateOtp();
    const resetExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await db.update(schema.users)
      .set({ passwordResetToken: resetCode, passwordResetExpiry: resetExpiry })
      .where(eq(schema.users.id, user.id));

    const emailResult = await sendPasswordResetEmail(user.email, user.name, resetCode);
    if (!emailResult.success) {
      console.error("[Forgot Password] Failed to send email:", emailResult.error);
      // Clear the token since email failed
      await db.update(schema.users)
        .set({ passwordResetToken: null, passwordResetExpiry: null })
        .where(eq(schema.users.id, user.id));
      req.flash("error", "Failed to send reset email. Please check your email configuration or try again later.");
      return res.redirect("/auth/forgot-password");
    }

    req.session.pendingReset = { userId: user.id, email: user.email };
    req.flash("success", "Password reset code sent to your email. Check your inbox (and spam folder).");
    res.redirect("/auth/reset-password");
  } catch (error) {
    console.error("Forgot password error:", error);
    req.flash("error", "Something went wrong. Please try again.");
    res.redirect("/auth/forgot-password");
  }
});

router.get("/reset-password", (req, res) => {
  if (!req.session.pendingReset) {
    return res.redirect("/auth/forgot-password");
  }
  res.render("pages/auth/reset-password", {
    title: "Reset Password - ParroByte CRM",
    layout: false,
    email: req.session.pendingReset.email,
  });
});

router.post("/reset-password", async (req, res) => {
  try {
    const { email, code, password, confirmPassword } = req.body;
    const pending = req.session.pendingReset;

    if (!pending) {
      req.flash("error", "Session expired. Please try again.");
      return res.redirect("/auth/forgot-password");
    }

    if (password !== confirmPassword) {
      req.flash("error", "Passwords do not match.");
      return res.redirect("/auth/reset-password");
    }

    const users = await db.select().from(schema.users).where(eq(schema.users.id, pending.userId));
    if (!users.length) {
      req.flash("error", "User not found");
      return res.redirect("/auth/forgot-password");
    }

    const user = users[0];

    if (user.passwordResetToken !== code) {
      req.flash("error", "Invalid code. Please try again.");
      return res.redirect("/auth/reset-password");
    }

    if (user.passwordResetExpiry && new Date(user.passwordResetExpiry) < new Date()) {
      req.flash("error", "Code expired. Please request a new one.");
      delete req.session.pendingReset;
      return res.redirect("/auth/forgot-password");
    }

    const hashedPassword = generateSecurePassword(password);
    await db.update(schema.users)
      .set({ password: hashedPassword, passwordResetToken: null, passwordResetExpiry: null })
      .where(eq(schema.users.id, user.id));

    delete req.session.pendingReset;

    req.flash("success", "Password reset successfully! Please login with your new password.");
    res.redirect("/auth/login");
  } catch (error) {
    console.error("Reset password error:", error);
    req.flash("error", "Failed to reset password. Please try again.");
    res.redirect("/auth/reset-password");
  }
});

// ============== PROFILE ==============

router.get("/profile", async (req, res) => {
  if (!req.session.user) return res.redirect("/auth/login");

  const users = await db.select().from(schema.users)
    .where(eq(schema.users.id, req.session.user.id));

  res.render("pages/auth/profile", {
    title: "My Profile - ParroByte CRM",
    user: users[0],
  });
});

router.post("/profile", async (req, res) => {
  try {
    if (!req.session.user) return res.redirect("/auth/login");

    const { name, countryCode, timezone, themeColor } = req.body;

    await db.update(schema.users)
      .set({ name, countryCode, timezone, themeColor: themeColor || "#ec4899", updatedAt: new Date() })
      .where(eq(schema.users.id, req.session.user.id));

    req.session.user.name = name;
    req.session.user.countryCode = countryCode;
    req.session.user.themeColor = themeColor || "#ec4899";
    req.flash("success", "Profile updated successfully");
    res.redirect("/auth/profile");
  } catch (error) {
    req.flash("error", "Failed to update profile");
    res.redirect("/auth/profile");
  }
});

router.post("/change-password", async (req, res) => {
  try {
    if (!req.session.user) return res.redirect("/auth/login");

    const { currentPassword, newPassword } = req.body;

    const users = await db.select().from(schema.users)
      .where(eq(schema.users.id, req.session.user.id));

    if (!verifyPassword(currentPassword, users[0].password)) {
      req.flash("error", "Current password is incorrect");
      return res.redirect("/auth/profile");
    }

    const hashedPassword = generateSecurePassword(newPassword);
    await db.update(schema.users)
      .set({ password: hashedPassword })
      .where(eq(schema.users.id, req.session.user.id));

    req.flash("success", "Password changed successfully");
    res.redirect("/auth/profile");
  } catch (error) {
    req.flash("error", "Failed to change password");
    res.redirect("/auth/profile");
  }
});

export default router;
