# Instagram DM Automation Setup Guide

This guide walks you through setting up Instagram DM (Direct Message) automation in ParroByte CRM.

## What It Does

- **Connect** your Instagram Business/Creator account via OAuth
- **Receive DMs** via Meta webhooks in real-time
- **Auto-reply** to DMs based on keyword rules (same rules used for comment auto-reply)
- **Chat inbox** to view conversations and send manual replies from the CRM

---

## Prerequisites

1. An **Instagram Business Account** or **Creator Account**
2. The Instagram account must be **connected to a Facebook Page**
3. A **Facebook App** with the Instagram product added

---

## Step 1: Environment Variables

Add these to your `.env` file:

```env
# Facebook App credentials
FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret
INSTAGRAM_REDIRECT_URI=https://crm.parrobyte.co.in/instagram/oauth/callback

# Instagram Webhook verification token (must match Meta dashboard)
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=parrobyte_crm_verify_12345
```

**Note:** The webhook verification token is `parrobyte_crm_verify_12345` as requested.

---

## Step 2: Database Migration

Run the migration to create DM tables:

```bash
# Using psql (adjust connection params as needed)
psql -U your_db_user -d whatscrm -f db/migrations/002_add_instagram_dm_support.sql

# Or run the SQL directly in your PostgreSQL client
```

The migration adds:
- `page_access_token` column to `instagram_connections`
- `instagram_dm_conversations` table
- `instagram_dm_messages` table

---

## Step 3: Facebook App Configuration

### 3.1 Create / Configure Facebook App

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Create a new app (Business type) or use an existing one
3. Add the **Instagram** product to your app

### 3.2 Configure OAuth Settings

1. Go to **Instagram > Basic Display** (or use the Graph API directly)
2. Add your OAuth Redirect URI:
   ```
   https://crm.parrobyte.co.in/instagram/oauth/callback
   ```
3. Under **Settings > Basic**, note your **App ID** and **App Secret**

### 3.3 Configure Webhooks ⚠️ IMPORTANT

**Do NOT confuse the Webhook URL with the OAuth Callback URL. They are different endpoints.**

1. Go to your app's **Webhooks** section
2. Add a webhook subscription for **Instagram**
3. Set the **Callback URL** (this is for webhooks, NOT OAuth):
   ```
   https://crm.parrobyte.co.in/instagram/webhook
   ```
4. Set the **Verify Token**:
   ```
   parrobyte_crm_verify_12345
   ```
5. Subscribe to the `messages` field

**Common mistake:** Entering `https://crm.parrobyte.co.in/instagram/oauth/callback` here. That is the OAuth callback — the webhook endpoint is `/instagram/webhook`.

### 3.4 Required Permissions

The OAuth flow requests these permissions:
- `instagram_basic` — read Instagram account info
- `instagram_manage_comments` — comment auto-reply
- `instagram_messaging` — send/receive DMs
- `pages_messaging` — page messaging access
- `pages_read_engagement` — read page data
- `pages_manage_metadata` — subscribe to webhooks

---

## Step 4: Connect Instagram in CRM

1. Log into ParroByte CRM
2. Go to **Instagram Automation** in the sidebar
3. Click **Connect Instagram**
4. Complete the Facebook OAuth flow
5. Select the Facebook Page connected to your Instagram account

After connection:
- The app automatically subscribes the page to messaging webhooks
- You can now create keyword-based auto-reply rules
- Incoming DMs will appear in the **DM Conversations** table

---

## Step 5: Create Auto-Reply Rules

1. On the Instagram Automation page, scroll to **Auto-Reply Rules**
2. Click **Add Rule**
3. Configure:
   - **Rule Name**: e.g., "Price Inquiry"
   - **Trigger Type**: `contains`, `exact`, `starts_with`, `ends_with`, or `regex`
   - **Trigger Value**: e.g., `price` or `how much`
   - **Response**: The auto-reply message sent via DM
4. Save the rule

The same rules apply to **both comments and DMs**.

---

## Step 6: Test the Integration

### Test Connection
1. Click **Test Connection** on the Instagram page
2. You should see your Instagram username and recent posts

### Test Rules
1. In the **Test Your Rules** section, type a sample DM message
2. See which rules match and what the response would be

### Send a Real DM
1. From another Instagram account, send a DM to your connected Instagram Business account
2. The message should appear in the **DM Conversations** table within seconds
3. If a rule matches, an auto-reply will be sent automatically

---

## Webhook Payload Format

The endpoint at `POST /instagram/webhook` receives:

```json
{
  "object": "instagram",
  "entry": [{
    "id": "PAGE_ID",
    "time": 1234567890,
    "messaging": [{
      "sender": { "id": "SENDER_IGSID" },
      "recipient": { "id": "PAGE_ID" },
      "timestamp": 1234567890,
      "message": {
        "mid": "MESSAGE_ID",
        "text": "Hello, what are your prices?"
      }
    }]
  }]
}
```

---

## Troubleshooting

### "No Instagram Business Account found"
- Ensure your Instagram account is a **Business** or **Creator** account
- Ensure it's connected to a Facebook Page
- Go to your Facebook Page > Settings > Linked Accounts > Instagram

### "Webhook verification failed"
- **Make sure you used `/instagram/webhook` NOT `/instagram/oauth/callback`** in the Meta dashboard
- Check that `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` in `.env` matches the token in Meta dashboard
- Ensure the webhook URL is publicly accessible (not localhost)

**Test your webhook endpoint manually before configuring in Meta:**
```bash
curl -X GET "https://crm.parrobyte.co.in/instagram/webhook?hub.mode=subscribe&hub.verify_token=parrobyte_crm_verify_12345&hub.challenge=test_challenge_123"
```
You should get back: `test_challenge_123`

If you get a 403, check your `.env` has `INSTAGRAM_WEBHOOK_VERIFY_TOKEN=parrobyte_crm_verify_12345`
If you get a 404, the server code hasn't been deployed yet

### DMs not appearing
- Check that the page is subscribed to webhooks (done automatically on connect)
- Verify the Facebook app has `instagram_messaging` permission approved by Meta
- Check server logs for webhook payload errors

### "Failed to send DM"
- The 24-hour messaging window may have expired for that user
- The page access token may have expired — reconnect Instagram
- Check that the recipient hasn't blocked messaging

### Auto-replies not sending
- Ensure the rule is **Active**
- Check that the trigger value matches the incoming message
- Review the **DM Conversations** table to see if messages were received

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/instagram/webhook` | Public | Webhook verification (Meta) |
| POST | `/instagram/webhook` | Public | Receive DM events from Meta |
| GET | `/instagram/dm/conversations` | Auth | List DM conversations |
| GET | `/instagram/dm/conversations/:id/messages` | Auth | Get messages for a conversation |
| POST | `/instagram/dm/send` | Auth | Send a manual DM |
| GET | `/instagram/oauth/start` | Auth | Start OAuth flow |
| GET | `/instagram/oauth/callback` | Public | OAuth callback |

---

## Security Notes

- The webhook endpoint is **public** (Meta sends requests without session cookies)
- Webhook verification uses the token match to prevent unauthorized subscriptions
- Page access tokens are stored encrypted in the database
- Only the connected user's DMs are accessible via the CRM UI
