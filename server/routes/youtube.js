import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import {
  getAuthUrl,
  exchangeCode,
  fetchMyChannel,
  processCommentsForUser,
  testConnection,
  simulateRuleMatch,
  fetchVideoComments,
  getCommentText,
} from "../lib/youtube.js";

const router = express.Router();

// Main YouTube settings page
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const connRows = await db.select().from(schema.youtubeConnections)
      .where(eq(schema.youtubeConnections.userId, userId));
    const connection = connRows[0] || null;

    const rules = await db.select().from(schema.youtubeReplyRules)
      .where(eq(schema.youtubeReplyRules.userId, userId))
      .orderBy(desc(schema.youtubeReplyRules.createdAt));

    const repliedComments = await db.select().from(schema.youtubeRepliedComments)
      .where(eq(schema.youtubeRepliedComments.userId, userId))
      .orderBy(desc(schema.youtubeRepliedComments.repliedAt))
      .limit(50);

    // Check if Google OAuth is configured
    const oauthConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

    // Get process result from session (cleared after reading)
    const processResult = req.session.youtubeProcessResult || null;
    delete req.session.youtubeProcessResult;

    res.render("pages/youtube/index", {
      title: "YouTube Automation - ParroByte CRM",
      connection,
      rules,
      repliedComments,
      oauthConfigured,
      isAdmin,
      processResult,
    });
  } catch (error) {
    console.error("YouTube page error:", error);
    req.flash("error", "Failed to load YouTube settings");
    res.redirect("/dashboard");
  }
});

// Start OAuth flow
router.get("/oauth/start", async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      req.flash("error", "Google OAuth is not configured. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file.");
      return res.redirect("/youtube");
    }
    const userId = req.session.user.id;
    const url = getAuthUrl(String(userId));
    res.redirect(url);
  } catch (error) {
    console.error("YouTube OAuth start error:", error);
    req.flash("error", "Failed to start YouTube connection");
    res.redirect("/youtube");
  }
});

// OAuth callback
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    const userId = parseInt(state);

    if (oauthError) {
      req.flash("error", `YouTube connection denied: ${oauthError}`);
      return res.redirect("/youtube");
    }

    if (!code || !userId) {
      req.flash("error", "Invalid YouTube callback");
      return res.redirect("/youtube");
    }

    // Exchange code for tokens
    const tokens = await exchangeCode(code);

    // Upsert connection
    const existing = await db.select().from(schema.youtubeConnections)
      .where(eq(schema.youtubeConnections.userId, userId));

    const connData = {
      userId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
      isActive: true,
      updatedAt: new Date(),
    };

    if (existing.length) {
      await db.update(schema.youtubeConnections)
        .set(connData)
        .where(eq(schema.youtubeConnections.userId, userId));
    } else {
      await db.insert(schema.youtubeConnections).values({
        ...connData,
        createdAt: new Date(),
      });
    }

    // Fetch channel info
    const channelResult = await fetchMyChannel(userId);
    if (!channelResult.success) {
      req.flash("warning", "Connected but could not fetch channel info: " + channelResult.error);
    } else {
      req.flash("success", `YouTube channel "${channelResult.channel?.snippet?.title}" connected successfully!`);
    }
    res.redirect("/youtube");
  } catch (error) {
    console.error("YouTube OAuth callback error:", error);
    req.flash("error", "Failed to connect YouTube: " + error.message);
    res.redirect("/youtube");
  }
});

// Disconnect YouTube
router.post("/disconnect", async (req, res) => {
  try {
    const userId = req.session.user.id;
    await db.update(schema.youtubeConnections)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(schema.youtubeConnections.userId, userId));
    req.flash("success", "YouTube channel disconnected");
    res.redirect("/youtube");
  } catch (error) {
    req.flash("error", "Failed to disconnect");
    res.redirect("/youtube");
  }
});

// Test connection - fetch channel + videos
router.get("/test-connection", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await testConnection(userId);
    if (!result.success) {
      return res.json({ success: false, error: result.error });
    }
    return res.json({
      success: true,
      channel: {
        id: result.channel?.id,
        title: result.channel?.snippet?.title,
        thumbnail: result.channel?.snippet?.thumbnails?.default?.url,
      },
      videos: result.videos.map(v => ({
        id: v.contentDetails?.videoId || v.snippet?.resourceId?.videoId,
        title: v.snippet?.title,
        thumbnail: v.snippet?.thumbnails?.default?.url,
        publishedAt: v.snippet?.publishedAt,
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
      return res.redirect("/youtube");
    }

    await db.insert(schema.youtubeReplyRules).values({
      userId,
      name,
      triggerType: triggerType || "contains",
      triggerValue,
      responseContent,
    });

    req.flash("success", "Reply rule created");
    res.redirect("/youtube");
  } catch (error) {
    console.error("Create rule error:", error);
    req.flash("error", "Failed to create rule");
    res.redirect("/youtube");
  }
});

// Update reply rule
router.post("/rules/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, triggerType, triggerValue, responseContent, isActive } = req.body;

    await db.update(schema.youtubeReplyRules)
      .set({
        name,
        triggerType,
        triggerValue,
        responseContent,
        isActive: isActive === "on" || isActive === true,
        updatedAt: new Date(),
      })
      .where(eq(schema.youtubeReplyRules.id, id));

    req.flash("success", "Reply rule updated");
    res.redirect("/youtube");
  } catch (error) {
    req.flash("error", "Failed to update rule");
    res.redirect("/youtube");
  }
});

// Delete reply rule
router.post("/rules/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(schema.youtubeReplyRules).where(eq(schema.youtubeReplyRules.id, id));
    req.flash("success", "Reply rule deleted");
    res.redirect("/youtube");
  } catch (error) {
    req.flash("error", "Failed to delete rule");
    res.redirect("/youtube");
  }
});

// Manual trigger: fetch and process comments now
router.post("/process-now", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await processCommentsForUser(userId);
    req.session.youtubeProcessResult = result;
    if (result.error && result.replies === 0) {
      req.flash("error", `Error: ${result.error}`);
    } else if (result.error) {
      req.flash("warning", `Partial success: ${result.error}. Processed ${result.processed}, replied ${result.replies}.`);
    } else {
      req.flash("success", `Processed ${result.processed} comments, replied to ${result.replies}.`);
    }
    res.redirect("/youtube");
  } catch (error) {
    console.error("Process now error:", error);
    req.flash("error", "Failed to process comments: " + error.message);
    res.redirect("/youtube");
  }
});

// Test a reply rule against sample text
router.post("/test-rule", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { sampleText } = req.body;
    if (!sampleText) return res.json({ success: false, error: "Sample text required" });

    const rules = await db.select().from(schema.youtubeReplyRules)
      .where(eq(schema.youtubeReplyRules.userId, userId));

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

// Fetch comments for a specific video (for debugging)
router.get("/comments/:videoId", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { videoId } = req.params;
    const result = await fetchVideoComments(userId, videoId, 20);
    if (!result.success) return res.json({ success: false, error: result.error });

    const connRows = await db.select().from(schema.youtubeConnections)
      .where(eq(schema.youtubeConnections.userId, userId));
    const myChannelId = connRows[0]?.channelId || null;

    const comments = result.comments.map(thread => {
      const snippet = thread.snippet?.topLevelComment?.snippet;
      const commentId = thread.snippet?.topLevelComment?.id;
      return {
        id: commentId,
        authorName: snippet?.authorDisplayName,
        authorChannelId: snippet?.authorChannelId?.value,
        isOwnComment: myChannelId && snippet?.authorChannelId?.value === myChannelId,
        textDisplay: snippet?.textDisplay,
        textOriginal: snippet?.textOriginal,
        cleanText: getCommentText(snippet),
        publishedAt: snippet?.publishedAt,
        likeCount: snippet?.likeCount,
      };
    });

    res.json({ success: true, videoId, comments });
  } catch (error) {
    console.error("Fetch comments error:", error);
    res.json({ success: false, error: error.message });
  }
});

export default router;
