<p align="center">
  <img src="public/favicon.svg" alt="ParroByte Logo" width="80" />
</p>

<h1 align="center">ParroByte — All-in-One Business Automation CRM</h1>

<p align="center">
  <strong>Automate Your Business Growth</strong><br/>
  WhatsApp CRM · YouTube Auto-Reply · Instagram Automation · AI Assistant · Lead Scraping · Bulk Messaging · Scheduling
</p>

<p align="center">
  <a href="https://parrobyte.co.in" target="_blank">🌐 Website</a> ·
  <a href="mailto:parrobyte@gmail.com">✉️ Support</a> ·
  <a href="tel:+916380463408">📞 +91 6380463408</a>
</p>

---

## 🚀 Overview

**ParroByte** is a powerful, self-hosted business automation platform that brings all your customer communication and lead generation tools into one dashboard. Whether you run a marketing agency, a sales team, or a local business, ParroByte helps you engage leads, automate replies, send bulk campaigns, and manage contacts across WhatsApp, YouTube, Instagram, Facebook, and more.

The platform is built with a **pay-as-you-go credit model** — start free with **50 credits on signup**, then choose monthly subscriptions or top-up credits based on your usage.

> No credit card required to get started.

---

## ✨ What You Get

### 📱 Core WhatsApp CRM

| Feature | Description |
|---------|-------------|
| **Multiple WhatsApp Sessions** | Connect and manage several WhatsApp Business accounts at once using QR-code scanning. Ideal for agencies managing client accounts. |
| **Bulk Messaging** | Send messages to thousands of contacts with smart rate limiting (30–50s gaps) to protect accounts and maximize deliverability. |
| **Message Templates** | Create reusable text, image, document, and video templates for fast, consistent messaging. |
| **Schedule Messages** | Plan campaigns for the perfect time with daily, weekly, or monthly repeat options. |
| **Auto Reply** | Build keyword-based auto-replies and AI-generated responses that work even when you are offline. |
| **Contact Management** | Import contacts via CSV, organize them with groups and tags, and manage everything from one place. |

### 📣 Social Media Automation

- **YouTube Auto-Reply** — Connect your channel and auto-reply to comments using exact match, contains, starts_with, ends_with, or regex keyword triggers.
- **Instagram Auto-Reply** — Connect your Instagram Business account to auto-reply to post comments 24/7 with deduplication to avoid double replies.
- **Facebook & Instagram DM Automation** — Set up keyword triggers and auto-responses for incoming direct messages.

### 🤖 AI & Smart Tools

- **AI Assistant (Ollama)** — Run your own local AI model via Ollama. Configure system prompts, business context, and temperature. Queue-based processing keeps resource usage low.
- **Business Scraper** — Scrape Google Maps for business leads including name, phone, address, website, and ratings. Export to CSV or import directly into contacts.
- **Enquiry Forms** — Build branded lead-capture forms and share them via public links or Meta ads. Every submission becomes a CRM lead.
- **Lead Management** — Track leads from forms, scraper, manual entry, and enquiries. Move them through the pipeline: **New → Contacted → Qualified → Converted**.
- **Analytics Dashboard** — Real-time stats on messages sent, contacts added, sessions connected, and credit usage with visual progress indicators.

### 🔌 Developer API & Webhooks

- Generate secure API keys for external integrations.
- Receive real-time webhooks for message events, session connects, session disconnects, and more.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js (ES Modules) |
| Frontend | EJS templates + HTML |
| CSS | Tailwind CSS + DaisyUI (CDN) |
| Database | PostgreSQL 14+ |
| ORM | Drizzle ORM |
| WhatsApp | whatsapp-web.js + Puppeteer |
| Queue | BullMQ + Redis |
| AI | Ollama (self-hosted) |
| Auth | bcryptjs + express-session |
| Payments | Razorpay |
| Process Manager | PM2 |

---

## 📋 Prerequisites

- **Node.js** 18+ (Node.js 20 recommended)
- **PostgreSQL** 14+
- **Redis** (for BullMQ queues)
- **Google Chrome** or **Chromium** (required by WhatsApp Web.js)
- **Git**

---

## ⚡ Quick Start

### 1. Create the Database

```bash
sudo -u postgres psql
CREATE DATABASE whatscrm;
CREATE USER parrobyte WITH ENCRYPTED PASSWORD 'your-strong-password';
GRANT ALL PRIVILEGES ON DATABASE whatscrm TO parrobyte;
\q
```

### 2. Clone & Install

```bash
cd /var/www
git clone <your-repo-url> parrobyte-crm
cd parrobyte-crm
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

Minimum required variables:

```env
PORT=3000
NODE_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://parrobyte:your-strong-password@localhost:5432/whatscrm
SESSION_SECRET=your-very-long-random-secret-key
REDIS_URL=redis://localhost:6379
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

### 4. Push Schema & Seed Admin

```bash
npx drizzle-kit push
node db/seed.js
```

### 5. Start Development Server

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

**Default Login**

- **Email:** `admin@whatsappcrm.com`
- **Password:** `admin123`

> ⚠️ Change the default password immediately after first login.

---

## 🔧 Chrome / Chromium Setup

WhatsApp Web.js needs a real browser. If sessions fail to start, Chrome is usually the cause.

### Install Chrome (Ubuntu/Debian)

```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
sudo apt update
sudo apt install -y google-chrome-stable
```

### Verify Path

```bash
which google-chrome-stable
# /usr/bin/google-chrome-stable
```

Add the path to `.env`:

```env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

If Chrome is not found, install Chromium or let Puppeteer download it:

```bash
npx puppeteer browsers install chrome
```

---

## 🤖 Optional: Ollama AI Setup

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull translategemma:4b

# Start service
sudo systemctl enable ollama
sudo systemctl start ollama
```

In the app, go to **AI Config** and set:

- **Ollama URL:** `http://localhost:11434`
- **Model:** `translategemma:4b`

---

## 🚀 Production Deployment

For a complete, step-by-step production guide see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

High-level overview:

1. **Provision a VPS** — Ubuntu 22.04 LTS, 4 CPU / 8 GB RAM / 50 GB SSD recommended.
2. **Install system dependencies** — Node.js 20, PostgreSQL, Redis, Chrome, ffmpeg.
3. **Deploy code** — Clone repo, install npm packages, configure `.env`.
4. **Run migrations & seed** — `npx drizzle-kit push && node db/seed.js`.
5. **Run with PM2** — `pm2 start ecosystem.config.cjs`.
6. **Set up Nginx reverse proxy** with SSL via Let’s Encrypt.
7. **Configure firewall** — Allow 22, 80, 443; restrict direct access to port 3000.
8. **Schedule backups** — Database, uploads, and `.wwebjs_auth/` session data.

### Useful Production Commands

```bash
# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd

# View logs
pm2 logs parrobyte-crm

# Restart after updates
pm2 restart parrobyte-crm

# Rotate logs
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
```

---

## 📁 Project Structure

```
parrobyte-crm/
├── server.js              # Express app entry
├── server/
│   ├── lib/               # Database, queues, helpers
│   └── routes/            # All Express routes
├── views/                 # EJS templates
│   ├── layout.ejs
│   ├── partials/
│   └── pages/
├── db/
│   ├── schema.js          # Drizzle ORM schema
│   ├── migrations/
│   └── seed.js            # Admin seed data
├── whatsapp/
│   └── manager.js         # WhatsApp Web.js manager
├── workers/               # Background workers (message, scraper, heartbeat, AI)
├── public/                # Static files & uploads
├── docs/
│   └── DEPLOYMENT.md      # Full deployment guide
├── ecosystem.config.cjs   # PM2 configuration
├── .env                   # Environment config
└── package.json
```

---

## 🔐 API Keys & Webhooks

Generate API keys from the **Developer API** section in the admin panel. Webhooks can be configured to notify external systems about:

- Message sent / delivered / failed
- WhatsApp session connected / disconnected
- New lead created
- Credit usage events

---

## 💳 Credits & Pricing

- **50 free credits** on signup — no credit card required.
- **Pay-as-you-go:** Purchase credits when you need them.
- **Monthly subscriptions:** Best for teams with regular usage.

Each action (message sent, scraper result, AI response, etc.) consumes a defined number of credits.

---

## ❓ Troubleshooting

| Problem | Fix |
|---------|-----|
| "Could not find Chrome" | Install Chrome and set `PUPPETEER_EXECUTABLE_PATH` in `.env` |
| Session stuck on "connecting" | Ensure `.wwebjs_auth/` exists and is writable; check internet access |
| QR code not appearing | Wait up to 30 seconds; verify `web.whatsapp.com` is reachable |
| Rate limit exceeded | Built-in protection; wait a minute or increase message gaps |
| High memory usage | Each WhatsApp session uses ~300 MB RAM; restart PM2 or add RAM |

For detailed troubleshooting see [`docs/DEPLOYMENT.md#troubleshooting`](docs/DEPLOYMENT.md#troubleshooting).

---

## 🙋 Support

Need help with setup, customization, or deployment?

- **Website:** [https://parrobyte.co.in](https://parrobyte.co.in)
- **Email:** [parrobyte@gmail.com](mailto:parrobyte@gmail.com)
- **Phone:** [+91 6380463408](tel:+916380463408)

---

## 👨‍💻 Built By

**ParroByte Team** — Automating business growth across messaging and social platforms.

<p align="center">
  <img src="public/favicon.svg" alt="ParroByte Logo" width="50" />
</p>

---

## 📄 License

This project is proprietary software developed by ParroByte. Contact us for licensing, white-label, or custom development inquiries.
