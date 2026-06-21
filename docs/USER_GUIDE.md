# ParroByte CRM — User Guide

## Table of Contents
1. [Getting Started](#getting-started)
2. [Dashboard Overview](#dashboard-overview)
3. [WhatsApp Sessions](#whatsapp-sessions)
4. [Contacts](#contacts)
5. [Message Templates](#message-templates)
6. [Sending Messages](#sending-messages)
7. [Bulk Messaging](#bulk-messaging)
8. [Scheduled Messages](#scheduled-messages)
9. [Auto Reply](#auto-reply)
10. [AI Assistant](#ai-assistant)
11. [Email Automation](#email-automation)
12. [Leads Management](#leads-management)
13. [Lead Capture Forms](#lead-capture-forms)
14. [Google Maps Scraper](#google-maps-scraper)
15. [Social Media Automation](#social-media-automation)
16. [Developer API](#developer-api)
17. [Webhooks](#webhooks)
18. [Billing & Credits](#billing--credits)
19. [Account Settings](#account-settings)
20. [FAQ](#faq)

---

## Getting Started

### 1. Sign Up
1. Visit the landing page and click **"Get Started Free"**
2. Fill in your name, email, and password
3. You receive **50 free credits** automatically

### 2. Log In
1. Go to **Sign In** and enter your credentials
2. Optional: Enable OTP verification for extra security

### 3. Connect WhatsApp
1. Go to **Sessions** in the sidebar
2. Click **"Create Session"**
3. Scan the QR code with your WhatsApp app
4. Status changes to **"Connected"** when ready

---

## Dashboard Overview

The dashboard shows:
- **Credit Balance** — Your current credits in ₹
- **Connected Sessions** — Active WhatsApp accounts
- **Recent Messages** — Latest sent/received messages
- **Service Icons** — Quick access to all features with per-use pricing
- **Credit Packages** — Top-up options (Starter, Pro, Business, Enterprise)
- **Service Bundles** — Service-specific credit packs

---

## WhatsApp Sessions

### Creating a Session
1. Navigate to **Sessions**
2. Click **"New Session"**
3. Enter a name (e.g., "Business Account")
4. Wait for QR code to appear
5. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
6. Scan the QR code

### Managing Sessions
- **Disconnect** — Safely logout without deleting auth data
- **Delete** — Permanently remove session (requires re-scanning QR)
- **Reconnect** — Auto-reconnects on server restart using saved auth

### Session Limits
- Each user can connect multiple sessions
- Each session has its own rate limit (30 messages/minute)

---

## Contacts

### Adding Contacts
1. Go to **Contacts**
2. Click **"Add Contact"**
3. Fill name, phone (with country code), email, group, tags, notes
4. Save

### Bulk Import (CSV)
1. Click **"Import CSV"**
2. Upload a CSV file with columns: `name`, `phone`, `email`, `group`, `tags`
3. Map columns if needed
4. Import — duplicates are skipped

### Groups & Tags
- **Groups**: Organize contacts (e.g., "Customers", "VIP", "Leads")
- **Tags**: Flexible labels (e.g., "interested", "follow-up", "converted")

---

## Message Templates

### Creating Templates
1. Go to **Templates**
2. Click **"New Template"**
3. Choose type: Text, Image, Document, Video, Audio
4. For media: upload file or provide URL
5. Use variables like `{{name}}`, `{{phone}}` for personalization

### Using Templates
- Select template when composing a message
- Variables auto-replaced from contact data

---

## Sending Messages

### Single Message
1. Go to **Messages**
2. Select a session and contact
3. Type message or choose template
4. Attach media (optional)
5. Click **Send**

### Recording Audio
1. Click the **microphone icon**
2. Record your voice message
3. Automatically converted to MP3 for WhatsApp compatibility
4. Send

---

## Bulk Messaging

### Creating a Bulk Campaign
1. Go to **Bulk Messaging**
2. Select session and contacts (or entire groups)
3. Choose template or type custom message
4. Set gap between messages (default 45 seconds)
5. Click **Start Campaign**

### Monitoring
- View progress: sent count, failed count, status
- Failed messages show error details
- Campaigns run in background — you can leave the page

### Best Practices
- Start with small batches (10-20 contacts)
- Use appropriate gaps (45s+) to avoid rate limits
- Personalize with templates containing variables

---

## Scheduled Messages

### Scheduling a Campaign
1. Go to **Schedule**
2. Select session, contacts, and template/content
3. Pick date and time
4. Choose timezone
5. Save

### How It Works
- Cron job checks every minute
- Messages sent sequentially with 30-second gaps
- Status updates: pending → processing → completed/failed

---

## Auto Reply

### Creating Rules
1. Go to **Auto Reply**
2. Click **"New Rule"**
3. Configure:
   - **Trigger Type**: Exact match, Contains, Starts with, Ends with, Regex
   - **Trigger Value**: The keyword (e.g., "price", "hello", "help")
   - **Response Type**: Static text or AI-generated
   - **Response Content**: Your reply message
   - **Session**: Apply to specific session or all

### Example Rules
| Trigger | Type | Response |
|---------|------|----------|
| "hello" | contains | "Hi! How can we help you today?" |
| "price" | contains | AI reply with business pricing info |
| "^order" | regex | "Please share your order number" |

### Priority
- Rules are checked in order (top to bottom)
- First matching rule wins
- Drag to reorder

---

## AI Assistant

### Setup
1. Go to **AI Config**
2. Toggle **"Enable AI Auto-Reply"**
3. Choose mode:
   - **Universal Reply**: AI responds to ALL incoming messages
   - **Keyword Only**: AI only responds when auto-reply rules match
4. Write your **System Prompt** (AI personality)
5. Add **Business Data** (facts the AI should know)
6. Set **Language** (English, Tamil, Telugu, Hindi, Malayalam, Kannada, or custom)
7. Save and test in the chat panel

### AI Settings
- **Temperature**: 0 = focused/factual, 1 = creative, 2 = random
- **Max Tokens**: Maximum response length
- **Model**: Admin-configured Ollama model (e.g., translategemma:4b)

### Cost
- Each AI reply consumes credits (₹2.00 by default)
- AI responses are queued with 30-second gaps to prevent overload

---

## Email Automation

### SMTP Configuration
1. Go to **Email** → **Settings**
2. Enter your SMTP details:
   - Host, Port, Username, Password
   - From Name and From Email
3. TLS is auto-detected based on port
4. Click **"Test & Save"** — verification runs before saving

### Email Templates
1. Go to **Email** → **Templates**
2. Create HTML or text templates
3. Add permanent attachments (stored in uploads)
4. Use variables like `{{name}}`, `{{company}}`

### Sending Emails
- **Single**: Compose to one recipient
- **Bulk**: Select contacts, choose template, send with 3-second gaps
- **Scheduled**: Pick date/time for future delivery

### Auto-Reply Rules
1. Go to **Email** → **Automation**
2. Create rules based on:
   - Subject contains keyword
   - From specific domain
   - All incoming emails
3. Response: static text, template, or AI-generated

### Incoming Email Webhook
- Configure your email provider to forward webhooks to:
  `POST /email/incoming`
- Automatically creates contacts/leads from new senders

---

## Leads Management

### Pipeline Stages
- **New** → **Contacted** → **Qualified** → **Converted** → **Lost**

### Adding Leads
- Manually: Click "Add Lead"
- From scraper: Import from Google Maps results
- From forms: Auto-captured from enquiry forms
- Via API: Push from external systems

### Lead Actions
- Update status, add notes, assign tags
- Send WhatsApp message directly from lead card
- Send email directly from lead card
- View activity history

---

## Lead Capture Forms

### Creating a Form
1. Go to **Lead URLs**
2. Click **"Create Form"**
3. Configure fields: Name, Email, Phone, and custom labels
4. Set slug (e.g., "summer-campaign")
5. Save

### Embedding
- Share the public URL: `https://yourdomain.com/lead-urls/:slug`
- Or embed via iframe on your website
- Leads submitted auto-appear in your Leads dashboard

---

## Google Maps Scraper

### Running a Scrape
1. Go to **Scraper**
2. Enter search query (e.g., "restaurants in Chennai")
3. Enter location
4. Set max results (higher = more credits)
5. Click **Scrape**

### Results
- View business name, phone, address, website, category
- Import selected results to Leads
- Export to CSV

---

## Social Media Automation

### YouTube
1. Go to **YouTube** → Connect your channel via Google OAuth
2. Create reply rules (keyword matching on comments)
3. System polls every 10 minutes and auto-replies

### Instagram
1. Go to **Instagram** → Connect your business account via Facebook
2. Create reply rules for comments
3. System polls every 10 minutes and auto-replies

### Facebook
1. Go to **Social Automation** → Connect Facebook page
2. Configure auto-reply rules

---

## Developer API

### Getting an API Key
1. Go to **Developer** → **API Keys**
2. Click **"Generate Key"**
3. Name your key and select permissions
4. Copy the key (shown only once)

### Authentication
All API requests require this header:
```
Authorization: Bearer YOUR_API_KEY
```

---

### Send WhatsApp Message

**Endpoint:** `POST /api/messages/send`

**Credit Deduction:** Each message costs credits based on admin configuration (default: ₹0.10 for text/media, ₹0.15 for polls). Credits are deducted automatically after successful send.

---

#### 1. Send Text Message (JSON)

```bash
curl -X POST https://yourdomain.com/api/messages/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "message": "Hello from API!",
    "type": "text",
    "sessionId": 1
  }'
```

---

#### 2. Send Media with File Upload (multipart/form-data)

Upload an image, video, document, or audio file directly:

```bash
curl -X POST https://yourdomain.com/api/messages/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "phone=919876543210" \
  -F "message=Check out this offer!" \
  -F "type=image" \
  -F "mediaFile=@/path/to/your/image.png" \
  -F "sessionId=1"
```

**Supported `type` values:** `text`, `image`, `video`, `audio`, `document`

**`mediaFile`:** The file to upload. Max size: 10MB.

---

#### 3. Send Media from Public URL (JSON)

```bash
curl -X POST https://yourdomain.com/api/messages/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "message": "Check out this image!",
    "type": "image",
    "mediaUrl": "https://example.com/image.png",
    "sessionId": 1
  }'
```

**Note:** `mediaUrl` must be a publicly accessible HTTP/HTTPS URL.

---

#### 4. Send Poll (JSON)

```bash
curl -X POST https://yourdomain.com/api/messages/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "message": "What is your favorite color?",
    "type": "poll",
    "sessionId": 1
  }'
```

**Note:** For poll messages, the poll options must be configured in a template first, or use the poll-specific API endpoints.

---

#### Response Format

**Success:**
```json
{
  "success": true,
  "message": "Message sent successfully",
  "data": {
    "phone": "919876543210",
    "type": "image",
    "sessionId": 1,
    "sessionName": "Business Account",
    "sentAt": "2026-05-08T12:00:00.000Z"
  },
  "credits": {
    "service": "send_message",
    "cost": 0.10,
    "deducted": 0.10,
    "balance": 45.50,
    "isFree": false
  }
}
```

**Insufficient Credits (402):**
```json
{
  "success": false,
  "error": "Insufficient credits. This action requires ₹0.10 credits. You have ₹0.00 credits. Please top up."
}
```

---

### Credit Configuration (Admin)

Admins can configure per-message credit costs at **Admin → Credit Configuration**:

| Service Key | Default Cost | Description |
|-------------|-------------|-------------|
| `send_message` | ₹0.10 | Per outgoing WhatsApp message (text/image/video/audio/document) |
| `poll_message` | ₹0.15 | Per outgoing WhatsApp poll message |

- **Cost**: Amount deducted per message
- **Free Quota**: Number of free messages per month before charging
- **Active/Inactive**: Toggle whether the service deducts credits at all

---

### Example: Push Lead

```bash
curl -X POST https://yourdomain.com/api/v1/leads/push \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "phone": "919876543210",
    "email": "john@example.com",
    "source": "website",
    "status": "new"
  }'
```

---

## Webhooks

### Setting Up
1. Go to **Webhooks**
2. Click **"Add Webhook"**
3. Enter:
   - Name (e.g., "My CRM Integration")
   - URL (your endpoint)
   - Secret (for HMAC signature verification)
   - Events to subscribe to
   - Session (optional — filter by specific WhatsApp session)
4. Save

### Events Available
- `message.received` — Incoming WhatsApp message
- `message.sent` — Outgoing message sent
- `session.connected` — WhatsApp session connected
- `session.disconnected` — WhatsApp session disconnected
- `lead.created` — New lead added
- `contact.created` — New contact added

### Security
- Webhooks include `X-Webhook-Signature: sha256=<hmac>` header
- Verify signature using your secret key

### Testing
- Click **"Test Ping"** on any webhook to verify delivery
- View delivery logs for debugging

---

## Billing & Credits

### Understanding Credits
- Credits are virtual currency priced in Indian Rupees (₹)
- Each service consumes a specific credit amount
- Free monthly quotas reset on the 1st of every month

### Top-Up Packages
| Package | Credits | Price |
|---------|---------|-------|
| Starter | 100 | ₹99 |
| Pro | 500 | ₹399 |
| Business | 2,000 | ₹1,299 |
| Enterprise | 10,000 | ₹4,999 |

### Service Bundles
- Admin-created service-specific packs (e.g., "100 AI Replies for ₹150")
- View on Billing → Services tab

### Transactions
- View all credit usage history
- Filter by date, service, type
- Download invoices (PDF)

### Free Quotas
- Admin can set free uses per service per month
- Checked before deducting credits
- Shown on the service cards in dashboard

---

## Account Settings

### Profile
- Update name, email, avatar
- Change password
- Set timezone and country code

### Theme
- Choose theme color (affects sidebar accent)

### Security
- Enable/disable OTP verification
- View active sessions
- Regenerate API keys

---

## FAQ

**Q: Can I connect multiple WhatsApp accounts?**
A: Yes! Each user can connect multiple sessions. Each has its own rate limit.

**Q: Why is my message stuck on "sending"?**
A: Check if your session is connected. If rate-limited, wait 1 minute.

**Q: How do I avoid getting banned by WhatsApp?**
A: Follow these rules:
- Don't send to numbers who haven't contacted you
- Keep bulk gaps at 45+ seconds
- Don't send identical messages to many people
- Use templates with personalization
- Stay under 30 messages/minute

**Q: Can I schedule messages for later?**
A: Yes, use the **Schedule** feature. Messages are sent by a cron job.

**Q: What happens if I run out of credits?**
A: Actions requiring credits will be blocked. Top up via the Billing page.

**Q: Is my data secure?**
A: Yes. Passwords are bcrypt-hashed, sessions use httpOnly cookies, API keys are encrypted, and the database uses SSL.

**Q: Can I use my own AI model?**
A: Admin configures the Ollama server and model. Users can override model in AI Config (advanced).

**Q: How do I get support?**
A: Use the **Help Center** in your dashboard or email support@parrobyte.com.
