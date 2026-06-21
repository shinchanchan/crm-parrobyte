/**
 * Meta WhatsApp Business API (Cloud API) Service Library
 * Wraps Meta's Graph API v22.0 for sending/receiving WhatsApp messages.
 */

import crypto from "crypto";

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Make an authenticated request to Meta Graph API
 */
async function apiRequest(path, options = {}) {
  const url = `${GRAPH_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Meta API error: ${res.status}`);
    err.code = data.error?.code;
    err.subcode = data.error?.error_subcode;
    err.type = data.error?.type;
    err.fbTraceId = data.error?.fbtrace_id;
    throw err;
  }
  return data;
}

/**
 * Validate credentials by fetching phone number details
 */
export async function validateCredentials(accessToken, phoneNumberId) {
  const data = await apiRequest(`/${phoneNumberId}?access_token=${encodeURIComponent(accessToken)}`);
  return {
    valid: true,
    displayPhoneNumber: data.display_phone_number,
    verifiedName: data.verified_name,
    qualityRating: data.quality_rating,
    accountMode: data.account_mode,
  };
}

/**
 * Fetch WABA details including business phone numbers
 */
export async function getWabaDetails(wabaId, accessToken) {
  return apiRequest(`/${wabaId}?access_token=${encodeURIComponent(accessToken)}`);
}

/**
 * Send a text message
 */
export async function sendTextMessage(phoneNumberId, accessToken, to, text) {
  const data = await apiRequest(`/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(to),
      type: "text",
      text: { body: text },
    }),
  });
  return {
    success: true,
    messageId: data.messages?.[0]?.id,
    conversationId: data.messages?.[0]?.conversation?.id,
    conversationCategory: data.messages?.[0]?.conversation?.origin?.type,
  };
}

/**
 * Send a template message (required for business-initiated conversations)
 */
export async function sendTemplateMessage(phoneNumberId, accessToken, to, templateName, language = "en", components = []) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
    },
  };
  if (components && components.length > 0) {
    payload.template.components = components;
  }
  const data = await apiRequest(`/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  });
  return {
    success: true,
    messageId: data.messages?.[0]?.id,
    conversationId: data.messages?.[0]?.conversation?.id,
    conversationCategory: data.messages?.[0]?.conversation?.origin?.type,
  };
}

/**
 * Upload media to Meta CDN
 */
export async function uploadMedia(phoneNumberId, accessToken, fileBuffer, mimeType) {
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: mimeType }), "file");
  formData.append("messaging_product", "whatsapp");
  formData.append("type", mimeType);

  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Media upload failed: ${res.status}`);
  }
  return { mediaId: data.id };
}

/**
 * Send a media message (image, document, video, audio)
 */
export async function sendMediaMessage(phoneNumberId, accessToken, to, type, mediaId, caption = "") {
  const mediaKey = type === "document" ? "document" : type;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    type: mediaKey,
  };
  payload[mediaKey] = { id: mediaId };
  if (caption && type !== "audio") {
    payload[mediaKey].caption = caption;
  }

  const data = await apiRequest(`/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  });
  return {
    success: true,
    messageId: data.messages?.[0]?.id,
    conversationId: data.messages?.[0]?.conversation?.id,
    conversationCategory: data.messages?.[0]?.conversation?.origin?.type,
  };
}

/**
 * Send an interactive message (buttons or list) via Meta Cloud API
 * @param {string} phoneNumberId - Meta phone number ID
 * @param {string} accessToken - Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} interactiveType - "button" or "list"
 * @param {object} interactiveData - { body, action, header, footer }
 */
export async function sendInteractiveMessage(phoneNumberId, accessToken, to, interactiveType, interactiveData) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    type: "interactive",
    interactive: {
      type: interactiveType,
      body: { text: interactiveData.body },
      action: interactiveData.action,
    },
  };

  if (interactiveData.header) {
    payload.interactive.header = interactiveData.header;
  }
  if (interactiveData.footer) {
    payload.interactive.footer = { text: interactiveData.footer };
  }

  const data = await apiRequest(`/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  });
  return {
    success: true,
    messageId: data.messages?.[0]?.id,
    conversationId: data.messages?.[0]?.conversation?.id,
    conversationCategory: data.messages?.[0]?.conversation?.origin?.type,
  };
}

/**
 * Fetch all approved templates from Meta
 */
export async function getTemplates(wabaId, accessToken) {
  const data = await apiRequest(`/${wabaId}/message_templates?access_token=${encodeURIComponent(accessToken)}&limit=100`);
  return (data.data || []).map(t => ({
    metaTemplateId: t.id,
    templateName: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    components: JSON.stringify(t.components),
    rejectionReason: t.rejection_reason,
  }));
}

/**
 * Create a new template on Meta
 */
export async function createTemplate(wabaId, accessToken, templateName, category, language, components) {
  const data = await apiRequest(`/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      name: templateName,
      category,
      language,
      components,
    }),
  });
  return {
    success: true,
    metaTemplateId: data.id,
    status: data.status,
  };
}

/**
 * Delete a template from Meta
 */
export async function deleteTemplate(wabaId, accessToken, templateName) {
  return apiRequest(`/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Verify webhook signature (X-Hub-Signature-256)
 */
export function verifyWebhookSignature(body, signature, appSecret) {
  if (!signature || !appSecret) return false;
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(body, "utf8")
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.replace("sha256=", ""), "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Parse incoming webhook payload from Meta
 * Returns array of events: { type, phone, messageId, timestamp, ... }
 */
export function parseIncomingWebhook(body) {
  const events = [];
  if (!body || !body.entry) return events;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value || !value.messages) continue;

      const phoneNumberId = value.metadata?.phone_number_id;

      for (const msg of value.messages || []) {
        const event = {
          type: "message",
          phoneNumberId,
          phone: msg.from,
          messageId: msg.id,
          timestamp: new Date(parseInt(msg.timestamp) * 1000),
        };

        if (msg.type === "text") {
          event.messageType = "text";
          event.content = msg.text?.body;
        } else if (["image", "document", "video", "audio", "voice"].includes(msg.type)) {
          event.messageType = msg.type;
          event.mediaId = msg[msg.type]?.id;
          event.mediaMimeType = msg[msg.type]?.mime_type;
          event.caption = msg[msg.type]?.caption;
        } else if (msg.type === "button") {
          event.messageType = "button";
          event.content = msg.button?.text;
          event.buttonPayload = msg.button?.payload;
        } else if (msg.type === "interactive") {
          event.messageType = "interactive";
          event.interactiveType = msg.interactive?.type;
          event.content = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
        }

        events.push(event);
      }

      // Status updates
      for (const status of value.statuses || []) {
        events.push({
          type: "status",
          phoneNumberId,
          phone: status.recipient_id,
          messageId: status.id,
          status: status.status, // sent, delivered, read, failed
          timestamp: new Date(parseInt(status.timestamp) * 1000),
          conversationId: status.conversation?.id,
          conversationCategory: status.conversation?.origin?.type,
          errorCode: status.errors?.[0]?.code,
          errorMessage: status.errors?.[0]?.message,
        });
      }
    }
  }

  return events;
}

/**
 * Normalize phone number for Meta API
 * Meta expects numbers without + prefix, in E.164 format
 */
function normalizePhone(phone) {
  if (!phone) return "";
  let digits = String(phone).replace(/\D/g, "");
  return digits;
}

/**
 * Generate a random webhook verification token
 */
export function generateWebhookToken() {
  return crypto.randomBytes(32).toString("hex");
}
