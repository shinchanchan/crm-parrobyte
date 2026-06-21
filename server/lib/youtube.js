import { google } from "googleapis";
import { db } from "./db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";

/** Lazy env reader so dotenv doesn't need to be loaded before imports */
function getOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/youtube/oauth/callback",
  };
}

/** Create OAuth2 client */
function createOAuth2Client() {
  const cfg = getOAuthConfig();
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

/** Generate Google OAuth URL for YouTube scopes */
export function getAuthUrl(state = "") {
  const cfg = getOAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("Google OAuth credentials not configured");
  }
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
    prompt: "consent",
    state,
  });
}

/** Exchange authorization code for tokens */
export async function exchangeCode(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/** Refresh access token using refresh token */
export async function refreshAccessToken(refreshToken) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  return credentials;
}

/** Get YouTube API client for a user (auto-refreshes token if needed) */
export async function getYouTubeClient(userId) {
  const rows = await db.select().from(schema.youtubeConnections)
    .where(eq(schema.youtubeConnections.userId, userId));
  if (!rows.length || !rows[0].isActive) return null;

  const conn = rows[0];
  let accessToken = conn.accessToken;
  let refreshToken = conn.refreshToken;

  // Refresh if expired or about to expire (within 5 min)
  const expiry = conn.tokenExpiry ? new Date(conn.tokenExpiry) : null;
  const now = new Date();
  if (!expiry || expiry.getTime() - now.getTime() < 5 * 60 * 1000) {
    if (!refreshToken) return null;
    try {
      const tokens = await refreshAccessToken(refreshToken);
      accessToken = tokens.access_token;
      if (tokens.refresh_token) refreshToken = tokens.refresh_token;
      await db.update(schema.youtubeConnections)
        .set({
          accessToken,
          refreshToken,
          tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
          updatedAt: new Date(),
        })
        .where(eq(schema.youtubeConnections.userId, userId));
    } catch (err) {
      console.error("[YouTube] Token refresh failed:", err.message);
      return null;
    }
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return google.youtube({ version: "v3", auth: oauth2Client });
}

/** Fetch channel info for authenticated user */
export async function fetchMyChannel(userId) {
  const yt = await getYouTubeClient(userId);
  if (!yt) return { success: false, error: "Not connected" };
  try {
    const res = await yt.channels.list({ part: "snippet,contentDetails", mine: true });
    const channel = res.data.items?.[0];
    if (channel) {
      await db.update(schema.youtubeConnections)
        .set({
          channelId: channel.id,
          channelTitle: channel.snippet?.title,
          updatedAt: new Date(),
        })
        .where(eq(schema.youtubeConnections.userId, userId));
    }
    return { success: true, channel };
  } catch (err) {
    console.error("[YouTube] fetchMyChannel error:", err.message);
    return { success: false, error: err.message };
  }
}

/** Fetch recent videos from user's channel using uploads playlist */
export async function fetchMyVideos(userId, maxResults = 10) {
  const yt = await getYouTubeClient(userId);
  if (!yt) return { success: false, error: "Not connected", videos: [] };

  const conn = await db.select().from(schema.youtubeConnections)
    .where(eq(schema.youtubeConnections.userId, userId));
  if (!conn.length || !conn[0].channelId) return { success: false, error: "Channel not found", videos: [] };

  try {
    // Get uploads playlist ID from channel
    const channelRes = await yt.channels.list({
      part: "contentDetails",
      id: conn[0].channelId,
    });
    const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return { success: false, error: "No uploads playlist found", videos: [] };

    // Get videos from uploads playlist
    const playlistRes = await yt.playlistItems.list({
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults,
    });
    return { success: true, videos: playlistRes.data.items || [] };
  } catch (err) {
    console.error("[YouTube] fetchMyVideos error:", err.message);
    return { success: false, error: err.message, videos: [] };
  }
}

/** Fetch comments for a video */
export async function fetchVideoComments(userId, videoId, maxResults = 100) {
  const yt = await getYouTubeClient(userId);
  if (!yt) return { success: false, error: "Not connected", comments: [] };
  try {
    const res = await yt.commentThreads.list({
      part: "snippet,replies",
      videoId,
      maxResults,
      order: "time",
    });
    return { success: true, comments: res.data.items || [] };
  } catch (err) {
    console.error("[YouTube] fetchVideoComments error:", err.message);
    return { success: false, error: err.message, comments: [] };
  }
}

/** Reply to a comment */
export async function replyToComment(userId, parentCommentId, text) {
  const yt = await getYouTubeClient(userId);
  if (!yt) return { success: false, error: "Not connected" };
  try {
    const res = await yt.comments.insert({
      part: "snippet",
      requestBody: {
        snippet: {
          parentId: parentCommentId,
          textOriginal: text,
        },
      },
    });
    return { success: true, data: res.data };
  } catch (err) {
    console.error("[YouTube] replyToComment error:", err.message);
    return { success: false, error: err.message };
  }
}

/** Check if a comment has already been replied to by us */
export async function hasReplied(userId, commentId) {
  const rows = await db.select().from(schema.youtubeRepliedComments)
    .where(eq(schema.youtubeRepliedComments.commentId, commentId));
  return rows.length > 0;
}

/** Strip HTML tags from text */
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Get clean plain text from a YouTube comment snippet */
export function getCommentText(snippet) {
  // textOriginal is plain text (preferred)
  // textDisplay may contain HTML (links, mentions, etc.)
  const raw = snippet.textOriginal || snippet.textDisplay || "";
  return stripHtml(raw);
}

/** Match a comment against reply rules */
export async function matchRules(userId, commentText) {
  const rules = await db.select().from(schema.youtubeReplyRules)
    .where(and(
      eq(schema.youtubeReplyRules.userId, userId),
      eq(schema.youtubeReplyRules.isActive, true)
    ));

  const text = commentText.toLowerCase();
  const matches = [];

  for (const rule of rules) {
    const trigger = rule.triggerValue.toLowerCase();
    let matched = false;
    switch (rule.triggerType) {
      case "exact":
        matched = text === trigger;
        break;
      case "contains":
        matched = text.includes(trigger);
        break;
      case "starts_with":
        matched = text.startsWith(trigger);
        break;
      case "ends_with":
        matched = text.endsWith(trigger);
        break;
      case "regex":
        try {
          matched = new RegExp(trigger, "i").test(commentText);
        } catch (e) {}
        break;
    }
    if (matched) matches.push(rule);
  }
  return matches;
}

/** Simulate a rule match against sample text (no DB write) */
export function simulateRuleMatch(triggerType, triggerValue, sampleText) {
  const text = sampleText.toLowerCase();
  const trigger = triggerValue.toLowerCase();
  switch (triggerType) {
    case "exact": return text === trigger;
    case "contains": return text.includes(trigger);
    case "starts_with": return text.startsWith(trigger);
    case "ends_with": return text.endsWith(trigger);
    case "regex":
      try { return new RegExp(trigger, "i").test(sampleText); } catch (e) { return false; }
    default: return text.includes(trigger);
  }
}

/** Process all comments for a user: fetch, match rules, reply (with dedup) */
export async function processCommentsForUser(userId) {
  const yt = await getYouTubeClient(userId);
  if (!yt) return { processed: 0, replies: 0, error: "Not connected", logs: [] };

  const videoResult = await fetchMyVideos(userId, 5);
  if (!videoResult.success) return { processed: 0, replies: 0, error: videoResult.error, logs: [] };

  const videos = videoResult.videos;
  let totalReplies = 0;
  let totalProcessed = 0;
  let lastError = null;
  const logs = [];

  // Get user's channel ID once
  const connRows = await db.select().from(schema.youtubeConnections)
    .where(eq(schema.youtubeConnections.userId, userId));
  const myChannelId = connRows[0]?.channelId || null;

  for (const item of videos) {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    const videoTitle = item.snippet?.title || "Unknown";
    if (!videoId) continue;

    const commentResult = await fetchVideoComments(userId, videoId, 50);
    if (!commentResult.success) {
      lastError = commentResult.error;
      logs.push({ type: "error", message: `Video "${videoTitle}": ${commentResult.error}` });
      continue;
    }

    logs.push({ type: "info", message: `Video "${videoTitle}": ${commentResult.comments.length} comment(s)` });

    const threads = commentResult.comments;
    for (const thread of threads) {
      const topComment = thread.snippet?.topLevelComment?.snippet;
      if (!topComment) continue;

      const commentId = thread.snippet?.topLevelComment?.id;
      const commentText = getCommentText(topComment);
      const authorName = topComment.authorDisplayName || "Unknown";
      const authorChannelId = topComment.authorChannelId?.value;

      // Skip our own comments
      if (myChannelId && authorChannelId === myChannelId) {
        logs.push({ type: "skip", message: `Skipped own comment by ${authorName}: "${commentText.slice(0, 60)}..."` });
        continue;
      }

      totalProcessed++;

      // Skip if already replied
      if (await hasReplied(userId, commentId)) {
        logs.push({ type: "skip", message: `Already replied to ${authorName}: "${commentText.slice(0, 60)}..."` });
        continue;
      }

      // Match rules
      const rules = await matchRules(userId, commentText);
      if (rules.length === 0) {
        logs.push({ type: "skip", message: `No rule matched for ${authorName}: "${commentText.slice(0, 60)}..."` });
        continue;
      }

      // Reply with first matching rule
      const rule = rules[0];
      logs.push({ type: "match", message: `Rule "${rule.name}" matched for ${authorName}: "${commentText.slice(0, 60)}..." → Replying...` });

      const replyResult = await replyToComment(userId, commentId, rule.responseContent);
      if (replyResult.success) {
        await db.insert(schema.youtubeRepliedComments).values({
          userId,
          videoId,
          commentId,
          commentText: commentText.slice(0, 500),
          replyText: rule.responseContent.slice(0, 500),
          ruleId: rule.id,
        });

        await db.update(schema.youtubeReplyRules)
          .set({ usageCount: rule.usageCount + 1, updatedAt: new Date() })
          .where(eq(schema.youtubeReplyRules.id, rule.id));

        totalReplies++;
        logs.push({ type: "success", message: `Replied to ${authorName} with rule "${rule.name}"` });

        // Rate limit: max 10 replies per user per run
        if (totalReplies >= 10) break;
      } else {
        lastError = replyResult.error;
        logs.push({ type: "error", message: `Failed to reply to ${authorName}: ${replyResult.error}` });
      }
    }
    if (totalReplies >= 10) break;
  }

  await db.update(schema.youtubeConnections)
    .set({ lastFetchAt: new Date() })
    .where(eq(schema.youtubeConnections.userId, userId));

  return { processed: totalProcessed, replies: totalReplies, error: lastError, logs };
}

/** Test connection: fetch channel + recent videos and return details */
export async function testConnection(userId) {
  const channelResult = await fetchMyChannel(userId);
  if (!channelResult.success) return { success: false, error: channelResult.error };

  const videoResult = await fetchMyVideos(userId, 5);
  return {
    success: true,
    channel: channelResult.channel,
    videos: videoResult.videos || [],
  };
}

/** Run comment processing for all connected users (called by cron) */
export async function processAllUsers() {
  const connections = await db.select().from(schema.youtubeConnections)
    .where(eq(schema.youtubeConnections.isActive, true));

  const results = [];
  for (const conn of connections) {
    try {
      const result = await processCommentsForUser(conn.userId);
      results.push({ userId: conn.userId, ...result });
      // Small delay between users to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[YouTube] Error processing user ${conn.userId}:`, err.message);
      results.push({ userId: conn.userId, error: err.message, logs: [] });
    }
  }
  return results;
}
