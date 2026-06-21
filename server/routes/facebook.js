import express from "express";
import { db } from "../lib/db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const router = express.Router();

const FB_APP_ID = process.env.FACEBOOK_APP_ID || "";
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET || "";
const FB_REDIRECT_URI = process.env.APP_URL
  ? `${process.env.APP_URL}/social-automation/facebook/callback`
  : "http://localhost:3000/social-automation/facebook/callback";

/** Step 1: Redirect to Facebook OAuth */
router.get("/auth", async (req, res) => {
  if (!FB_APP_ID) {
    req.flash("error", "Facebook App ID not configured. Set FACEBOOK_APP_ID in your .env file.");
    return res.redirect("/social-automation");
  }

  const state = Buffer.from(JSON.stringify({
    userId: req.session.user.id,
    nonce: Date.now(),
  })).toString("base64");

  const scopes = [
    "pages_messaging",
    "pages_read_engagement",
    "pages_manage_metadata",
    "pages_show_list",
    "instagram_basic",
    "instagram_messaging",
  ].join(",");

  const fbAuthUrl = `https://www.facebook.com/v18.0/dialog/oauth?` +
    `client_id=${FB_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code`;

  res.redirect(fbAuthUrl);
});

/** Step 2: OAuth callback - exchange code for token */
router.get("/callback", async (req, res) => {
  try {
    const { code, error: fbError, error_description } = req.query;

    if (fbError) {
      req.flash("error", `Facebook login failed: ${error_description || fbError}`);
      return res.redirect("/social-automation");
    }
    if (!code) {
      req.flash("error", "No authorization code from Facebook");
      return res.redirect("/social-automation");
    }

    // Exchange code for user access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?` +
      `client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      req.flash("error", `Token error: ${tokenData.error.message}`);
      return res.redirect("/social-automation");
    }

    // Get user's pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenData.access_token}&fields=id,name,access_token,picture`
    );
    const pagesData = await pagesRes.json();

    if (pagesData.error) {
      req.flash("error", `Failed to fetch pages: ${pagesData.error.message}`);
      return res.redirect("/social-automation");
    }

    // Store user token temporarily (pages not selected yet)
    req.session.facebookUserToken = tokenData.access_token;
    req.session.facebookPages = pagesData.data || [];

    res.redirect("/social-automation/facebook/pages");
  } catch (err) {
    console.error("Facebook callback error:", err);
    req.flash("error", "Facebook connection failed");
    res.redirect("/social-automation");
  }
});

/** Step 3: Show pages for selection */
router.get("/pages", async (req, res) => {
  const pages = req.session.facebookPages || [];
  if (!pages.length) {
    req.flash("error", "No Facebook pages found. Make sure you are an admin of at least one Facebook Page.");
    return res.redirect("/social-automation");
  }
  res.render("pages/socialAutomation/facebookPages", {
    title: "Select Facebook Page",
    layout: "layout",
    pages,
    user: req.session.user,
  });
});

/** Step 4: Connect selected page */
router.post("/connect-page", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { pageId, pageToken, pageName } = req.body;

    // Subscribe page to messaging webhooks
    const subRes = await fetch(
      `https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: pageToken,
          subscribed_fields: ["messages", "messaging_postbacks"],
        }),
      }
    );
    const subData = await subRes.json();
    if (subData.error) {
      console.error("Webhook subscribe error:", subData.error);
    }

    // Upsert into social_accounts
    const existing = await db.select().from(schema.socialAccounts)
      .where(and(
        eq(schema.socialAccounts.userId, userId),
        eq(schema.socialAccounts.platform, "facebook")
      ));

    if (existing.length > 0) {
      await db.update(schema.socialAccounts)
        .set({
          accountName: pageName,
          pageId,
          accessToken: pageToken,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(schema.socialAccounts.id, existing[0].id));
    } else {
      await db.insert(schema.socialAccounts).values({
        userId,
        platform: "facebook",
        accountName: pageName,
        pageId,
        accessToken: pageToken,
        isActive: true,
      });
    }

    // Clean up session
    delete req.session.facebookUserToken;
    delete req.session.facebookPages;

    req.flash("success", `Facebook Page "${pageName}" connected! Messages will now appear in your Leads.`);
    res.redirect("/social-automation");
  } catch (err) {
    console.error("Connect page error:", err);
    req.flash("error", "Failed to connect page");
    res.redirect("/social-automation");
  }
});

/** Disconnect Facebook */
router.post("/disconnect", async (req, res) => {
  try {
    await db.update(schema.socialAccounts)
      .set({ isActive: false, accessToken: null, updatedAt: new Date() })
      .where(and(
        eq(schema.socialAccounts.userId, req.session.user.id),
        eq(schema.socialAccounts.platform, "facebook")
      ));
    req.flash("success", "Facebook disconnected");
  } catch (err) {
    req.flash("error", "Disconnect failed");
  }
  res.redirect("/social-automation");
});

/** Facebook Webhook Verification (GET) */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const VERIFY_TOKEN = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || "parrobyte_crm_verify";

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[FB Webhook] Verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

/** Facebook Webhook - Receive Messages (POST) */
router.post("/webhook", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body;
    if (body.object !== "page") return;

    for (const entry of body.entry) {
      const pageId = entry.id;
      for (const event of entry.messaging || []) {
        if (event.message && event.message.is_echo) continue;

        const senderId = event.sender.id;

        // Find which user owns this page
        const accounts = await db.select().from(schema.socialAccounts)
          .where(and(eq(schema.socialAccounts.pageId, pageId), eq(schema.socialAccounts.isActive, true)));

        if (!accounts.length) continue;
        const userId = accounts[0].userId;

        if (event.message && event.message.text) {
          const text = event.message.text;
          console.log(`[FB Webhook] Page ${pageId} | From ${senderId}: ${text}`);

          // Save as lead
          try {
            await db.insert(schema.leads).values({
              userId,
              name: `FB ${senderId.slice(0, 8)}`,
              source: "facebook",
              notes: text,
              status: "new",
            });
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error("[FB Webhook] Error:", err.message);
  }
});

export default router;
