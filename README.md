# WhatsApp CRM

A full-featured WhatsApp CRM built with Express.js + EJS + PostgreSQL + WhatsApp Web.js.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js (ES Modules) |
| Frontend | EJS templates + HTML |
| CSS | Tailwind CSS + DaisyUI (CDN) |
| Database | PostgreSQL |
| ORM | Drizzle ORM |
| WhatsApp | whatsapp-web.js + Puppeteer |
| Auth | bcryptjs + express-session |

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- **Google Chrome or Chromium** (required for WhatsApp Web.js)

## Setup

### 1. Create PostgreSQL Database

```bash
psql -U postgres
CREATE DATABASE whatsapp_crm;
\q
```

### 2. Configure Environment

Edit `.env`:

```env
DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/whatsapp_crm
SESSION_SECRET=your-secret-key-here
PORT=3000
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Push Database Schema

```bash
npx drizzle-kit push
```

### 5. Seed Admin User

```bash
node db/seed.js
```

### 6. Start Server

```bash
node server.js
```

Server runs at `http://localhost:3000`

## Default Login

- **Email:** admin@whatsappcrm.com
- **Password:** admin123

---

## CRITICAL: Chrome/Chromium Setup

WhatsApp Web.js requires **Google Chrome** or **Chromium** to be installed on your system. This is the #1 cause of session creation failing.

### Check if Chrome is installed

```bash
# Linux
which google-chrome || which chromium-browser || which chromium

# macOS
ls /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome

# Windows (in CMD)
where chrome
```

### Install Chrome if missing

**Ubuntu/Debian:**
```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
sudo apt-get update
sudo apt-get install -y google-chrome-stable
```

**CentOS/RHEL/Fedora:**
```bash
sudo dnf install -y chromium
```

**macOS:**
```bash
brew install --cask google-chrome
```

### Configure Puppeteer to use system Chrome

If Chrome is installed but puppeteer can't find it, create/edit `.env`:

```env
# Find your Chrome path with: which google-chrome
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

Then edit `whatsapp/manager.js` line ~36 and add `executablePath`:

```javascript
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authPath }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // ADD THIS
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
    timeout: 60000,
  },
});
```

### Alternative: Use Chromium bundled with Puppeteer

Puppeteer downloads Chromium automatically on install. If it didn't:

```bash
# Reinstall puppeteer to trigger Chromium download
rm -rf node_modules/puppeteer
npm install puppeteer

# Or force Chromium download
npx puppeteer browsers install chrome
```

---

## Troubleshooting WhatsApp Sessions

### Problem: "Failed to create session" error

**Check server logs** - look for `[clientId] Client initialization FAILED:` message.

Common causes:

| Error | Fix |
|-------|-----|
| `Could not find Chrome` | Install Chrome (see above) |
| `Failed to launch browser` | Add `PUPPETEER_EXECUTABLE_PATH` to `.env` |
| `Permission denied` | Run with `--no-sandbox` flag (already set) |
| `Navigation timeout` | Check internet connection; WhatsApp needs to load web.whatsapp.com |

### Problem: Session stuck on "connecting" status

1. Check if `.wwebjs_auth/` directory was created:
   ```bash
   ls -la .wwebjs_auth/
   ```

2. If empty or missing, create it manually:
   ```bash
   mkdir -p .wwebjs_auth
   ```

3. Restart the server and try again.

### Problem: QR code not appearing

1. Wait up to 30 seconds - QR generation takes time on first launch
2. Check browser console for errors
3. Make sure your server has internet access to reach `web.whatsapp.com`
4. Check that `qrcode` npm package is installed:
   ```bash
   ls node_modules/qrcode
   ```

### Problem: "Rate limit exceeded" when sending messages

This is intentional protection. WhatsApp limits:
- **30 messages per minute** per account
- Wait 1 minute for the rate limit to reset

### Debug mode

To see detailed WhatsApp logs, start with debug flag:

```bash
DEBUG=* node server.js
```

---

## Project Structure

```
app/
├── server.js              # Express app entry
├── server/
│   ├── lib/
│   │   └── db.js          # PostgreSQL connection
│   └── routes/            # All Express routes
├── views/                 # EJS templates
│   ├── layout.ejs         # Main layout
│   ├── partials/          # Sidebar, header, footer
│   └── pages/             # All page templates
├── db/
│   ├── schema.js          # Drizzle ORM schema
│   └── seed.js            # Admin seed data
├── whatsapp/
│   └── manager.js         # WhatsApp Web.js manager
├── public/                # Static files & uploads
├── .env                   # Environment config
└── package.json           # Dependencies
```

## Features

- **Multi-session WhatsApp** - Connect multiple WhatsApp accounts via QR code
- **Contact Management** - Add/edit/delete contacts, bulk CSV upload
- **Message Templates** - Text, image, document, video templates
- **Bulk Messaging** - Rate-limited bulk sending (30/min)
- **Scheduled Messages** - Schedule campaigns with cron
- **Auto Reply** - Keyword triggers with static or AI responses
- **Developer API** - REST API with key authentication
- **Webhooks** - Event notifications
- **Admin Panel** - Full user and session management
- **Security** - Helmet, rate limiting, bcrypt, input validation
