# Facebook & Instagram Automation Setup Guide

This guide walks you through setting up AI-powered DM and comment auto-replies for Facebook Pages and Instagram Business Accounts.

---

## Table of Contents
1. [What You Need](#what-you-need)
2. [Step 1: Create a Facebook App](#step-1-create-a-facebook-app)
3. [Step 2: Configure Instagram Basic Display](#step-2-configure-instagram-basic-display)
4. [Step 3: Configure Instagram Graph API](#step-3-configure-instagram-graph-api)
5. [Step 4: Configure Webhooks](#step-4-configure-webhooks)
6. [Step 5: OAuth Redirect URIs](#step-5-oauth-redirect-uris)
7. [Step 6: Required Permissions](#step-6-required-permissions)
8. [Step 7: Connect in ParroByte CRM](#step-7-connect-in-parrobyte-crm)
9. [Step 8: AI Configuration](#step-8-ai-configuration)
10. [Troubleshooting](#troubleshooting)

---

## What You Need

### Prerequisites
- A **Facebook Business Account** (business.facebook.com)
- A **Facebook Page** (you must be an Admin)
- An **Instagram Business Account** linked to your Facebook Page
- A **Meta Developer Account** (developers.facebook.com)
- A publicly accessible URL for webhooks (e.g., `https://crm.parrobyte.co.in`)

### Information to Collect
| Item | Where to Find | Used In |
|------|--------------|---------|
| App ID | App Dashboard → Settings → Basic | `.env` `FACEBOOK_APP_ID` |
| App Secret | App Dashboard → Settings → Basic | `.env` `FACEBOOK_APP_SECRET` |
| Verify Token | You create this | `.env` `FACEBOOK_WEBHOOK_VERIFY_TOKEN` |
| Page Access Token | After OAuth | Auto-saved to DB |
| Page ID | Page Settings → Page Info | Auto-detected |

---

## Step 1: Create a Facebook App

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click **"Create App"**
3. Select app type: **"Business"**
4. Fill in:
   - **App Name**: `ParroByte CRM Automation`
   - **App Contact Email**: Your email
   - **Business Account**: Select your business account
5. Click **"Create App"**

### App Settings

1. In your app dashboard, go to **Settings → Basic**
2. Copy the **App ID** and **App Secret** into your `.env`:
   ```env
   FACEBOOK_APP_ID=your_app_id_here
   FACEBOOK_APP_SECRET=your_app_secret_here
   ```
3. Add your **Privacy Policy URL**: `https://yourdomain.com/privacy`
4. Add your **App Icon** (required for Instagram approval)
5. Set **Category**: `Business and Pages`

---

## Step 2: Configure Instagram Basic Display

> ⚠️ **Note**: Instagram Basic Display is for reading public data. For DM automation, you need Instagram Graph API (Step 3). Add both products.

1. In your app dashboard, click **"Add Product"**
2. Find **"Instagram Basic Display"** and click **"Set Up"**
3. Under **Instagram Basic Display → Basic Display**
4. Add these **Valid OAuth Redirect URIs**:
   ```
   https://yourdomain.com/instagram/oauth/callback
   https://yourdomain.com/social-automation/facebook/callback
   ```
5. Save Changes

---

## Step 3: Configure Instagram Graph API

1. In your app dashboard, click **"Add Product"**
2. Find **"Instagram Graph API"** and click **"Set Up"**
3. This enables programmatic access to Instagram Business Accounts

### Link Instagram to Facebook Page

1. Go to your **Facebook Page** → Settings
2. Click **"Linked Accounts"** → **"Instagram"**
3. Log in with your **Instagram Business Account**
4. Click **"Connect"**
5. Your Instagram Business Account is now linked to your Facebook Page

---

## Step 4: Configure Webhooks

### For Instagram Webhooks

1. In App Dashboard → **Instagram Graph API → Webhooks**
2. Click **"Subscribe to this object"** for:
   - **Instagram Messages** → Subscribe to `messages`
   - **Instagram Mentions** → Subscribe to `mentions`
3. For each webhook, enter:
   - **Callback URL**: `https://yourdomain.com/instagram/webhook`
   - **Verify Token**: Create a strong random string (e.g., `parrobyte_2024_secure_token_xyz`)
   - Save this in your `.env`:
     ```env
     INSTAGRAM_WEBHOOK_VERIFY_TOKEN=parrobyte_2024_secure_token_xyz
     ```
4. Click **"Verify and Save"**

### For Facebook Page Webhooks

1. In App Dashboard → **Webhooks** → **Page**
2. Click **"Subscribe to this object"**
3. Enter:
   - **Callback URL**: `https://yourdomain.com/social-automation/facebook/webhook`
   - **Verify Token**: Same as above (or different if preferred)
   - Save in `.env`:
     ```env
     FACEBOOK_WEBHOOK_VERIFY_TOKEN=parrobyte_2024_secure_token_xyz
     ```
4. Click **"Verify and Save"**
5. Subscribe to these **fields**:
   - `messages` (for DM auto-replies)
   - `messaging_postbacks` (for button clicks)
   - `feed` (for comments on posts)
6. Select your **Facebook Page** to subscribe

---

## Step 5: OAuth Redirect URIs

Add these to your Facebook App → **Settings → Advanced → Security** → **Valid OAuth Redirect URIs**:

```
https://yourdomain.com/instagram/oauth/callback
https://yourdomain.com/social-automation/facebook/callback
```

Also add to **Instagram Basic Display → Valid OAuth Redirect URIs**:
```
https://yourdomain.com/instagram/oauth/callback
https://yourdomain.com/social-automation/facebook/callback
```

---

## Step 6: Required Permissions

The OAuth flow requests these permissions automatically. Make sure they are approved in your app:

### For Instagram DM Automation:
| Permission | Purpose | Approval Needed? |
|-----------|---------|-----------------|
| `instagram_basic` | Read Instagram profile info | No (basic) |
| `instagram_manage_comments` | Read/reply to comments | No (basic) |
| `instagram_messaging` | Send/receive DMs | **Yes** — requires App Review |
| `pages_read_engagement` | Read page engagement data | No (basic) |
| `pages_manage_metadata` | Manage page webhooks | No (basic) |
| `pages_messaging` | Send/receive Facebook Page DMs | **Yes** — requires App Review |

### For Facebook Page Automation:
| Permission | Purpose | Approval Needed? |
|-----------|---------|-----------------|
| `pages_messaging` | Send/receive Page DMs | **Yes** — App Review |
| `pages_read_engagement` | Read page posts/comments | No (basic) |
| `pages_manage_metadata` | Subscribe to webhooks | No (basic) |
| `pages_show_list` | List user's pages | No (basic) |

### App Review Process (for production)

1. Go to **App Review → Permissions and Features**
2. Find `instagram_messaging` and `pages_messaging`
3. Click **"Request Advanced Access"**
4. Provide:
   - **Use Case Description**: "Our CRM platform allows businesses to automate customer support via Instagram DMs and Facebook Page messages. Users connect their own Instagram Business Account and Facebook Page. Auto-replies are triggered by keyword matching and AI to provide instant responses."
   - **Screencast**: Record a 2-minute video showing:
     - User connecting their Instagram/Facebook account
     - Receiving a DM
     - Automatic reply being sent
     - Viewing conversation in the CRM
   - **Login Flow**: Show Facebook Login working
5. Submit for review (takes 3-5 business days)

> 💡 **For testing**: You don't need App Review if all users are added as **Testers** or **Developers** in the app roles.

---

## Step 7: Connect in ParroByte CRM

### Instagram
1. Go to **Social Automation → Instagram** in your CRM
2. Click **"Connect Instagram Account"**
3. You'll be redirected to Facebook Login
4. Grant all permissions
5. Select your Facebook Page that has the linked Instagram Business Account
6. Connection complete! Webhooks auto-subscribed.

### Facebook
1. Go to **Social Automation → Facebook** in your CRM
2. Click **"Connect Facebook Page"**
3. Grant permissions
4. Select your Facebook Page
5. Connection complete!

---

## Step 8: AI Configuration

### Prerequisites
- Ollama installed and running (`ollama serve`)
- At least one model downloaded (e.g., `ollama pull llama3.2:3b`)

### Enable AI for Social Platforms

**Option 1: Via API**
```bash
curl -X POST https://yourdomain.com/instagram/ai-settings \
  -H "Content-Type: application/json" \
  -d '{
    "instagramAiEnabled": true,
    "instagramAiFallback": true,
    "facebookAiEnabled": true,
    "facebookAiFallback": true,
    "aiPersona": "You are a friendly fitness coach. Keep replies motivational and under 200 characters."
  }'
```

**Option 2: Via CRM UI** (Settings → AI → Social Platforms)

### How AI Replies Work

| Scenario | Behavior |
|----------|----------|
| **Rule matches** | Sends rule's response content |
| **Rule = AI type** | Generates AI response using rule's AI prompt |
| **No rule matches + AI fallback ON** | Generates AI response from incoming message |
| **No rule matches + AI fallback OFF** | Uses smart template fallback |
| **AI fails** (Ollama down) | Falls back to smart templates |

### AI Reply Flow
```
Incoming DM/Comment
    ↓
Match keyword rule?
    ↓ YES → Rule says "ai"? → Generate AI reply → Send
    ↓ NO → AI fallback enabled? → Generate AI reply → Send
    ↓ NO → Smart template fallback → Send
```

---

## Automation Rules

### Create Instagram Rules
```bash
curl -X POST https://yourdomain.com/instagram/rules/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pricing Inquiry",
    "triggerType": "contains",
    "triggerValue": "price",
    "responseContent": "Our plans start at ₹999/month! Check the link in bio for details 💰",
    "responseType": "static"
  }'
```

### Create Facebook Rules
```bash
curl -X POST https://yourdomain.com/social-automation/facebook/rules/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI Greeting",
    "triggerType": "contains",
    "triggerValue": "hello",
    "responseContent": "Hey there! 👋",
    "responseType": "ai",
    "aiPrompt": "Greet the user warmly and ask how you can help today. Keep it under 100 characters."
  }'
```

### Trigger Types
| Type | Example Trigger | Matches |
|------|----------------|---------|
| `exact` | "help" | Only "help" |
| `contains` | "price" | "what's your price?" |
| `starts_with` | "order" | "order 123" |
| `ends_with` | "thanks" | "many thanks" |
| `regex` | "\b\d{10}\b" | Any 10-digit number |

---

## Webhook Verification Tokens

In your `.env` file:
```env
# Can be the same token for both
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=your_secure_random_token_here
FACEBOOK_WEBHOOK_VERIFY_TOKEN=your_secure_random_token_here

# Or different tokens
# INSTAGRAM_WEBHOOK_VERIFY_TOKEN=ig_token_abc123
# FACEBOOK_WEBHOOK_VERIFY_TOKEN=fb_token_xyz789
```

> 🔒 **Security**: Use a long random string (min 32 chars). Never expose this in client-side code.

---

## Troubleshooting

### Webhooks not receiving events
1. Check that your server is publicly accessible (ngrok for local dev)
2. Verify webhook subscription in App Dashboard → Webhooks
3. Check `server.log` for `[FB Webhook]` or `[Instagram Webhook]` logs
4. Ensure `VERIFY_TOKEN` matches exactly between `.env` and Meta dashboard
5. Test with: `curl -X GET "https://yourdomain.com/instagram/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"`

### "No connection found" errors
1. Disconnect and reconnect the account
2. Check that the Facebook Page is still linked to Instagram
3. Verify `accessToken` hasn't expired (check `token_expiry` in DB)

### AI replies not working
1. Check Ollama is running: `curl http://localhost:11434/api/tags`
2. Verify AI config exists in Settings → AI Config
3. Check `social_ai_settings` table for `instagram_ai_enabled` / `facebook_ai_enabled`
4. Check server logs for `[SocialAI]` errors

### Permission denied during OAuth
1. Ensure you're an **Admin** of the Facebook Page
2. The Instagram account must be a **Business Account** (not personal)
3. Instagram must be linked to the Facebook Page
4. For production: Complete App Review for `instagram_messaging` and `pages_messaging`

### Comments not being replied
1. Check `instagram_replied_comments` / `facebook_replied_comments` for duplicates
2. Ensure comment polling is running (auto-starts on connect)
3. Check that rules are `is_active = true`
4. Comments from the page owner are ignored (to prevent loops)

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Meta/Facebook │────▶│  Your Server     │────▶│   PostgreSQL    │
│   Webhooks      │     │  /instagram/webhook    │   instagram_connections
│                 │     │  /social-automation/facebook/webhook  │   facebook_connections
└─────────────────┘     └──────────────────┘     │   instagram_reply_rules
                           │                      │   facebook_reply_rules
                           ▼                      │   instagram_dm_conversations
                    ┌─────────────┐              │   facebook_dm_conversations
                    │  AI Engine  │              │   social_ai_settings
                    │  (Ollama)   │              └─────────────────┘
                    └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Auto-Reply │────▶ Back to Meta API
                    │  (DM/Comment│
                    │   via Graph)│
                    └─────────────┘
```

---

## Quick Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/instagram/webhook` | GET | Webhook verification |
| `/instagram/webhook` | POST | Receive Instagram events |
| `/social-automation/facebook/webhook` | GET | Webhook verification |
| `/social-automation/facebook/webhook` | POST | Receive Facebook events |
| `/instagram/oauth/start` | GET | Start Instagram OAuth |
| `/social-automation/facebook/auth` | GET | Start Facebook OAuth |
| `/instagram/ai-settings` | GET/POST | Instagram AI config |
| `/social-automation/facebook/ai-settings` | GET/POST | Facebook AI config |

---

**Last Updated**: 2026-05-06
**Version**: ParroByte CRM Social Automation v2.0
