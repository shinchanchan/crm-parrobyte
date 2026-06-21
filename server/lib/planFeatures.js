/**
 * Plan-based Feature Control
 * Admin configures which features are available per plan tier.
 * Features are stored as JSON in the plans.features column.
 */
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "../../db/schema.js";

// Default feature configuration for each plan
const DEFAULT_FEATURES = {
  free: {
    dashboard: true,
    sessions: true,
    contacts: true,
    templates: true,
    bulk: true,
    schedule: true,
    autoReply: true,
    enquiryForms: true,
    leads: true,
    billing: true,
    help: true,
    aiAssistant: false,
    socialAutomation: false,
    youtube: false,
    instagram: false,
    scraper: false,
    apiKeys: false,
    webhooks: false,
    polls: false,
    developer: false,
  },
  silver: {
    dashboard: true,
    sessions: true,
    contacts: true,
    templates: true,
    bulk: true,
    schedule: true,
    autoReply: true,
    enquiryForms: true,
    leads: true,
    billing: true,
    help: true,
    aiAssistant: true,
    scraper: true,
    apiKeys: true,
    webhooks: true,
    polls: true,
    developer: true,
    socialAutomation: false,
    youtube: false,
    instagram: false,
  },
  gold: {
    dashboard: true,
    sessions: true,
    contacts: true,
    templates: true,
    bulk: true,
    schedule: true,
    autoReply: true,
    enquiryForms: true,
    leads: true,
    billing: true,
    help: true,
    aiAssistant: true,
    scraper: true,
    apiKeys: true,
    webhooks: true,
    polls: true,
    developer: true,
    socialAutomation: true,
    youtube: true,
    instagram: true,
  },
  platinum: {
    dashboard: true,
    sessions: true,
    contacts: true,
    templates: true,
    bulk: true,
    schedule: true,
    autoReply: true,
    enquiryForms: true,
    leads: true,
    billing: true,
    help: true,
    aiAssistant: true,
    scraper: true,
    apiKeys: true,
    webhooks: true,
    developer: true,
    socialAutomation: true,
    youtube: true,
    instagram: true,
  },
};

// Feature display metadata
const FEATURE_META = {
  dashboard: { label: "Dashboard", icon: "ri-dashboard-line", desc: "View your analytics and activity overview" },
  sessions: { label: "WhatsApp Sessions", icon: "ri-qr-code-line", desc: "Connect and manage WhatsApp accounts" },
  contacts: { label: "Contacts", icon: "ri-contacts-line", desc: "Manage your contact list and groups" },
  templates: { label: "Message Templates", icon: "ri-file-list-line", desc: "Create reusable message templates" },
  bulk: { label: "Bulk Messages", icon: "ri-send-plane-fill", desc: "Send messages to multiple contacts at once" },
  schedule: { label: "Schedule Messages", icon: "ri-calendar-schedule-line", desc: "Schedule messages for later delivery" },
  autoReply: { label: "Auto Reply", icon: "ri-robot-line", desc: "Automatic replies based on keywords or AI" },
  aiAssistant: { label: "AI Assistant", icon: "ri-brain-line", desc: "AI-powered responses using Ollama" },
  socialAutomation: { label: "Social Automation", icon: "ri-messenger-line", desc: "Automate Facebook and Instagram DMs" },
  youtube: { label: "YouTube Automation", icon: "ri-youtube-line", desc: "Auto-reply to YouTube comments" },
  instagram: { label: "Instagram Automation", icon: "ri-instagram-line", desc: "Auto-reply to Instagram comments" },
  enquiryForms: { label: "Enquiry Forms", icon: "ri-survey-line", desc: "Build forms to capture leads" },
  leads: { label: "Leads", icon: "ri-user-search-line", desc: "View and manage captured leads" },
  scraper: { label: "Business Scraper", icon: "ri-map-pin-line", desc: "Scrape business data from Google Maps" },
  apiKeys: { label: "API Keys", icon: "ri-key-line", desc: "Generate API keys for external integration" },
  webhooks: { label: "Webhooks", icon: "ri-webhook-line", desc: "Receive real-time message notifications" },
  polls: { label: "Poll Results", icon: "ri-bar-chart-box-line", desc: "View WhatsApp poll votes and responses" },
  billing: { label: "Billing & Plans", icon: "ri-bill-line", desc: "Manage your subscription" },
  developer: { label: "Developer API", icon: "ri-code-box-line", desc: "REST API documentation and testing" },
  help: { label: "Help Center", icon: "ri-question-line", desc: "Support and documentation" },
};

/** Get features for a user's plan (merged: admin config overrides defaults) */
export async function getPlanFeatures(planName) {
  try {
    const planRows = await db.select().from(schema.plans).where(eq(schema.plans.name, planName));
    const defaults = DEFAULT_FEATURES[planName] || DEFAULT_FEATURES.free;
    if (!planRows.length || !planRows[0].features) return defaults;
    let adminFeatures = {};
    try {
      adminFeatures = JSON.parse(planRows[0].features);
    } catch (e) {
      return defaults;
    }
    return { ...defaults, ...adminFeatures };
  } catch (err) {
    console.error("[PlanFeatures] Error:", err.message);
    return DEFAULT_FEATURES[planName] || DEFAULT_FEATURES.free;
  }
}

/** Get ALL feature metadata */
export function getAllFeatureMeta() {
  return FEATURE_META;
}

/** Get feature metadata for a single feature */
export function getFeatureMeta(featureKey) {
  return FEATURE_META[featureKey] || { label: featureKey, icon: "ri-apps-line", desc: "" };
}

/** Find which plans have a specific feature enabled */
export async function getFeaturePlanMap(featureKey) {
  const planNames = ["free", "silver", "gold", "platinum"];
  const result = [];
  for (const name of planNames) {
    const features = await getPlanFeatures(name);
    result.push({
      name,
      hasFeature: !!features[featureKey],
    });
  }
  return result;
}

/** Get user's feature availability with plan info */
export async function getUserFeatureStatus(userId, planName) {
  const features = await getPlanFeatures(planName);
  const status = {};
  for (const key of Object.keys(FEATURE_META)) {
    status[key] = {
      enabled: !!features[key],
      meta: FEATURE_META[key],
    };
  }
  return status;
}

/** Middleware: feature visibility check (credit-based: all features visible) */
export function requireFeature(featureKey) {
  return async (req, res, next) => {
    // Credit-based system: all features are accessible
    // Credits control usage at the action level, not visibility
    next();
  };
}

/** Get default features for a plan (for seeding) */
export function getDefaultFeatures(planName) {
  return DEFAULT_FEATURES[planName] || DEFAULT_FEATURES.free;
}
