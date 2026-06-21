import axios from "axios";
import { db } from "./db.js";
import { eq, and, desc, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const GRAPH_API = "https://graph.facebook.com/v18.0";

function getConfig() {
  return {
    appId: process.env.FACEBOOK_APP_ID || "",
    appSecret: process.env.FACEBOOK_APP_SECRET || "",
    redirectUri: process.env.INSTAGRAM_REDIRECT_URI || `${process.env.APP_URL || "http://localhost:3000"}/instagram/oauth/callback`,
  };
}

/** Generate Facebook OAuth URL for Instagram permissions */
export function getAuthUrl(state = "") {
  const cfg = getConfig();
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error("Facebook app credentials not configured");
  }
  const scope = [
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_messaging",
    "pages_messaging",
    "pages_read_engagement",
    "pages_manage_metadata",
  ].join(",");

  return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${cfg.appId}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&response_type=code`;
}

/** Exchange code for short-lived access token */
export async function exchangeCode(code) {
  const cfg = getConfig();
  const url = `${GRAPH_API}/oauth/access_token`;
  const { data } = await axios.get(url, {
    params: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: cfg.redirectUri,
      code,
    },
  });
  return data;
}

/** Exchange short-lived token for long-lived token (60 days) */
export async function getLongLivedToken(shortLivedToken) {
  const cfg = getConfig();
  const url = `${GRAPH_API}/oauth/access_token`;
  const { data } = await axios.get(url, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });
  return data;
}

/** Get Instagram Business Account ID from user's pages */
export async function getInstagramBusinessAccount(accessToken) {
  // 1. Get user's pages
  const pagesRes = await axios.get(`${GRAPH_API}/me/accounts`, {
    params: { access_token: accessToken, fields: "id,name,instagram_business_account,access_token" },
  });
  const pages = pagesRes.data.data || [];
  if (!pages.length) return null;

  // 2. Find a page with an Instagram Business Account
  for (const page of pages) {
    if (page.instagram_business_account) {
      const igId = page.instagram_business_account.id;
      // Get IG account details
      const igRes = await axios.get(`${GRAPH_API}/${igId}`, {
        params: { access_token: accessToken, fields: "id,username" },
      });
      return {
        pageId: page.id,
        pageName: page.name,
        pageAccessToken: page.access_token,
        instagramId: igId,
        instagramUsername: igRes.data.username,
      };
    }
  }
  return null;
}

/** Subscribe page to messaging webhooks */
export async function subscribePageToWebhooks(pageId, pageAccessToken) {
  try {
    const url = `${GRAPH_API}/${pageId}/subscribed_apps`;
    const { data } = await axios.post(url, null, {
      params: {
        access_token: pageAccessToken,
        subscribed_fields: "messages,messaging_postbacks",
      },
    });
    console.log(`[Instagram] Subscribed page ${pageId} to webhooks:`, data.success);
    return { success: true, data };
  } catch (err) {
    console.error("[Instagram] Webhook subscription error:", err.response?.data?.error?.message || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

/** Send an Instagram DM via the Messaging API */
export async function sendInstagramDm(userId, recipientId, messageText) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive || !conn.pageAccessToken || !conn.pageId) {
    return { success: false, error: "Not connected or missing page token" };
  }

  try {
    const url = `${GRAPH_API}/${conn.pageId}/messages`;
    const { data } = await axios.post(url, {
      recipient: { id: recipientId },
      message: { text: messageText },
    }, {
      params: { access_token: conn.pageAccessToken },
      headers: { "Content-Type": "application/json" },
    });
    return { success: true, data };
  } catch (err) {
    console.error("[Instagram] send DM error:", err.response?.data?.error?.message || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

/** Get or create a DM conversation */
async function getOrCreateConversation(userId, instagramUserId, instagramUsername) {
  const rows = await db.select().from(schema.instagramDmConversations)
    .where(and(
      eq(schema.instagramDmConversations.userId, userId),
      eq(schema.instagramDmConversations.instagramUserId, instagramUserId)
    ));

  if (rows.length > 0) return rows[0];

  const result = await db.insert(schema.instagramDmConversations).values({
    userId,
    instagramUserId,
    instagramUsername,
    lastMessageAt: new Date(),
    unreadCount: 0,
  }).returning();
  return result[0];
}

/** Store an inbound DM message */
async function storeInboundMessage(userId, conversationId, instagramUserId, messageText, metaMessageId) {
  await db.insert(schema.instagramDmMessages).values({
    userId,
    conversationId,
    instagramUserId,
    direction: "inbound",
    messageText,
    metaMessageId,
  });

  await db.update(schema.instagramDmConversations)
    .set({
      lastMessageAt: new Date(),
      unreadCount: sql`${schema.instagramDmConversations.unreadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.instagramDmConversations.id, conversationId));
}

/** Store an outbound DM message */
async function storeOutboundMessage(userId, conversationId, instagramUserId, messageText, metaMessageId, isAutoReply, ruleId) {
  await db.insert(schema.instagramDmMessages).values({
    userId,
    conversationId,
    instagramUserId,
    direction: "outbound",
    messageText,
    metaMessageId,
    isAutoReply,
    ruleId,
  });

  await db.update(schema.instagramDmConversations)
    .set({
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.instagramDmConversations.id, conversationId));
}

/** Match DM text against keyword rules (reuses instagramReplyRules) */
export async function matchDmRules(userId, messageText) {
  const rules = await db.select().from(schema.instagramReplyRules)
    .where(and(
      eq(schema.instagramReplyRules.userId, userId),
      eq(schema.instagramReplyRules.isActive, true)
    ));

  const text = messageText.toLowerCase();
  const matches = [];

  for (const rule of rules) {
    const trigger = rule.triggerValue.toLowerCase();
    let matched = false;
    switch (rule.triggerType) {
      case "exact": matched = text === trigger; break;
      case "contains": matched = text.includes(trigger); break;
      case "starts_with": matched = text.startsWith(trigger); break;
      case "ends_with": matched = text.endsWith(trigger); break;
      case "regex":
        try { matched = new RegExp(trigger, "i").test(messageText); } catch (e) {}
        break;
    }
    if (matched) matches.push(rule);
  }
  return matches;
}

/** Process a single incoming DM webhook event */
export async function processIncomingDm(userId, senderId, senderUsername, messageText, metaMessageId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    console.log(`[Instagram] User ${userId} not connected, ignoring DM`);
    return { processed: false, reason: "not_connected" };
  }

  // Get or create conversation
  const conversation = await getOrCreateConversation(userId, senderId, senderUsername);

  // Store inbound message
  await storeInboundMessage(userId, conversation.id, senderId, messageText, metaMessageId);

  // Match rules
  const rules = await matchDmRules(userId, messageText);
  if (rules.length === 0) {
    return { processed: true, replied: false, reason: "no_rule_matched" };
  }

  const rule = rules[0];

  // Send auto-reply
  const sendResult = await sendInstagramDm(userId, senderId, rule.responseContent);
  if (!sendResult.success) {
    console.error(`[Instagram] Auto-reply failed for user ${userId}:`, sendResult.error);
    return { processed: true, replied: false, reason: "send_failed", error: sendResult.error };
  }

  // Store outbound message
  await storeOutboundMessage(
    userId,
    conversation.id,
    senderId,
    rule.responseContent,
    sendResult.data?.message_id,
    true,
    rule.id
  );

  // Update rule usage count
  await db.update(schema.instagramReplyRules)
    .set({ usageCount: rule.usageCount + 1, updatedAt: new Date() })
    .where(eq(schema.instagramReplyRules.id, rule.id));

  console.log(`[Instagram] Auto-replied to ${senderUsername || senderId} with rule "${rule.name}"`);
  return { processed: true, replied: true, ruleId: rule.id };
}

/** Handle webhook payload from Meta */
export async function handleWebhookPayload(payload) {
  const results = [];

  if (payload.object !== "instagram" && payload.object !== "page") {
    return results;
  }

  for (const entry of payload.entry || []) {
    for (const messagingEvent of entry.messaging || []) {
      const sender = messagingEvent.sender;
      const recipient = messagingEvent.recipient;
      const message = messagingEvent.message;

      if (!message || !message.text) continue;

      // Find the user by page ID
      const connRows = await db.select().from(schema.instagramConnections)
        .where(eq(schema.instagramConnections.pageId, recipient.id));

      if (connRows.length === 0) {
        console.log(`[Instagram] No connection found for page ${recipient.id}`);
        continue;
      }

      const conn = connRows[0];
      const result = await processIncomingDm(
        conn.userId,
        sender.id,
        sender.username,
        message.text,
        message.mid
      );
      results.push({ userId: conn.userId, ...result });
    }
  }

  return results;
}

/** Get stored connection for user */
async function getConnection(userId) {
  const rows = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.userId, userId));
  return rows[0] || null;
}

/** Fetch recent media (posts) from Instagram Business Account */
export async function fetchRecentMedia(userId, limit = 10) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive || !conn.instagramId) {
    return { success: false, error: "Not connected", media: [] };
  }

  try {
    const res = await axios.get(`${GRAPH_API}/${conn.instagramId}/media`, {
      params: {
        access_token: conn.accessToken,
        fields: "id,caption,media_type,media_url,permalink,timestamp",
        limit,
      },
    });
    return { success: true, media: res.data.data || [] };
  } catch (err) {
    console.error("[Instagram] fetchRecentMedia error:", err.response?.data?.error?.message || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message, media: [] };
  }
}

/** Fetch comments on a media post */
export async function fetchMediaComments(userId, mediaId, limit = 50) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    return { success: false, error: "Not connected", comments: [] };
  }

  try {
    const res = await axios.get(`${GRAPH_API}/${mediaId}/comments`, {
      params: {
        access_token: conn.accessToken,
        fields: "id,text,username,timestamp",
        limit,
      },
    });
    return { success: true, comments: res.data.data || [] };
  } catch (err) {
    console.error("[Instagram] fetchMediaComments error:", err.response?.data?.error?.message || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message, comments: [] };
  }
}

/** Reply to an Instagram comment */
export async function replyToComment(userId, commentId, text) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    return { success: false, error: "Not connected" };
  }

  try {
    const res = await axios.post(`${GRAPH_API}/${commentId}/replies`, null, {
      params: {
        access_token: conn.accessToken,
        message: text,
      },
    });
    return { success: true, data: res.data };
  } catch (err) {
    console.error("[Instagram] replyToComment error:", err.response?.data?.error?.message || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

/** Check if already replied */
export async function hasReplied(userId, commentId) {
  const rows = await db.select().from(schema.instagramRepliedComments)
    .where(eq(schema.instagramRepliedComments.commentId, commentId));
  return rows.length > 0;
}

/** Match comment text against rules */
export async function matchRules(userId, commentText) {
  const rules = await db.select().from(schema.instagramReplyRules)
    .where(and(
      eq(schema.instagramReplyRules.userId, userId),
      eq(schema.instagramReplyRules.isActive, true)
    ));

  const text = commentText.toLowerCase();
  const matches = [];

  for (const rule of rules) {
    const trigger = rule.triggerValue.toLowerCase();
    let matched = false;
    switch (rule.triggerType) {
      case "exact": matched = text === trigger; break;
      case "contains": matched = text.includes(trigger); break;
      case "starts_with": matched = text.startsWith(trigger); break;
      case "ends_with": matched = text.endsWith(trigger); break;
      case "regex":
        try { matched = new RegExp(trigger, "i").test(commentText); } catch (e) {}
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

/** Process comments for a user */
export async function processCommentsForUser(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    return { processed: 0, replies: 0, error: "Not connected", logs: [] };
  }

  const mediaResult = await fetchRecentMedia(userId, 5);
  if (!mediaResult.success) {
    return { processed: 0, replies: 0, error: mediaResult.error, logs: [] };
  }

  let totalReplies = 0;
  let totalProcessed = 0;
  let lastError = null;
  const logs = [];

  for (const post of mediaResult.media) {
    const caption = (post.caption || "").slice(0, 60);
    const commentResult = await fetchMediaComments(userId, post.id, 50);
    if (!commentResult.success) {
      lastError = commentResult.error;
      logs.push({ type: "error", message: `Post "${caption}": ${commentResult.error}` });
      continue;
    }

    logs.push({ type: "info", message: `Post "${caption}": ${commentResult.comments.length} comment(s)` });

    for (const comment of commentResult.comments) {
      const commentText = comment.text || "";
      const commentId = comment.id;
      const username = comment.username || "Unknown";

      // Skip our own comments
      if (username.toLowerCase() === (conn.instagramUsername || "").toLowerCase()) {
        logs.push({ type: "skip", message: `Skipped own comment by ${username}: "${commentText.slice(0, 60)}..."` });
        continue;
      }

      totalProcessed++;

      if (await hasReplied(userId, commentId)) {
        logs.push({ type: "skip", message: `Already replied to ${username}: "${commentText.slice(0, 60)}..."` });
        continue;
      }

      const rules = await matchRules(userId, commentText);
      if (rules.length === 0) {
        logs.push({ type: "skip", message: `No rule matched for ${username}: "${commentText.slice(0, 60)}..."` });
        continue;
      }

      const rule = rules[0];
      logs.push({ type: "match", message: `Rule "${rule.name}" matched for ${username}: "${commentText.slice(0, 60)}..." -> Replying...` });

      const replyResult = await replyToComment(userId, commentId, rule.responseContent);
      if (replyResult.success) {
        await db.insert(schema.instagramRepliedComments).values({
          userId,
          mediaId: post.id,
          commentId,
          commentText: commentText.slice(0, 500),
          replyText: rule.responseContent.slice(0, 500),
          ruleId: rule.id,
        });

        await db.update(schema.instagramReplyRules)
          .set({ usageCount: rule.usageCount + 1, updatedAt: new Date() })
          .where(eq(schema.instagramReplyRules.id, rule.id));

        totalReplies++;
        logs.push({ type: "success", message: `Replied to ${username} with rule "${rule.name}"` });

        if (totalReplies >= 10) break;
      } else {
        lastError = replyResult.error;
        logs.push({ type: "error", message: `Failed to reply to ${username}: ${replyResult.error}` });
      }
    }
    if (totalReplies >= 10) break;
  }

  await db.update(schema.instagramConnections)
    .set({ lastFetchAt: new Date() })
    .where(eq(schema.instagramConnections.userId, userId));

  return { processed: totalProcessed, replies: totalReplies, error: lastError, logs };
}

/** Test connection */
export async function testConnection(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    return { success: false, error: "Not connected" };
  }

  try {
    // Verify token works by fetching account info
    const res = await axios.get(`${GRAPH_API}/${conn.instagramId}`, {
      params: {
        access_token: conn.accessToken,
        fields: "id,username,media_count",
      },
    });

    const mediaResult = await fetchRecentMedia(userId, 5);
    return {
      success: true,
      account: res.data,
      media: mediaResult.media || [],
    };
  } catch (err) {
    console.error("[Instagram] testConnection error:", err.response?.data?.error?.message || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

/** Process all users */
export async function processAllUsers() {
  const connections = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.isActive, true));

  const results = [];
  for (const conn of connections) {
    try {
      const result = await processCommentsForUser(conn.userId);
      results.push({ userId: conn.userId, ...result });
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[Instagram] Error processing user ${conn.userId}:`, err.message);
      results.push({ userId: conn.userId, error: err.message, logs: [] });
    }
  }
  return results;
}


/** Fetch DM conversations for a user */
export async function getDmConversations(userId, limit = 50) {
  try {
    const rows = await db.select().from(schema.instagramDmConversations)
      .where(eq(schema.instagramDmConversations.userId, userId))
      .orderBy(desc(schema.instagramDmConversations.lastMessageAt))
      .limit(limit);
    return { success: true, conversations: rows };
  } catch (err) {
    console.error("[Instagram] getDmConversations error:", err.message);
    return { success: false, error: err.message, conversations: [] };
  }
}

/** Fetch DM messages for a conversation */
export async function getDmMessages(userId, conversationId, limit = 100) {
  try {
    const rows = await db.select().from(schema.instagramDmMessages)
      .where(and(
        eq(schema.instagramDmMessages.userId, userId),
        eq(schema.instagramDmMessages.conversationId, conversationId)
      ))
      .orderBy(desc(schema.instagramDmMessages.createdAt))
      .limit(limit);

    // Reset unread count
    await db.update(schema.instagramDmConversations)
      .set({ unreadCount: 0 })
      .where(eq(schema.instagramDmConversations.id, conversationId));

    return { success: true, messages: rows.reverse() };
  } catch (err) {
    console.error("[Instagram] getDmMessages error:", err.message);
    return { success: false, error: err.message, messages: [] };
  }
}

/** Send a manual DM from the CRM UI */
export async function sendManualDm(userId, conversationId, messageText) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    return { success: false, error: "Not connected" };
  }

  // Get conversation to find recipient
  const convRows = await db.select().from(schema.instagramDmConversations)
    .where(and(
      eq(schema.instagramDmConversations.id, conversationId),
      eq(schema.instagramDmConversations.userId, userId)
    ));

  if (convRows.length === 0) {
    return { success: false, error: "Conversation not found" };
  }

  const conversation = convRows[0];
  const sendResult = await sendInstagramDm(userId, conversation.instagramUserId, messageText);
  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  await storeOutboundMessage(
    userId,
    conversationId,
    conversation.instagramUserId,
    messageText,
    sendResult.data?.message_id,
    false,
    null
  );

  return { success: true, data: sendResult.data };
}
