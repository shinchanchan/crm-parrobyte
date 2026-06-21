import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import {
  getAuthUrl,
  exchangeCode,
  getLongLivedToken,
  getInstagramBusinessAccount,
  subscribePageToWebhooks,
  processCommentsForUser,
  testConnection,
  simulateRuleMatch,
  fetchMediaComments,
  getDmConversations,
  getDmMessages,
  sendManualDm,
} from "../lib/instagram.js";

const router = express.Router();

// Main Instagram settings page
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const connRows = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));
    const connection = connRows[0] || null;

    const rules = await db.select().from(schema.instagramReplyRules)
      .where(eq(schema.instagramReplyRules.userId, userId))
      .orderBy(desc(schema.instagramReplyRules.createdAt));

    const repliedComments = await db.select().from(schema.instagramRepliedComments)
      .where(eq(schema.instagramRepliedComments.userId, userId))
      .orderBy(desc(schema.instagramRepliedComments.repliedAt))
      .limit(50);

    const dmConversations = await db.select().from(schema.instagramDmConversations)
      .where(eq(schema.instagramDmConversations.userId, userId))
      .orderBy(desc(schema.instagramDmConversations.lastMessageAt))
      .limit(50);

    const oauthConfigured = !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

    const processResult = req.session.instagramProcessResult || null;
    delete req.session.instagramProcessResult;

    res.render("pages/instagram/index", {
      title: "Instagram Automation - ParroByte CRM",
      connection,
      rules,
      repliedComments,
      dmConversations,
      oauthConfigured,
      isAdmin,
      processResult,
    });
  } catch (error) {
    console.error("Instagram page error:", error);
    req.flash("error", "Failed to load Instagram settings");
    res.redirect("/dashboard");
  }
});

// Start OAuth flow
router.get("/oauth/start", async (req, res) => {
  try {
    if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
      req.flash("error", "Facebook app credentials not configured.");
      return res.redirect("/instagram");
    }
    const userId = req.session.user.id;
    const url = getAuthUrl(String(userId));
    res.redirect(url);
  } catch (error) {
    console.error("Instagram OAuth start error:", error);
    req.flash("error", "Failed to start Instagram connection");
    res.redirect("/instagram");
  }
});

// OAuth callback
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    const userId = parseInt(state);

    if (oauthError) {
      req.flash("error", `Instagram connection denied: ${oauthError}`);
      return res.redirect("/instagram");
    }

    if (!code || !userId) {
      req.flash("error", "Invalid Instagram callback");
      return res.redirect("/instagram");
    }

    // Exchange code for short-lived token
    const shortToken = await exchangeCode(code);

    // Exchange for long-lived token (60 days)
    const longToken = await getLongLivedToken(shortToken.access_token);

    // Get Instagram Business Account
    const igAccount = await getInstagramBusinessAccount(longToken.access_token);
    if (!igAccount) {
      req.flash("error", "No Instagram Business Account found. Please connect an Instagram Business/Creator account to a Facebook Page.");
      return res.redirect("/instagram");
    }

    // Upsert connection
    const existing = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    // Subscribe page to messaging webhooks
    if (igAccount.pageAccessToken) {
      await subscribePageToWebhooks(igAccount.pageId, igAccount.pageAccessToken);
    }

    const connData = {
      userId,
      pageId: igAccount.pageId,
      pageName: igAccount.pageName,
      instagramId: igAccount.instagramId,
      instagramUsername: igAccount.instagramUsername,
      pageAccessToken: igAccount.pageAccessToken,
      accessToken: longToken.access_token,
      tokenExpiry: longToken.expires_in
        ? new Date(Date.now() + longToken.expires_in * 1000)
        : new Date(Date.now() + 5184000 * 1000), // 60 days fallback
      isActive: true,
      updatedAt: new Date(),
    };

    if (existing.length) {
      await db.update(schema.instagramConnections)
        .set(connData)
        .where(eq(schema.instagramConnections.userId, userId));
    } else {
      await db.insert(schema.instagramConnections).values({
        ...connData,
        createdAt: new Date(),
      });
    }

    req.flash("success", `Instagram @${igAccount.instagramUsername} connected successfully!`);
    res.redirect("/instagram");
  } catch (error) {
    console.error("Instagram OAuth callback error:", error);
    req.flash("error", "Failed to connect Instagram: " + (error.response?.data?.error?.message || error.message));
    res.redirect("/instagram");
  }
});

// Disconnect
router.post("/disconnect", async (req, res) => {
  try {
    const userId = req.session.user.id;
    await db.update(schema.instagramConnections)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(schema.instagramConnections.userId, userId));
    req.flash("success", "Instagram disconnected");
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to disconnect");
    res.redirect("/instagram");
  }
});

// Test connection
router.get("/test-connection", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await testConnection(userId);
    if (!result.success) {
      return res.json({ success: false, error: result.error });
    }
    return res.json({
      success: true,
      account: {
        id: result.account?.id,
        username: result.account?.username,
        mediaCount: result.account?.media_count,
      },
      media: (result.media || []).map(m => ({
        id: m.id,
        caption: m.caption,
        mediaType: m.media_type,
        thumbnail: m.media_url,
        permalink: m.permalink,
        timestamp: m.timestamp,
      })),
    });
  } catch (error) {
    console.error("Test connection error:", error);
    res.json({ success: false, error: error.message });
  }
});

// Create reply rule
router.post("/rules/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, triggerType, triggerValue, responseContent } = req.body;

    if (!name || !triggerValue || !responseContent) {
      req.flash("error", "All fields are required");
      return res.redirect("/instagram");
    }

    await db.insert(schema.instagramReplyRules).values({
      userId,
      name,
      triggerType: triggerType || "contains",
      triggerValue,
      responseContent,
    });

    req.flash("success", "Reply rule created");
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to create rule");
    res.redirect("/instagram");
  }
});

// Update reply rule
router.post("/rules/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, triggerType, triggerValue, responseContent, isActive } = req.body;

    await db.update(schema.instagramReplyRules)
      .set({
        name,
        triggerType,
        triggerValue,
        responseContent,
        isActive: isActive === "on" || isActive === true,
        updatedAt: new Date(),
      })
      .where(eq(schema.instagramReplyRules.id, id));

    req.flash("success", "Reply rule updated");
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to update rule");
    res.redirect("/instagram");
  }
});

// Delete reply rule
router.post("/rules/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(schema.instagramReplyRules).where(eq(schema.instagramReplyRules.id, id));
    req.flash("success", "Reply rule deleted");
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to delete rule");
    res.redirect("/instagram");
  }
});

// Process now
router.post("/process-now", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await processCommentsForUser(userId);
    req.session.instagramProcessResult = result;
    if (result.error && result.replies === 0) {
      req.flash("error", `Error: ${result.error}`);
    } else if (result.error) {
      req.flash("warning", `Partial success: ${result.error}. Processed ${result.processed}, replied ${result.replies}.`);
    } else {
      req.flash("success", `Processed ${result.processed} comments, replied to ${result.replies}.`);
    }
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to process comments: " + error.message);
    res.redirect("/instagram");
  }
});

// Test a reply rule against sample text
router.post("/test-rule", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { sampleText } = req.body;
    if (!sampleText) return res.json({ success: false, error: "Sample text required" });

    const rules = await db.select().from(schema.instagramReplyRules)
      .where(eq(schema.instagramReplyRules.userId, userId));

    const results = rules.map(rule => ({
      id: rule.id,
      name: rule.name,
      triggerType: rule.triggerType,
      triggerValue: rule.triggerValue,
      isActive: rule.isActive,
      matched: simulateRuleMatch(rule.triggerType, rule.triggerValue, sampleText),
      responseContent: rule.responseContent,
    }));

    const matchedRules = results.filter(r => r.matched && r.isActive);
    res.json({ success: true, sampleText, results, matchedRules });
  } catch (error) {
    console.error("Test rule error:", error);
    res.json({ success: false, error: error.message });
  }
});

// Fetch comments for a specific media post (for debugging)
router.get("/comments/:mediaId", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { mediaId } = req.params;
    const result = await fetchMediaComments(userId, mediaId, 20);
    if (!result.success) return res.json({ success: false, error: result.error });

    res.json({ success: true, mediaId, comments: result.comments });
  } catch (error) {
    console.error("Fetch comments error:", error);
    res.json({ success: false, error: error.message });
  }
});

export default router;


// ===== DM (Direct Message) Routes =====

// Get DM conversations
router.get("/dm/conversations", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await getDmConversations(userId, 50);
    if (!result.success) return res.json({ success: false, error: result.error });
    res.json({ success: true, conversations: result.conversations });
  } catch (error) {
    console.error("DM conversations error:", error);
    res.json({ success: false, error: error.message });
  }
});

// Get messages for a conversation
router.get("/dm/conversations/:id/messages", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const conversationId = parseInt(req.params.id);
    const result = await getDmMessages(userId, conversationId, 100);
    if (!result.success) return res.json({ success: false, error: result.error });
    res.json({ success: true, messages: result.messages });
  } catch (error) {
    console.error("DM messages error:", error);
    res.json({ success: false, error: error.message });
  }
});

// Send a manual DM
router.post("/dm/send", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { conversationId, messageText } = req.body;

    if (!conversationId || !messageText?.trim()) {
      return res.json({ success: false, error: "Conversation ID and message text required" });
    }

    const result = await sendManualDm(userId, parseInt(conversationId), messageText.trim());
    res.json(result);
  } catch (error) {
    console.error("Send DM error:", error);
    res.json({ success: false, error: error.message });
  }
});


