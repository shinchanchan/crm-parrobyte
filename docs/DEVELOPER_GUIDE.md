# ParroByte CRM — Developer Guide

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Database Schema](#database-schema)
5. [Authentication Flow](#authentication-flow)
6. [WhatsApp Session Management](#whatsapp-session-management)
7. [Credit System](#credit-system)
8. [AI Auto-Reply Flow](#ai-auto-reply-flow)
9. [Email Automation Flow](#email-automation-flow)
10. [Webhook System](#webhook-system)
11. [API Reference](#api-reference)
12. [Cron Jobs](#cron-jobs)
13. [Environment Variables](#environment-variables)
14. [Code Conventions](#code-conventions)

---

## Architecture Overview

ParroByte CRM is a monolithic Node.js/Express application using server-side rendering (EJS) with a PostgreSQL database. It integrates with external services via APIs and browser automation (Puppeteer).

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Browser                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / EJS
┌──────────────────────────▼──────────────────────────────────┐
│                    Express.js Server                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐   │
│  │  Auth/RBAC  │ │  CRUD APIs  │ │  Public API (CORS)  │   │
│  └─────────────┘ └─────────────┘ └─────────────────────┘   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐   │
│  │ Credit Sys  │ │ Webhooks    │ │ File Uploads        │   │
│  └─────────────┘ └─────────────┘ └─────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
┌───────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
│ PostgreSQL   │  │ WhatsApp Web │  │ External APIs│
│ (Drizzle ORM)│  │ (Puppeteer)  │  │ (YT/IG/FB)   │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 18+ |
| Framework | Express.js | 4.22.1 |
| Templating | EJS + express-ejs-layouts | 3.1.10 |
| CSS | Tailwind CSS (CDN) + DaisyUI | 4.x |
| Database | PostgreSQL | 14+ |
| ORM | Drizzle ORM | 0.30.x |
| WhatsApp | whatsapp-web.js + Puppeteer | 1.23.0 / 21.6.1 |
| AI | Ollama (local LLM) | 0.6.3 |
| Payments | Razorpay | 2.9.6 |
| Email | Nodemailer | 6.10.1 |
| Session | express-session | 1.19.0 |
| Security | Helmet + express-rate-limit | 7.2.0 / 7.5.1 |

---

## Project Structure

```
app/
├── server.js                 # Express entry point, middleware, cron jobs
├── package.json
├── .env                      # Environment variables
├── drizzle.config.js         # Drizzle ORM config
├── db/
│   ├── schema.js             # All table definitions (Drizzle)
│   ├── seed.js               # Admin user seed
│   └── migrations/           # Migration files
├── server/
│   ├── lib/
│   │   ├── db.js             # PostgreSQL connection pool
│   │   ├── credits.js        # Credit balance & cost management
│   │   ├── aiService.js      # Ollama AI prompt builder
│   │   ├── aiQueueProcessor.js # Background AI reply worker
│   │   ├── webhookTrigger.js # Webhook delivery + HMAC signing
│   │   ├── mail.js           # SMTP email sender
│   │   ├── invoicePdf.js     # Puppeteer PDF invoice generation
│   │   ├── razorpay.js       # Payment gateway integration
│   │   ├── youtube.js        # YouTube comment polling
│   │   ├── instagram.js      # Instagram comment polling
│   │   └── paginate.js       # Pagination helper
│   └── routes/               # All Express route modules
│       ├── auth.js           # Login, register, OTP, forgot password
│       ├── dashboard.js      # Dashboard stats
│       ├── sessions.js       # WhatsApp QR/connect/disconnect
│       ├── contacts.js       # Contact CRUD + CSV import
│       ├── templates.js      # Message template CRUD
│       ├── messages.js       # Message history + send
│       ├── schedule.js       # Scheduled message campaigns
│       ├── autoReply.js      # Keyword auto-reply rules
│       ├── bulk.js           # Bulk messaging campaigns
│       ├── billing.js        # Credit balance, packages, invoices
│       ├── payments.js       # Razorpay checkout & verify
│       ├── email.js          # SMTP config, send, templates, scheduling
│       ├── aiConfig.js       # AI settings + test chat
│       ├── webhooks.js       # Outgoing webhook management
│       ├── apiKeys.js        # Developer API key management
│       ├── admin.js          # Admin dashboard + user management
│       ├── developer.js      # Developer docs + API testing
│       ├── leads.js          # Lead CRM pipeline
│       ├── leadUrls.js       # Public lead capture URLs
│       ├── forms.js          # Enquiry form builder
│       ├── scraper.js        # Google Maps business scraper
│       ├── socialAutomation.js # Facebook/Instagram automation
│       ├── youtube.js        # YouTube connection + rules
│       ├── instagram.js      # Instagram connection + rules
│       ├── facebook.js       # Facebook page integration
│       ├── enterprise.js     # Enterprise plan enquiries
│       └── landingEnquiries.js # Public landing page form
├── whatsapp/
│   └── manager.js            # WhatsApp Web.js client manager
├── views/
│   ├── layout.ejs            # Main HTML layout
│   ├── partials/             # Sidebar, navbar, footer, flash
│   └── pages/                # All page templates
├── public/
│   └── uploads/              # Media, documents, email attachments
└── docs/                     # Documentation (this folder)
```

---

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | Accounts: name, email, password (bcrypt), role, credits, plan, sessionToken |
| `plans` | Legacy plan definitions (kept for backward compat) |
| `credit_configs` | Per-service cost configuration + free quota |
| `credit_transactions` | Ledger: debit/credit history with balanceAfter |
| `service_packages` | Admin-configurable credit bundles |
| `whatsapp_sessions` | Connected WA sessions: status, qrCode, phoneNumber |
| `contacts` | User contact book with groups/tags |
| `templates` | Reusable message templates (text/image/doc/video) |
| `messages` | Outbound message log with status |
| `scheduled_messages` | Future-dated campaigns with cron processing |
| `auto_replies` | Keyword trigger rules: exact/contains/starts_with/ends_with/regex |
| `automation_rules` | Advanced automation with email actions |
| `message_queue` | Background send queue |
| `ai_message_queue` | Background AI response queue |
| `api_keys` | Developer API keys with permissions |
| `webhooks` + `webhook_logs` | Outgoing webhooks with HMAC signatures & delivery logs |
| `activity_logs` | Audit trail with IP & userAgent |
| `invoices` | Payment invoices (Razorpay) |
| `leads` | Lead CRM: source, status pipeline, notes, tags |
| `lead_urls` | Public embeddable lead capture forms |
| `enquiry_forms` | Custom form builder with branding |
| `scraping_jobs` + `scraped_businesses` | Google Maps scraper |
| `bulk_uploads` + `bulk_message_jobs` | Bulk campaign tracking |
| `social_accounts` + `social_automations` | Facebook/Instagram automation |
| `youtube_connections` + `youtube_reply_rules` + `youtube_replied_comments` | YouTube automation |
| `instagram_connections` + `instagram_reply_rules` + `instagram_replied_comments` | Instagram automation |
| `email_configs` + `email_templates` + `email_messages` + `email_automation_rules` + `scheduled_emails` | Full email automation |
| `ai_configs` | AI settings: Ollama URL, model, prompt, language, toggles |
| `landing_enquiries` + `enterprise_enquiries` | Public enquiry forms |

### Enums
- `role`: user | admin
- `plan`: free | silver | gold | platinum (legacy)
- `status`: connecting | connected | disconnected | qr_ready
- `message_type`: text | image | document | video | audio
- `message_status`: pending | queued | sending | sent | failed | delivered
- `trigger_type`: exact | contains | starts_with | ends_with | regex
- `response_type`: static | ai
- `lead_status`: new | contacted | qualified | converted | lost
- `invoice_status`: pending | paid | failed | refunded

---

## Authentication Flow

### Registration
1. `POST /auth/register` — Validates name, email, password
2. Password hashed with `bcryptjs` (salt rounds 10)
3. User inserted with `role: "user"`, `credits: 50`, `plan: "free"`
4. Redirect to login

### Login
1. `POST /auth/login` — Validates credentials
2. Generates UUID `sessionToken`, stores in DB
3. Stores user object + `_token` in `req.session`
4. Redirect to dashboard

### Single Login Enforcement
- Every request checks `req.session.user._token` against DB `users.sessionToken`
- If mismatch → destroys session, flashes error, redirects to login
- Logout clears `sessionToken` from DB

### OTP Verification (Optional)
- Email OTP sent on login for extra security
- OTP stored in `users.emailOtp` with 10-minute expiry

### Role-Based Access
- `requireAuth` — checks session exists
- `requireAdmin` — checks `role === "admin"`
- Admin sees: user management, credit config, service packages, activity logs, landing enquiries

---

## WhatsApp Session Management

### Session Lifecycle
```
User clicks "Create Session"
  → DB insert (status: "connecting")
  → Puppeteer launches with LocalAuth
  → QR event → qrcode.toDataURL() → DB update (status: "qr_ready")
  → User scans QR
  → Ready event → DB update (status: "connected", phoneNumber)
  → Message handlers active
  → Disconnected event → Auto-reconnect after 10s (if not user-initiated)
```

### Anti-Ban Measures (Built-in)
1. **Rate Limiting**: 30 messages/minute per user (`checkRateLimit()`)
2. **Bulk Gaps**: Default 45-second delay between bulk messages (configurable)
3. **Scheduled Gaps**: 30-second delay between scheduled campaign messages
4. **AI Queue Gap**: 30-second gap per user between AI auto-replies
5. **Message Queue**: Sequential processing prevents burst sends
6. **Media Size Limit**: 10MB max file size
7. **Human-like Behavior**: Puppeteer args disable automation detection flags
8. **Auto-reconnect**: Transient errors retry up to 5 times with backoff

### Puppeteer Configuration
```javascript
headless: "new",
protocolTimeout: 0,           // No CDP timeout
handleSIGINT: false,
handleSIGTERM: false,
timeout: 120000,
bypassCSP: true,
defaultViewport: { width: 1280, height: 720 },
args: [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled", // Hide automation
  ...
]
```

---

## Credit System

### Flow
```
User performs action
  → checkCredits(userId, serviceKey, quantity)
  → Reads cost from credit_configs
  → Checks free_quota (monthly calendar reset)
  → If freeRemaining >= quantity → allowed (cost=0)
  → Else if balance >= totalCost → allowed
  → deductCredits() → atomic update + transaction log
```

### Credit Costs (Default)
| Service Key | Cost (₹) | Description |
|-------------|----------|-------------|
| send_message | 1.00 | WhatsApp message |
| incoming_message | 0.50 | Receiving a message |
| ai_reply | 2.00 | AI-generated auto-reply |
| send_email | 0.50 | Single email |
| create_email_template | 1.00 | Email template creation |
| create_email_automation | 3.00 | Email automation rule |
| scrape_leads | 5.00 | Google Maps scrape |
| youtube_reply | 1.00 | YouTube comment reply |
| instagram_reply | 1.00 | Instagram comment reply |

### Top-Up Flow
1. User selects package on Billing page
2. Razorpay checkout initiated
3. `POST /payments/verify` — signature verification
4. `addCredits()` — credits added + invoice generated
5. Invoice PDF generated via Puppeteer + emailed to user

---

## AI Auto-Reply Flow

### Universal Mode
```
Incoming message
  → handleIncomingMessage()
  → universalAiReply = true?
  → checkCredits("incoming_message")
  → checkCredits("ai_reply")
  → @lid contact? → immediate msg.reply() with AI response
  → @c.us contact? → queueAiResponse() → background processor
  → AI Queue Processor (30s gap per user)
    → generateAiResponse()
    → Ollama chat API
    → waManager.sendReply()
    → deductCredits("ai_reply")
```

### Keyword Mode
```
Incoming message
  → Match against auto_replies rules (exact/contains/starts_with/ends_with/regex)
  → First match wins
  → responseType = "static" → immediate msg.reply()
  → responseType = "ai" → same flow as universal mode
```

### AI Prompt Construction
```
system: {systemPrompt} + Business Information: {businessData}
        + [language instruction if not English]
user: {incomingMessage}
```

---

## Email Automation Flow

### SMTP Configuration
1. User saves SMTP settings at `/email/config`
2. `buildTransporter()` auto-detects TLS based on port (465=SSL, 587=STARTTLS)
3. Multi-strategy verification before save
4. Config stored in `email_configs` table

### Sending Flow
```
Send Email
  → buildTransporter(config)
  → nodemailer.sendMail()
  → Log to email_messages (direction: outbound)
  → deductCredits("send_email")
```

### Incoming Webhook
```
POST /email/incoming (from external email parser)
  → Validate payload
  → Create contact/lead if new
  → Match against email_automation_rules
  → Trigger auto-reply or template response
  → Log to email_messages (direction: inbound)
```

### Scheduled Emails
- Cron runs every minute
- Processes `scheduled_emails` where status=pending AND scheduledAt <= now
- Sends via nodemailer, updates status to sent/failed

---

## Webhook System

### Configuration
- Users create webhooks at `/webhooks`
- Each webhook: URL, events (JSON array), secret (optional), sessionId (optional)
- Events: `message.received`, `message.sent`, `session.connected`, `session.disconnected`, etc.

### Delivery
```
triggerWebhook(userId, eventType, payload)
  → Filter active webhooks for user
  → Filter by sessionId if webhook has one
  → Check event match (or "all"/"*")
  → Build HMAC-SHA256 signature if secret exists
  → POST to URL with headers:
      X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp, X-Webhook-Signature
  → Log to webhook_logs (status, response, error)
```

### Test Endpoint
- `POST /webhooks/test/:id` — sends ping payload to verify delivery

---

## API Reference

### Authentication
All API endpoints require `Authorization: Bearer <apiKey>` header.

### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/messages/send` | API Key | Send WhatsApp message |
| GET | `/api/sessions` | API Key | List connected sessions |
| POST | `/api/webhook/:apiKey` | URL param | Receive webhook events |
| POST | `/api/lead-url/:slug` | X-API-Key header | Submit lead from external site |
| POST | `/api/v1/leads/push` | API Key | Create lead |
| POST | `/api/v1/leads/pull` | API Key | List/filter leads |

### Rate Limits
- General: 2000 requests per 15 minutes per IP
- Developer API: 30-second gap enforced per user between sends

### Response Format
```json
{
  "success": true|false,
  "message": "...",
  "data": { ... },
  "code": 200|201|400|401|403|500
}
```

---

## Cron Jobs

| Schedule | Job | Description |
|----------|-----|-------------|
| Every 1 min | Scheduled Messages | Send pending scheduled WhatsApp campaigns |
| Every 1 min | Scheduled Emails | Send pending scheduled emails |
| Every 10 min | YouTube Comments | Poll & auto-reply to YouTube comments |
| Every 10 min | Instagram Comments | Poll & auto-reply to Instagram comments |

All cron jobs use `setImmediate()` to prevent event loop blocking.

---

## Environment Variables

```env
# Required
DATABASE_URL=postgresql://user:pass@localhost:5432/whatscrm
SESSION_SECRET=your-strong-secret-here
PORT=3000

# Payments
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...

# Email (system notifications)
SMTP_USER=notifications@parrobyte.com
SMTP_PASS=...

# Social Media
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://yourdomain.com/youtube/callback
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
FACEBOOK_WEBHOOK_VERIFY_TOKEN=...
INSTAGRAM_REDIRECT_URI=https://yourdomain.com/instagram/callback

# Puppeteer (optional - auto-detected)
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# App
APP_URL=https://yourdomain.com
```

---

## Code Conventions

- **ES Modules**: All files use `import/export`
- **Async/Await**: Preferred over callbacks
- **Error Handling**: Try/catch with console.error + user-friendly flash messages
- **Database**: Drizzle ORM with explicit `eq()`, `and()`, `desc()` operators
- **Security**: Helmet CSP, rate limiting, input validation, parameterized queries
- **File Naming**: kebab-case for routes, camelCase for variables, PascalCase for classes
