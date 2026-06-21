/**
 * Instagram Automation Engine
 * Integrated with ParroByte CRM - uses Drizzle ORM + PostgreSQL
 */
import axios from "axios";
import { db } from "./db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const CONFIG = {
  facebookGraphBase: "https://graph.facebook.com/v21.0",
  // Note: Instagram Business accounts use facebookGraphBase, not instagramGraphBase
};

// ==================== REPLY TEMPLATES ====================
const REPLY_TEMPLATES = {
  greeting: [
    "Hey there! 👋 Thanks for reaching out to Parrobyte!",
    "Hello! Welcome to Parrobyte! How can we help you today? 🚀",
    "Hi! Thanks for connecting with us! 💫"
  ],
  pricing: [
    "Our pricing plans start from ₹999/month! Visit our pricing page for details 💰",
    "We have flexible plans for every business size. DM us 'PLANS' for details! 📋"
  ],
  support: [
    "Our support team is here to help! Please DM us your query 📧",
    "Need help? We're just a message away! Drop your question here 👇"
  ],
  comment: [
    "Thanks for the love! ❤️ DM us for exclusive offers!",
    "We appreciate your comment! 🙌 Check our bio for more!",
    "Thanks for engaging! 🎉"
  ],
  link: [
    "Here's your link! 🔗 Check your DM for exclusive access!",
    "Sent you the details in DM! 📩 Check your inbox!"
  ],
  default: [
    "Thanks for your message! Our team will get back to you shortly ⚡",
    "We received your message! Expect a reply within 2 hours 🎯",
    "Appreciate you reaching out! We're on it! 💪"
  ]
};

export function getSmartReply(text, type = "message") {
  const lower = (text || "").toLowerCase();
  if (/\b(hi|hello|hey|namaste|vanakkam|start)\b/.test(lower)) {
    return randomPick(REPLY_TEMPLATES.greeting);
  }
  if (/\b(price|cost|pricing|plan|₹|rs\.?|rate)\b/.test(lower)) {
    return randomPick(REPLY_TEMPLATES.pricing);
  }
  if (/\b(help|support|issue|problem|error|bug|not working|assist)\b/.test(lower)) {
    return randomPick(REPLY_TEMPLATES.support);
  }
  if (/\b(link|guide|pdf|download|freebie|ebook|resource)\b/.test(lower)) {
    return randomPick(REPLY_TEMPLATES.link);
  }
  if (/\b(thanks|thank you|awesome|great|good|love|nice|amazing)\b/.test(lower)) {
    return "Thank you so much! 🙏 Your support means everything to us!";
  }
  return type === "comment"
    ? randomPick(REPLY_TEMPLATES.comment)
    : randomPick(REPLY_TEMPLATES.default);
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ==================== USER CONNECTION ====================

export async function getConnection(userId) {
  const rows = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.userId, userId));
  return rows[0] || null;
}

export async function getConnectionByPageId(pageId) {
  const rows = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.pageId, pageId));
  return rows[0] || null;
}

export async function getConnectionByInstagramId(igId) {
  const rows = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.instagramId, igId));
  return rows[0] || null;
}

// ==================== INSTAGRAM GRAPH API ====================

export async function getAccountInfo(accessToken) {
  try {
    const { data } = await axios.get(`${CONFIG.facebookGraphBase}/me`, {
      params: {
        fields: "id,username,name,profile_picture_url,followers_count,media_count,account_type",
        access_token: accessToken,
      },
    });
    return {
      instagramId: data.id,
      username: data.username,
      name: data.name || data.username,
      profilePicture: data.profile_picture_url,
      followersCount: data.followers_count,
      mediaCount: data.media_count,
      accountType: data.account_type || "BUSINESS",
    };
  } catch (err) {
    console.error("[Instagram] getAccountInfo failed:", err.response?.data?.error?.message || err.message);
    return null;
  }
}

export async function getLinkedPage(accessToken) {
  try {
    const { data } = await axios.get(`${CONFIG.facebookGraphBase}/me/accounts`, {
      params: {
        access_token: accessToken,
        fields: "id,name,access_token,instagram_business_account",
      },
    });
    const pages = data.data || [];
    for (const page of pages) {
      if (page.instagram_business_account) {
        return { id: page.id, name: page.name, access_token: page.access_token };
      }
    }
    return null;
  } catch (err) {
    console.log("[Instagram] No Facebook Page accessible with this token");
    return null;
  }
}

export async function refreshToken(userId) {
  const conn = await getConnection(userId);
  if (!conn) return null;

  try {
    const { data } = await axios.get(`${CONFIG.facebookGraphBase}/refresh_access_token`, {
      params: {
        grant_type: "ig_refresh_token",
        access_token: conn.accessToken,
      },
    });

    const newToken = data.access_token;
    const expiry = new Date(Date.now() + data.expires_in * 1000);

    await db.update(schema.instagramConnections)
      .set({ accessToken: newToken, tokenExpiry: expiry, updatedAt: new Date() })
      .where(eq(schema.instagramConnections.userId, userId));

    console.log(`[Instagram] Token refreshed for user ${userId}`);
    return newToken;
  } catch (err) {
    console.error("[Instagram] Token refresh failed:", err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ==================== MEDIA & COMMENTS ====================

export async function getRecentMedia(accessToken, limit = 10) {
  try {
    const { data } = await axios.get(`${CONFIG.facebookGraphBase}/me/media`, {
      params: {
        fields: "id,caption,media_type,media_url,permalink,timestamp",
        limit,
        access_token: accessToken,
      },
    });
    return data.data || [];
  } catch (err) {
    console.error("[Instagram] getRecentMedia failed:", err.response?.data?.error?.message || err.message);
    return [];
  }
}

export async function getMediaComments(accessToken, mediaId) {
  try {
    const { data } = await axios.get(`${CONFIG.facebookGraphBase}/${mediaId}/comments`, {
      params: {
        fields: "id,username,text,timestamp,like_count",
        access_token: accessToken,
      },
    });
    return data.data || [];
  } catch (err) {
    console.error("[Instagram] getMediaComments failed:", err.response?.data?.error?.message || err.message);
    return [];
  }
}

export async function replyToComment(accessToken, commentId, message) {
  try {
    const { data } = await axios.post(`${CONFIG.facebookGraphBase}/${commentId}/replies`, {
      message,
      access_token: accessToken,
    });
    console.log(`[Instagram] Comment reply sent: ${commentId}`);
    return { success: true, data };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error("[Instagram] replyToComment failed:", msg);
    return { success: false, error: msg };
  }
}

export async function sendPrivateReply(accessToken, commentId, message) {
  try {
    const { data } = await axios.post(`${CONFIG.facebookGraphBase}/${commentId}/private_replies`, {
      message,
      access_token: accessToken,
    });
    console.log(`[Instagram] Private reply sent for comment: ${commentId}`);
    return { success: true, data };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error("[Instagram] sendPrivateReply failed:", msg);
    return { success: false, error: msg };
  }
}

// ==================== DIRECT MESSAGE ====================

export async function sendDirectMessage(conn, recipientIgsid, messageText) {
  const token = conn.pageAccessToken || conn.accessToken;

  if (!recipientIgsid || !/^\d+$/.test(String(recipientIgsid))) {
    console.error(`[Instagram] Invalid recipient IGSID: ${recipientIgsid}`);
    return { success: false, error: `Invalid recipient IGSID: ${recipientIgsid}` };
  }

  try {
    const params = new URLSearchParams();
    params.append("access_token", token);
    params.append("recipient", JSON.stringify({ id: recipientIgsid }));
    params.append("message", JSON.stringify({ text: messageText }));
    params.append("messaging_type", "RESPONSE");

    const { data } = await axios.post(
      `${CONFIG.facebookGraphBase}/me/messages`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    console.log(`[Instagram] DM sent to IGSID: ${recipientIgsid}`);
    return { success: true, data };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error("[Instagram] sendDirectMessage failed:", msg);
    return { success: false, error: msg };
  }
}

// ==================== WEBHOOK HANDLERS ====================

export async function handleWebhookDm(messaging, recipientId) {
  const sender = messaging.sender;
  const message = messaging.message;

  if (!message || !message.text) {
    console.log("[Instagram Webhook] No text in message");
    return { handled: false };
  }

  const senderId = sender.id;
  const messageText = message.text;
  const mid = message.mid;

  console.log(`[Instagram DM] From ${senderId}: "${messageText.slice(0, 100)}"`);

  // Find connection by recipient (page/IG ID)
  const conn = await getConnectionByPageId(recipientId)
    || await getConnectionByInstagramId(recipientId);

  if (!conn || !conn.isActive) {
    console.log(`[Instagram DM] No active connection for recipient ${recipientId}`);
    return { handled: false, reason: "no_connection" };
  }

  // Save DM to database
  let conversationId = null;
  const existingConvo = await db.select().from(schema.instagramDmConversations)
    .where(and(
      eq(schema.instagramDmConversations.userId, conn.userId),
      eq(schema.instagramDmConversations.instagramUserId, senderId)
    ));

  if (existingConvo.length > 0) {
    conversationId = existingConvo[0].id;
    await db.update(schema.instagramDmConversations)
      .set({ lastMessageAt: new Date(), unreadCount: existingConvo[0].unreadCount + 1 })
      .where(eq(schema.instagramDmConversations.id, conversationId));
  } else {
    const newConvo = await db.insert(schema.instagramDmConversations).values({
      userId: conn.userId,
      instagramUserId: senderId,
      instagramUsername: sender.username || null,
      lastMessageAt: new Date(),
      unreadCount: 1,
    }).returning();
    conversationId = newConvo[0].id;
  }

  await db.insert(schema.instagramDmMessages).values({
    userId: conn.userId,
    conversationId,
    instagramUserId: senderId,
    direction: "inbound",
    messageText: messageText.slice(0, 2000),
    metaMessageId: mid,
  });

  // Match automation rules
  const rules = await db.select().from(schema.instagramReplyRules)
    .where(and(
      eq(schema.instagramReplyRules.userId, conn.userId),
      eq(schema.instagramReplyRules.isActive, true)
    ));

  const lowerText = messageText.toLowerCase();
  let matchedRule = null;

  for (const rule of rules) {
    const trigger = rule.triggerValue.toLowerCase();
    let matched = false;
    switch (rule.triggerType) {
      case "exact": matched = lowerText === trigger; break;
      case "contains": matched = lowerText.includes(trigger); break;
      case "starts_with": matched = lowerText.startsWith(trigger); break;
      case "ends_with": matched = lowerText.endsWith(trigger); break;
      case "regex":
        try { matched = new RegExp(trigger, "i").test(messageText); } catch (e) {}
        break;
    }
    if (matched) {
      matchedRule = rule;
      break;
    }
  }

  // If no rule matched, use smart reply
  const replyText = matchedRule ? matchedRule.responseContent : getSmartReply(messageText, "message");

  // Send reply
  const sendResult = await sendDirectMessage(conn, senderId, replyText);

  if (sendResult.success) {
    await db.insert(schema.instagramDmMessages).values({
      userId: conn.userId,
      conversationId,
      instagramUserId: senderId,
      direction: "outbound",
      messageText: replyText.slice(0, 2000),
      isAutoReply: true,
      ruleId: matchedRule?.id || null,
    });

    if (matchedRule) {
      await db.update(schema.instagramReplyRules)
        .set({ usageCount: matchedRule.usageCount + 1, updatedAt: new Date() })
        .where(eq(schema.instagramReplyRules.id, matchedRule.id));
    }

    console.log(`[Instagram DM] Auto-reply sent to ${senderId}`);
    return { handled: true, replied: true, rule: matchedRule?.name || "smart" };
  }

  console.error(`[Instagram DM] Failed to send reply: ${sendResult.error}`);
  return { handled: true, replied: false, error: sendResult.error };
}

export async function handleWebhookComment(value) {
  const commentId = value.id || value.comment_id;
  const commentText = value.text || value.message || "";
  const mediaId = value.media_id;
  const fromUsername = value.from?.username || "unknown";

  console.log(`[Instagram Comment] From @${fromUsername}: "${commentText.slice(0, 100)}"`);

  // Find connection by media_id matching instagram_id
  let conn = null;
  const allConns = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.isActive, true));

  for (const c of allConns) {
    // mediaId from webhook should match the Instagram Business Account ID
    if (c.instagramId === mediaId) {
      conn = c;
      break;
    }
  }

  // Fallback: try to find by page_id if mediaId contains page info
  if (!conn && mediaId) {
    const mediaParts = String(mediaId).split('_');
    const possiblePageId = mediaParts.length > 1 ? mediaParts[1] : null;
    if (possiblePageId) {
      for (const c of allConns) {
        if (c.pageId === possiblePageId) {
          conn = c;
          break;
        }
      }
    }
  }

  if (!conn) {
    console.log("[Instagram Comment] No connection found for this media");
    return { handled: false };
  }

  // Check already replied
  const existing = await db.select().from(schema.instagramRepliedComments)
    .where(eq(schema.instagramRepliedComments.commentId, commentId));
  if (existing.length > 0) {
    return { handled: false, reason: "already_replied" };
  }

  // Match rules
  const rules = await db.select().from(schema.instagramReplyRules)
    .where(and(
      eq(schema.instagramReplyRules.userId, conn.userId),
      eq(schema.instagramReplyRules.isActive, true)
    ));

  const lowerText = commentText.toLowerCase();
  let matchedRule = null;

  for (const rule of rules) {
    const trigger = rule.triggerValue.toLowerCase();
    let matched = false;
    switch (rule.triggerType) {
      case "exact": matched = lowerText === trigger; break;
      case "contains": matched = lowerText.includes(trigger); break;
      case "starts_with": matched = lowerText.startsWith(trigger); break;
      case "ends_with": matched = lowerText.endsWith(trigger); break;
      case "regex":
        try { matched = new RegExp(trigger, "i").test(commentText); } catch (e) {}
        break;
    }
    if (matched) {
      matchedRule = rule;
      break;
    }
  }

  // Determine reply strategy
  const triggerKeywords = ["link", "guide", "price", "dm", "info", "help", "buy", "order", "book", "interested", "how much"];
  const hasTrigger = triggerKeywords.some(kw => lowerText.includes(kw));
  const replyText = matchedRule ? matchedRule.responseContent : getSmartReply(commentText, "comment");

  let sendResult;
  if (hasTrigger) {
    // Send private reply (DM) for trigger keywords
    console.log("[Instagram Comment] Keyword trigger - sending private reply");
    sendResult = await sendPrivateReply(conn.accessToken, commentId, replyText);
  } else {
    // Reply to comment publicly
    sendResult = await replyToComment(conn.accessToken, commentId, replyText);
  }

  if (sendResult.success) {
    await db.insert(schema.instagramRepliedComments).values({
      userId: conn.userId,
      mediaId: mediaId || "unknown",
      commentId,
      commentText: commentText.slice(0, 500),
      replyText: replyText.slice(0, 500),
      ruleId: matchedRule?.id || null,
    });

    if (matchedRule) {
      await db.update(schema.instagramReplyRules)
        .set({ usageCount: matchedRule.usageCount + 1, updatedAt: new Date() })
        .where(eq(schema.instagramReplyRules.id, matchedRule.id));
    }

    console.log(`[Instagram Comment] Reply sent: ${hasTrigger ? "private DM" : "public comment"}`);
    return { handled: true, replied: true, type: hasTrigger ? "private" : "public" };
  }

  console.error(`[Instagram Comment] Reply failed: ${sendResult.error}`);
  return { handled: true, replied: false, error: sendResult.error };
}

// ==================== POLLING AUTOMATION ====================

const userPollingIntervals = new Map();

export async function startCommentPolling(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) {
    console.log(`[Instagram] Cannot start polling for user ${userId}: not connected`);
    return;
  }

  console.log(`[Instagram] Starting comment polling for user ${userId}`);
  const interval = setInterval(async () => {
    await pollCommentsForUser(userId);
  }, 30000);
  userPollingIntervals.set(userId, interval);
}

export function stopCommentPolling(userId) {
  const interval = userPollingIntervals.get(userId);
  if (interval) {
    clearInterval(interval);
    userPollingIntervals.delete(userId);
    console.log(`[Instagram] Stopped polling for user ${userId}`);
  }
}

async function pollCommentsForUser(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.isActive) return;

  try {
    const media = await getRecentMedia(conn.accessToken, 5);
    for (const item of media) {
      const comments = await getMediaComments(conn.accessToken, item.id);
      for (const comment of comments) {
        const existing = await db.select().from(schema.instagramRepliedComments)
          .where(eq(schema.instagramRepliedComments.commentId, comment.id));
        if (existing.length > 0) continue;

        if (comment.username === conn.instagramUsername) continue;

        const lowerText = (comment.text || "").toLowerCase();
        const triggerKeywords = ["link", "guide", "price", "dm", "info", "help", "buy", "order", "book", "interested", "how much"];
        const hasTrigger = triggerKeywords.some(kw => lowerText.includes(kw));

        const replyText = getSmartReply(comment.text, "comment");

        if (hasTrigger) {
          const result = await sendPrivateReply(conn.accessToken, comment.id, replyText);
          if (result.success) {
            await db.insert(schema.instagramRepliedComments).values({
              userId,
              mediaId: item.id,
              commentId: comment.id,
              commentText: (comment.text || "").slice(0, 500),
              replyText: replyText.slice(0, 500),
            });
            console.log(`[Instagram Polling] Private reply sent for comment ${comment.id}`);
          }
        } else {
          const result = await replyToComment(conn.accessToken, comment.id, replyText);
          if (result.success) {
            await db.insert(schema.instagramRepliedComments).values({
              userId,
              mediaId: item.id,
              commentId: comment.id,
              commentText: (comment.text || "").slice(0, 500),
              replyText: replyText.slice(0, 500),
            });
            console.log(`[Instagram Polling] Comment reply sent for ${comment.id}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Instagram Polling] Error for user ${userId}:`, err.message);
  }
}

// ==================== TOKEN REFRESH CRON ====================

export async function refreshAllTokens() {
  const warningDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const conns = await db.select().from(schema.instagramConnections)
    .where(eq(schema.instagramConnections.isActive, true));

  for (const conn of conns) {
    if (conn.tokenExpiry && new Date(conn.tokenExpiry) <= warningDate) {
      console.log(`[Instagram] Token expiring soon for user ${conn.userId}, refreshing...`);
      await refreshToken(conn.userId);
    }
  }
}
