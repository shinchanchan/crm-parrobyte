# ParroByte CRM — Deployment Guide

## Table of Contents
1. [System Requirements](#system-requirements)
2. [Dependencies](#dependencies)
3. [Installation Steps](#installation-steps)
4. [Database Setup](#database-setup)
5. [Environment Configuration](#environment-configuration)
6. [Chrome/Chromium Setup](#chromechromium-setup)
7. [Ollama AI Setup (Optional)](#ollama-ai-setup-optional)
8. [Production Deployment](#production-deployment)
9. [PM2 Process Management](#pm2-process-management)
10. [Nginx Reverse Proxy](#nginx-reverse-proxy)
11. [SSL/TLS with Let's Encrypt](#ssltls-with-lets-encrypt)
12. [Firewall Configuration](#firewall-configuration)
13. [Backup Strategy](#backup-strategy)
14. [Monitoring & Logs](#monitoring--logs)
15. [Troubleshooting](#troubleshooting)

---

## System Requirements

### Minimum (Development / Small Team)
| Resource | Specification |
|----------|---------------|
| CPU | 2 cores |
| RAM | 4 GB |
| Disk | 20 GB SSD |
| OS | Ubuntu 22.04 LTS / Debian 12 |
| Network | Stable internet (WhatsApp Web requires it) |

### Recommended (Production / Multiple Users)
| Resource | Specification |
|----------|---------------|
| CPU | 4+ cores |
| RAM | 8 GB+ |
| Disk | 50 GB SSD |
| OS | Ubuntu 22.04 LTS |
| Network | Dedicated IP, high bandwidth |

### Critical Notes
- **RAM**: Each WhatsApp session uses ~150-300MB RAM via Puppeteer. Plan for 500MB per session.
- **Disk**: Puppeteer cache + media uploads grow quickly. Monitor disk usage.
- **CPU**: AI responses via Ollama are CPU-intensive. Use GPU if available.

---

## Dependencies

### System Packages
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v  # v20.x.x
npm -v   # 10.x.x

# Install PostgreSQL 14+
sudo apt install -y postgresql postgresql-contrib

# Install Google Chrome (required for WhatsApp Web.js)
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
sudo apt update
sudo apt install -y google-chrome-stable

# Install ffmpeg (audio conversion)
sudo apt install -y ffmpeg

# Install build tools (for native modules)
sudo apt install -y build-essential python3-pip

# Install Ollama (optional, for AI features)
curl -fsSL https://ollama.com/install.sh | sh
```

### Node.js Dependencies (Auto-installed via npm)
See `package.json` for full list. Key packages:
- `express` — Web framework
- `drizzle-orm` + `pg` — Database ORM and driver
- `whatsapp-web.js` + `puppeteer` — WhatsApp automation
- `ollama` — Local AI integration
- `nodemailer` — Email sending
- `razorpay` — Payment gateway
- `helmet` + `express-rate-limit` — Security

---

## Installation Steps

```bash
# 1. Clone or upload project
cd /var/www
git clone <your-repo> parrobyte-crm
cd parrobyte-crm

# 2. Install dependencies
npm install

# 3. Create .env file
cp .env.example .env
nano .env

# 4. Push database schema
npx drizzle-kit push

# 5. Seed admin user
node db/seed.js

# 6. Start server (dev mode)
npm run dev

# 7. Production start
npm start
```

---

## Database Setup

### Create Database
```bash
sudo -u postgres psql

CREATE DATABASE whatscrm;
CREATE USER parrobyte WITH ENCRYPTED PASSWORD 'your-strong-password';
GRANT ALL PRIVILEGES ON DATABASE whatscrm TO parrobyte;
\q
```

### Connection String
```env
DATABASE_URL=postgresql://parrobyte:your-strong-password@localhost:5432/whatscrm
```

### Backup Database
```bash
# Manual backup
pg_dump -U parrobyte whatscrm > backup_$(date +%Y%m%d).sql

# Automated daily backup (cron)
0 2 * * * pg_dump -U parrobyte whatscrm | gzip > /var/backups/parrobyte/db_$(date +\%Y\%m\%d).sql.gz
```

### Restore Database
```bash
gunzip < backup_20240115.sql.gz | psql -U parrobyte whatscrm
```

---

## Environment Configuration

```env
# Server
PORT=3000
APP_URL=https://crm.parrobyte.com
NODE_ENV=production

# Database
DATABASE_URL=postgresql://parrobyte:pass@localhost:5432/whatscrm

# Security
SESSION_SECRET=generate-a-64-char-random-string-here-abcdef123456

# Payments (Razorpay)
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx

# Email (System notifications)
SMTP_USER=noreply@parrobyte.com
SMTP_PASS=your-smtp-password

# Social Media
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_REDIRECT_URI=https://crm.parrobyte.com/youtube/callback

FACEBOOK_APP_ID=xxx
FACEBOOK_APP_SECRET=xxx
FACEBOOK_WEBHOOK_VERIFY_TOKEN=random-verify-token-123

INSTAGRAM_REDIRECT_URI=https://crm.parrobyte.com/instagram/callback

# Puppeteer
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

---

## Chrome/Chromium Setup

### Verify Installation
```bash
which google-chrome-stable
# Output: /usr/bin/google-chrome-stable

google-chrome-stable --version
# Output: Google Chrome 120.x.x
```

### If Chrome Not Found
```bash
# Option 1: Install Chromium
sudo apt install -y chromium-browser

# Option 2: Use Puppeteer's bundled Chromium
npx puppeteer browsers install chrome

# Set path in .env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### Permission Issues
```bash
# Ensure Chrome can run headless
sudo chmod +x /usr/bin/google-chrome-stable

# If running as non-root user, sandbox flags are already set in code
```

---

## Ollama AI Setup (Optional)

### Install Ollama
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### Pull a Model
```bash
# Small, fast model for testing
ollama pull translategemma:4b

# Better quality model
ollama pull llama3.2:3b

# List models
ollama list
```

### Start Ollama Service
```bash
# Systemd service (auto-created by installer)
sudo systemctl enable ollama
sudo systemctl start ollama

# Verify
curl http://localhost:11434/api/tags
```

### Configure in App
1. Admin goes to **AI Config**
2. Set Ollama URL: `http://localhost:11434`
3. Set Model: `translategemma:4b`
4. Click **Test** to verify

---

## Production Deployment

### 1. Create System User
```bash
sudo useradd -r -s /bin/false parrobyte
sudo usermod -aG parrobyte parrobyte
sudo chown -R parrobyte:parrobyte /var/www/parrobyte-crm
```

### 2. Set Permissions
```bash
sudo chmod 750 /var/www/parrobyte-crm
sudo chmod 640 /var/www/parrobyte-crm/.env
```

### 3. Environment Variables for Production
```bash
# In .env
NODE_ENV=production
PORT=3000
```

---

## PM2 Process Management

### Install PM2
```bash
sudo npm install -g pm2
```

### Create Ecosystem File
```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'parrobyte-crm',
    script: './server.js',
    instances: 1,           // Must be 1 (WhatsApp sessions are single-process)
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '2G',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 30000,    // Allow graceful WhatsApp shutdown
    wait_ready: true,
    listen_timeout: 10000,
    // Auto-restart on failure
    autorestart: true,
    // Don't restart if crashing too fast
    exp_backoff_restart_delay: 100,
  }]
};
```

### PM2 Commands
```bash
# Start
pm2 start ecosystem.config.cjs

# Save config (auto-start on boot)
pm2 save
pm2 startup systemd

# Monitor
pm2 logs parrobyte-crm
pm2 monit

# Restart
pm2 restart parrobyte-crm

# Graceful reload (zero-downtime not possible due to Puppeteer)
pm2 restart parrobyte-crm
```

### Log Rotation
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
```

---

## Nginx Reverse Proxy

### Install Nginx
```bash
sudo apt install -y nginx
```

### Configuration
```nginx
# /etc/nginx/sites-available/parrobyte-crm
server {
    listen 80;
    server_name crm.parrobyte.com;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Rate limiting zone (optional)
    limit_req_zone $binary_remote_addr zone=api:10m rate=50r/s;

    # Client max body size for uploads
    client_max_body_size 100M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }

    # Static files (optional optimization)
    location /uploads/ {
        alias /var/www/parrobyte-crm/public/uploads/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
```

### Enable Site
```bash
sudo ln -s /etc/nginx/sites-available/parrobyte-crm /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## SSL/TLS with Let's Encrypt

### Install Certbot
```bash
sudo apt install -y certbot python3-certbot-nginx
```

### Obtain Certificate
```bash
sudo certbot --nginx -d crm.parrobyte.com
```

### Auto-Renewal
```bash
# Test auto-renewal
sudo certbot renew --dry-run

# Cron is auto-configured, but verify:
sudo systemctl status certbot.timer
```

---

## Firewall Configuration

```bash
# UFW (Uncomplicated Firewall)
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH, HTTP, HTTPS
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Optional: Restrict port 3000 (app should only be accessible via Nginx)
# sudo ufw deny 3000/tcp

sudo ufw enable
sudo ufw status
```

---

## Backup Strategy

### What to Backup
1. **Database**: Daily `pg_dump`
2. **Uploads**: `/public/uploads/` (media, documents)
3. **Auth Data**: `.wwebjs_auth/` (WhatsApp session data)
4. **Environment**: `.env` file
5. **Code**: Git repository

### Backup Script
```bash
#!/bin/bash
# /opt/backup/parrobyte-backup.sh

BACKUP_DIR="/var/backups/parrobyte"
DATE=$(date +%Y%m%d_%H%M%S)
DB_NAME="whatscrm"
DB_USER="parrobyte"

mkdir -p $BACKUP_DIR

# Database
pg_dump -U $DB_USER $DB_NAME | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# Uploads
tar czf $BACKUP_DIR/uploads_$DATE.tar.gz -C /var/www/parrobyte-crm/public uploads

# Auth data
tar czf $BACKUP_DIR/auth_$DATE.tar.gz -C /var/www/parrobyte-crm .wwebjs_auth

# Keep only last 7 days
find $BACKUP_DIR -type f -mtime +7 -delete

# Sync to S3 (optional)
# aws s3 sync $BACKUP_DIR s3://parrobyte-backups/
```

### Cron Schedule
```bash
0 2 * * * /opt/backup/parrobyte-backup.sh >> /var/log/parrobyte-backup.log 2>&1
```

---

## Monitoring & Logs

### Application Logs
```bash
# PM2 logs
pm2 logs parrobyte-crm

# Tail specific log
tail -f /var/www/parrobyte-crm/logs/error.log
```

### System Monitoring
```bash
# Install htop for visual monitoring
sudo apt install -y htop

# Disk usage
df -h

# Memory usage
free -h

# WhatsApp auth directory size
du -sh /var/www/parrobyte-crm/.wwebjs_auth
```

### Health Check Endpoint
```bash
# Basic health check
curl -f http://localhost:3000/ || echo "Server down"
```

---

## Troubleshooting

### Server Won't Start
```bash
# Check Node version
node -v  # Must be 18+

# Check if port is in use
sudo lsof -i :3000

# Check .env is complete
cat .env | grep -v '^#' | grep -v '^$'
```

### WhatsApp Sessions Not Connecting
```bash
# Check Chrome is installed
which google-chrome-stable

# Check auth directory permissions
ls -la .wwebjs_auth/

# Clear stale lock files
rm -f .wwebjs_auth/*_*/SingletonLock

# Check logs for specific error
pm2 logs | grep "WhatsApp"
```

### Database Connection Errors
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Check connection
psql $DATABASE_URL -c "SELECT 1"

# Check user permissions
sudo -u postgres psql -c "\du"
```

### High Memory Usage
```bash
# Check Puppeteer processes
ps aux | grep chrome | wc -l

# Restart if memory leak
pm2 restart parrobyte-crm

# Consider adding swap if RAM < 4GB
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### SSL Certificate Issues
```bash
# Renew manually
sudo certbot renew

# Check certificate expiry
sudo openssl x509 -in /etc/letsencrypt/live/crm.parrobyte.com/fullchain.pem -noout -dates
```
