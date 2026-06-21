import express from "express";
import { db } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { getUserCredits, getAllCreditConfigs, getUserActiveSubscription, getActiveSubscriptionPlans, isServiceCoveredBySubscription } from "../lib/credits.js";

const router = express.Router();

const CREDIT_PACKAGES = [
  { id: "starter", name: "Starter", credits: 100, price: 99, currency: "INR", popular: false },
  { id: "pro", name: "Pro", credits: 500, price: 399, currency: "INR", popular: true },
  { id: "business", name: "Business", credits: 2000, price: 1299, currency: "INR", popular: false },
  { id: "enterprise", name: "Enterprise", credits: 10000, price: 4999, currency: "INR", popular: false },
];

// User billing / credits
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const invoices = await db.select().from(schema.invoices).where(eq(schema.invoices.userId, userId)).orderBy(desc(schema.invoices.createdAt));
    const creditBalance = await getUserCredits(userId);

    // Get credit transaction history
    const transactions = await db.select().from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, userId))
      .orderBy(desc(schema.creditTransactions.createdAt));

    // Get active service packages
    const servicePackages = await db.select().from(schema.servicePackages)
      .where(eq(schema.servicePackages.isActive, true))
      .orderBy(schema.servicePackages.sortOrder);

    // Get credit configs for service icons
    const creditConfigs = await getAllCreditConfigs();

    // Get subscription data
    const activeSubscription = await getUserActiveSubscription(userId);
    const subscriptionPlans = await getActiveSubscriptionPlans();

    res.render("pages/billing/index", {
      title: "Billing & Credits - ParroByte CRM",
      user: user[0],
      creditBalance,
      creditPackages: CREDIT_PACKAGES,
      servicePackages,
      creditConfigs,
      transactions: transactions.slice(0, 50),
      invoices,
      activeSubscription,
      subscriptionPlans,
    });
  } catch (error) {
    console.error("Billing error:", error);
    req.flash("error", "Failed to load billing");
    res.redirect("/dashboard");
  }
});

// Service cards view — shows all services with credit costs
router.get("/services", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const creditBalance = await getUserCredits(userId);
    const configs = await getAllCreditConfigs();
    const activeSubscription = await getUserActiveSubscription(userId);

    const serviceIcons = {
      send_message: "ri-send-plane-line",
      incoming_message: "ri-message-3-line",
      ai_reply: "ri-brain-line",
      create_contact: "ri-contacts-line",
      create_template: "ri-file-list-line",
      scrape: "ri-map-pin-line",
      schedule_message: "ri-calendar-schedule-line",
      auto_reply: "ri-robot-line",
      create_session: "ri-qr-code-line",
      social_automation: "ri-messenger-line",
      api_key: "ri-key-line",
      webhook: "ri-webhook-line",
      poll_results: "ri-bar-chart-box-line",
      create_form: "ri-survey-line",
      lead_import: "ri-user-search-line",
      youtube_rule: "ri-youtube-line",
      instagram_rule: "ri-instagram-line",
    };

    // Mark services covered by subscription
    let includedServices = [];
    if (activeSubscription) {
      try { includedServices = JSON.parse(activeSubscription.plan.includedServices || '[]'); } catch(e) {}
    }

    const services = configs.map(cfg => ({
      ...cfg,
      icon: serviceIcons[cfg.serviceKey] || "ri-apps-line",
      isSubscribed: includedServices.includes(cfg.serviceKey) || includedServices.includes("*"),
    }));

    res.render("pages/billing/services", {
      title: "Services & Pricing - ParroByte CRM",
      creditBalance,
      services,
      activeSubscription,
    });
  } catch (error) {
    console.error("Services page error:", error);
    req.flash("error", "Failed to load services");
    res.redirect("/billing");
  }
});

// All transactions view
router.get("/transactions", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const creditBalance = await getUserCredits(userId);

    // Get ALL credit transaction history
    const transactions = await db.select().from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, userId))
      .orderBy(desc(schema.creditTransactions.createdAt));

    res.render("pages/billing/transactions", {
      title: "Transaction History - ParroByte CRM",
      creditBalance,
      transactions,
    });
  } catch (error) {
    console.error("Transactions page error:", error);
    req.flash("error", "Failed to load transactions");
    res.redirect("/billing");
  }
});

export default router;
