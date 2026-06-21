import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import axios from "axios";
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
import {
  getAccountInfo,
  getLinkedPage,
  refreshToken,
  startCommentPolling,
  stopCommentPolling,
  getRecentMedia,
  getMediaComments,
  replyToComment,
  sendPrivateReply,
  sendDirectMessage,
  getSmartReply,
} from "../lib/instagramAutomation.js";

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

    // Start comment polling
    startCommentPolling(userId);

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
    stopCommentPolling(userId);
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
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Create reply rule
router.post("/rules/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, triggerType, triggerValue, responseContent } = req.body;

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
    console.error("Create rule error:", error);
    req.flash("error", "Failed to create rule");
    res.redirect("/instagram");
  }
});

// Delete reply rule
router.post("/rules/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;

    const existing = await db.select().from(schema.instagramReplyRules)
      .where(eq(schema.instagramReplyRules.id, id));
    if (!existing.length || existing[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/instagram");
    }

    await db.delete(schema.instagramReplyRules)
      .where(eq(schema.instagramReplyRules.id, id));

    req.flash("success", "Rule deleted");
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to delete rule");
    res.redirect("/instagram");
  }
});

// Toggle rule active state
router.post("/rules/toggle/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;

    const existing = await db.select().from(schema.instagramReplyRules)
      .where(eq(schema.instagramReplyRules.id, id));
    if (!existing.length || existing[0].userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const newState = !existing[0].isActive;
    await db.update(schema.instagramReplyRules)
      .set({ isActive: newState })
      .where(eq(schema.instagramReplyRules.id, id));

    res.json({ success: true, isActive: newState });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process comments now
router.post("/process-now", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await processCommentsForUser(userId);
    req.session.instagramProcessResult = result;
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Processing failed");
    res.redirect("/instagram");
  }
});

// Simulate rule match
router.post("/rules/simulate", async (req, res) => {
  try {
    const { triggerType, triggerValue, sampleText } = req.body;
    const matched = simulateRuleMatch(triggerType, triggerValue, sampleText);
    res.json({ matched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update reply rule
router.post("/rules/update/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { id } = req.params;
    const { name, triggerType, triggerValue, responseContent } = req.body;

    const existing = await db.select().from(schema.instagramReplyRules)
      .where(eq(schema.instagramReplyRules.id, id));
    if (!existing.length || existing[0].userId !== userId) {
      req.flash("error", "Unauthorized");
      return res.redirect("/instagram");
    }

    await db.update(schema.instagramReplyRules)
      .set({
        name: String(name || "").trim(),
        triggerType: String(triggerType || "contains").trim(),
        triggerValue: String(triggerValue || "").trim(),
        responseContent: String(responseContent || "").trim(),
        updatedAt: new Date(),
      })
      .where(eq(schema.instagramReplyRules.id, id));

    req.flash("success", "Rule updated");
    res.redirect("/instagram");
  } catch (error) {
    console.error("Update rule error:", error);
    req.flash("error", "Failed to update rule");
    res.redirect("/instagram");
  }
});

// Test a rule against sample text
router.post("/test-rule", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { triggerType, triggerValue, sampleText } = req.body;

    const rules = await db.select().from(schema.instagramReplyRules)
      .where(and(
        eq(schema.instagramReplyRules.userId, userId),
        eq(schema.instagramReplyRules.isActive, true)
      ));

    const lowerSample = String(sampleText || "").toLowerCase().trim();
    const lowerTrigger = String(triggerValue || "").toLowerCase().trim();
    let matched = false;

    switch (triggerType) {
      case "exact": matched = lowerSample === lowerTrigger; break;
      case "contains": matched = lowerSample.includes(lowerTrigger); break;
      case "starts_with": matched = lowerSample.startsWith(lowerTrigger); break;
      case "ends_with": matched = lowerSample.endsWith(lowerTrigger); break;
      case "regex":
        try { matched = new RegExp(lowerTrigger, "i").test(sampleText); } catch (e) {}
        break;
    }

    res.json({ success: true, matched, triggerType, triggerValue, sampleText });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get comments for a media (debug)
router.get("/comments/:mediaId", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { mediaId } = req.params;
    const conn = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    if (!conn.length) return res.status(401).json({ error: "Not connected" });

    const comments = await getMediaComments(conn[0].accessToken, mediaId);
    res.json({ success: true, data: comments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get DM conversation messages (alternative path for frontend)
router.get("/dm/conversations/:conversationId/messages", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { conversationId } = req.params;

    const messages = await getDmMessages(userId, parseInt(conversationId));
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get DM conversation
router.get("/dm/:conversationId", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { conversationId } = req.params;

    const messages = await getDmMessages(userId, parseInt(conversationId));
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send manual DM
router.post("/dm/send", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { conversationId, messageText } = req.body;

    const result = await sendManualDm(userId, parseInt(conversationId), messageText);
    if (result.success) {
      req.flash("success", "Message sent");
    } else {
      req.flash("error", result.error);
    }
    res.redirect("/instagram");
  } catch (error) {
    req.flash("error", "Failed to send message");
    res.redirect("/instagram");
  }
});

// ==================== API ENDPOINTS ====================

// Get account info
router.get("/api/me", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const conn = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    if (!conn.length) return res.status(401).json({ error: "Not connected" });

    res.json({
      instagramId: conn[0].instagramId,
      username: conn[0].instagramUsername,
      pageName: conn[0].pageName,
      isActive: conn[0].isActive,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent media
router.get("/api/media", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const conn = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    if (!conn.length) return res.status(401).json({ error: "Not connected" });

    const media = await getRecentMedia(conn[0].accessToken, 10);
    res.json({ success: true, data: media });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get media comments
router.get("/api/media/:mediaId/comments", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { mediaId } = req.params;
    const conn = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    if (!conn.length) return res.status(401).json({ error: "Not connected" });

    const comments = await getMediaComments(conn[0].accessToken, mediaId);
    res.json({ success: true, data: comments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reply to comment
router.post("/api/comments/:commentId/reply", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { commentId } = req.params;
    const { message } = req.body;
    const conn = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    if (!conn.length) return res.status(401).json({ error: "Not connected" });

    const result = await replyToComment(conn[0].accessToken, commentId, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send DM via API
router.post("/api/messages/send", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { recipientId, message } = req.body;
    const conn = await db.select().from(schema.instagramConnections)
      .where(eq(schema.instagramConnections.userId, userId));

    if (!conn.length) return res.status(401).json({ error: "Not connected" });

    const result = await sendDirectMessage(conn[0], recipientId, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle automation
router.post("/api/automation/toggle", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { enabled } = req.body;

    if (enabled) {
      startCommentPolling(userId);
    } else {
      stopCommentPolling(userId);
    }

    res.json({ success: true, automationEnabled: enabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats
router.get("/api/stats", async (req, res) => {
  try {
    const userId = req.session.user.id;

    const replies = await db.select().from(schema.instagramRepliedComments)
      .where(eq(schema.instagramRepliedComments.userId, userId));

    const dms = await db.select().from(schema.instagramDmMessages)
      .where(and(
        eq(schema.instagramDmMessages.userId, userId),
        eq(schema.instagramDmMessages.direction, "outbound")
      ));

    res.json({
      commentsReplied: replies.length,
      messagesReplied: dms.filter(m => m.isAutoReply).length,
      totalMessages: dms.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
