# ParroByte CRM — Single-Process Architecture

## Overview

This architecture runs **everything in a single Node.js process** (web server + WhatsApp sessions + cron jobs + inline background tasks). No BullMQ, no Redis, no separate worker processes.

## Why Single-Process?

- **Simpler deployment** — one process to manage
- **No Redis dependency** — no queue system needed
- **Shared memory** — WhatsApp sessions are accessible to all features directly
- **Easier debugging** — all logs in one place

## Process Architecture (PM2)

| Process | Instances | RAM Limit | Purpose |
|---------|-----------|-----------|---------|
| `parrobyte-web` | 1 (fork) | 3GB | Express API + Web UI + WhatsApp sessions + Cron jobs |
| **Total** | **1** | **~3GB** | Remaining RAM for Chromium sessions |

## WhatsApp Session Limits (RAM-Based)

| Total RAM | Max Sessions | Per-Session RAM |
|-----------|-------------|-----------------|
| 8GB | ~15 | ~200MB |
| 14GB | ~25 | ~200MB |

Sessions are automatically limited based on free RAM. If RAM drops below 10%, new sessions are rejected.

## How Background Tasks Work

All long-running tasks are processed **inline** using `setImmediate()` so the HTTP response is never blocked:

### 1. Bulk Messaging (Inline)
- User submits bulk job → DB record created → HTTP response sent immediately
- `setImmediate()` loop sends messages one by one with configurable gaps (default 30s)
- Progress updated in DB every 5 messages

### 2. Scheduled Messages (Inline)
- Cron runs every minute → finds pending messages
- Sends directly using `waManager.sendMessage()`
- 3-second gap between each contact

### 3. Scraping (Inline)
- User submits scrape → DB record created → HTTP response sent immediately
- `setImmediate()` launches Puppeteer and processes results
- Status updated in DB as it progresses

### 4. Incoming Messages (Inline)
- WhatsApp `message_create` event fires
- `setImmediate()` processes auto-replies and webhooks
- Non-blocking — next message can be received immediately

## Key Optimizations

### Puppeteer/Chromium (Low Memory)
```
--no-sandbox --disable-gpu --no-zygote
--disable-background-networking
--disable-background-timer-throttling
--js-flags=--max-old-space-size=256
--window-size=800,600
```
- Viewport reduced from 1280x720 → 800x600 (saves ~30MB per tab)
- JS heap limited to 256MB
- Background processes disabled

### Health Monitoring
- `/health` endpoint returns RAM, CPU, session counts
- PM2 auto-restarts process if it exceeds RAM limit

## Start / Stop Commands

```bash
# Start
./start_production.sh

# Or manually with PM2
npx pm2 start ecosystem.config.cjs

# View status
npx pm2 status
npx pm2 logs
npx pm2 monit

# Reload (zero-downtime)
npx pm2 reload all

# Stop
npx pm2 stop all

# Auto-start on boot
npx pm2 startup
npx pm2 save
```

## Development Mode

```bash
node server.js
```

## Monitoring Dashboard

```bash
npx pm2 monit
```
Shows real-time CPU, RAM, and restart counts.
