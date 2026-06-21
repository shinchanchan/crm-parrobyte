# ParroByte CRM — Security & Performance Guide

## Table of Contents
1. [Security Measures Implemented](#security-measures-implemented)
2. [Load & Performance Characteristics](#load--performance-characteristics)
3. [WhatsApp Anti-Ban Strategy](#whatsapp-anti-ban-strategy)
4. [Load Testing Recommendations](#load-testing-recommendations)
5. [Security Testing Checklist](#security-testing-checklist)
6. [Performance Optimization Tips](#performance-optimization-tips)
7. [Incident Response](#incident-response)

---

## Security Measures Implemented

### 1. Authentication & Session Security
| Measure | Implementation |
|---------|---------------|
| Password Hashing | `bcryptjs` with salt rounds 10 |
| Session Storage | Server-side `express-session` with secure cookies |
| Cookie Security | `httpOnly`, `sameSite: "lax"`, `secure` in production |
| Session Expiry | 24 hours |
| Single Login | UUID session token enforced per request; new login invalidates old |
| OTP Verification | Optional 6-digit email OTP with 10-minute expiry |

### 2. API Security
| Measure | Implementation |
|---------|---------------|
| API Key Auth | Bearer token in Authorization header |
| Key Storage | Hashed/unique keys in database |
| Key Revocation | `isActive` flag for instant disable |
| Last Used Tracking | Timestamp updated on every API call |
| Rate Limiting | 30-second gap per user for message sends |
| IP Rate Limiting | 2000 requests per 15 minutes per IP (express-rate-limit) |

### 3. Webhook Security
| Measure | Implementation |
|---------|---------------|
| HMAC Signature | SHA-256 HMAC using configured secret |
| Headers | `X-Webhook-Signature`, `X-Webhook-Timestamp`, `X-Webhook-Id` |
| Timestamp | Included to prevent replay attacks |
| Delivery Logging | All attempts logged with response status & body |
| Session Filtering | Webhooks can be scoped to specific WhatsApp sessions |

### 4. Input Validation & Injection Prevention
| Measure | Implementation |
|---------|---------------|
| SQL Injection | Drizzle ORM parameterized queries (no raw SQL) |
| XSS Prevention | Helmet CSP + EJS auto-escaping |
| CSRF Protection | Same-site cookies + session validation |
| File Upload | Size limit (100MB), type validation, stored outside web root |
| Input Sanitization | express-validator on auth routes; length limits on all text fields |

### 5. HTTP Security Headers (Helmet)
```javascript
Content-Security-Policy: Restrictive CSP allowing only trusted CDN domains
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin-allow-popups
X-Frame-Options: DENY (via Helmet defaults)
X-Content-Type-Options: nosniff
Permissions-Policy: Restricted sensor/payment access
```

### 6. Process-Level Protection
```javascript
// Uncaught exceptions don't crash the server
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught Exception:", err.message);
  // DO NOT exit
});

// Puppeteer navigation errors are caught gracefully
process.on("unhandledRejection", (reason, promise) => {
  // Non-fatal errors logged, server continues
});
```

### 7. Credit System Security
| Measure | Implementation |
|---------|---------------|
| Atomic Deductions | Single DB transaction: check → deduct → log |
| Race Condition Prevention | No optimistic locking; relies on DB atomicity |
| Negative Balance Prevention | Check before every deduction |
| Free Quota Abuse | Calendar month reset; transaction count checked |

---

## Load & Performance Characteristics

### Benchmarks (Single Server, 4 Core / 8GB RAM)

| Metric | Value |
|--------|-------|
| Concurrent Web Users | 100+ (stateless requests) |
| WhatsApp Sessions | 5-10 concurrent (RAM-limited) |
| Messages/Minute (Bulk) | 40 (with 45s gaps) |
| Messages/Minute (Direct) | 30 per session |
| AI Responses/Hour | ~120 per user (30s gap) |
| Scheduled Campaigns | Unlimited (processed sequentially) |
| API Requests/Second | ~50 (with rate limiting) |
| Email Sends/Minute | 20 (with 3s gaps) |

### Resource Usage Per Component

| Component | RAM | CPU | Notes |
|-----------|-----|-----|-------|
| Node.js App | ~200MB | Low | Base application |
| Per WhatsApp Session | ~300MB | Medium | Puppeteer + Chrome |
| Ollama AI | ~1-2GB | High | When processing AI requests |
| PostgreSQL | ~100MB | Low | Scales with connection pool |
| Nginx | ~20MB | Low | Reverse proxy overhead |

### Bottlenecks
1. **RAM** — WhatsApp sessions via Puppeteer are the primary RAM consumer
2. **CPU** — Ollama AI inference spikes CPU to 100% per request
3. **Disk I/O** — Media uploads and Puppeteer cache can saturate disk
4. **Network** — WhatsApp Web requires stable internet; disconnections break sessions

---

## WhatsApp Anti-Ban Strategy

### Understanding WhatsApp's Detection
WhatsApp uses multiple signals to detect automation:
- Message sending velocity (too fast = spam)
- Identical messages to many users
- Browser fingerprinting (Puppeteer detection)
- Unusual login patterns
- Reported/blocked by recipients

### Implemented Protections

#### 1. Rate Limiting (Hard Enforced)
```javascript
// 30 messages per minute per user
const windowMs = 60 * 1000;
const maxRequests = 30;
```
- **Impact**: Prevents velocity-based detection
- **User Experience**: Clear error message: "Rate limit exceeded. Please wait."

#### 2. Message Gaps (Configurable)
| Feature | Default Gap | User Configurable |
|---------|-------------|-------------------|
| Bulk Messaging | 45 seconds | Yes (min: 10s) |
| Scheduled Campaigns | 30 seconds | No (hardcoded) |
| AI Auto-Reply | 30 seconds | No (hardcoded) |
| Developer API | 30 seconds | No (hardcoded) |

#### 3. Human-like Browser Fingerprint
```javascript
args: [
  "--disable-blink-features=AutomationControlled",  // Hide automation flag
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--mute-audio",
]
```

#### 4. Message Personalization
- Templates support variables: `{{name}}`, `{{phone}}`, `{{custom}}`
- Encourages unique messages per recipient

#### 5. Media Size Limits
- 10MB max file size prevents resource abuse
- FFmpeg converts audio to MP3 for compatibility

#### 6. @lid Contact Handling
- LID (Line Identity) contacts are handled via `msg.reply()` instead of `sendMessage()`
- Prevents "No LID" errors that trigger account scrutiny

#### 7. Auto-Reconnect with Backoff
- Transient disconnections retry up to 5 times
- 5s → 10s delay between retries
- Prevents rapid reconnection loops that look suspicious

#### 8. Graceful Shutdown
- On SIGINT/SIGTERM: destroys WhatsApp clients cleanly
- Preserves LocalAuth data for seamless restart
- Prevents corrupted auth states

### User Responsibilities (Documented in Terms)
- Only message users who have opted in or initiated contact
- Use personalization in bulk campaigns
- Set appropriate gaps (never below 10 seconds)
- Monitor for recipient blocks and adjust strategy
- Comply with WhatsApp Terms of Service

### What CANNOT Be Prevented
- **Recipient Reports**: If users report your messages as spam, WhatsApp may ban the number
- **Number Quality**: New or recently registered numbers are more likely to be flagged
- **Content Flags**: Sending prohibited content (scams, malware, hate speech) will result in bans

---

## Load Testing Recommendations

### Test Scenarios

#### Scenario 1: Concurrent Web Users
```bash
# Tool: Apache Bench (ab) or Artillery
# Test: 100 concurrent users browsing dashboard

ab -n 1000 -c 100 -C "connect.sid=YOUR_SESSION_COOKIE" \
  http://localhost:3000/dashboard

# Expected: 200 OK, avg response < 500ms, no errors
```

#### Scenario 2: API Message Sending
```bash
# Test: 50 API requests with valid key
# Note: 30-second gap means this will take ~25 minutes

for i in {1..50}; do
curl -X POST http://localhost:3000/api/messages/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"919876543210","message":"Test '$i'"}' &
sleep 31  # Respect rate limit
done

# Expected: All 50 succeed, 429 if gap < 30s
```

#### Scenario 3: Bulk Campaign Stress
```bash
# Create a CSV with 100 contacts
# Upload and start bulk campaign with 10s gap
# Monitor server resources during execution

# Check RAM usage every 10 seconds
watch -n 10 'free -h && ps aux | grep chrome | wc -l'
```

#### Scenario 4: Multiple WhatsApp Sessions
```bash
# Connect 5-10 WhatsApp sessions simultaneously
# Send messages from each session concurrently
# Monitor for "Target closed" or "Navigation failed" errors
```

#### Scenario 5: AI Queue Processing
```bash
# Trigger 20 incoming messages to a user with Universal AI enabled
# Verify queue processes with 30s gaps
# Check Ollama response times and server CPU
```

### Tools
| Tool | Purpose |
|------|---------|
| `ab` (Apache Bench) | Simple HTTP load testing |
| `artillery` | Advanced scenario testing |
| `htop` | Real-time resource monitoring |
| `pm2 monit` | Application monitoring |
| `pg_stat_statements` | PostgreSQL query performance |

### Expected Results (Production Hardware)
| Scenario | Concurrent | Duration | Success Rate | Avg Response |
|----------|-----------|----------|--------------|--------------|
| Web browsing | 100 | 5 min | >99% | <300ms |
| API sends | 1/min | 1 hour | 100% | <2s |
| Bulk campaign | 1 campaign | varies | >95% | N/A |
| 5 WA sessions | 5 | ongoing | >90% | N/A |

---

## Security Testing Checklist

### Authentication
- [ ] Password brute force: Attempt 100 logins with wrong password → account NOT locked (currently no lockout)
- [ ] Session hijacking: Copy session cookie to another browser → works until single-login enforcement kicks in
- [ ] XSS in login form: `<script>alert(1)</script>` in email field → escaped by EJS
- [ ] SQL injection in login: `' OR 1=1 --` → blocked by Drizzle parameterized queries

### Authorization
- [ ] Access admin pages as regular user → 403 redirect
- [ ] Access another user's contacts via URL manipulation → only own data shown
- [ ] Access API with revoked key → 401 error
- [ ] Session expiry after 24 hours → redirect to login

### File Upload
- [ ] Upload executable (.exe) → allowed (no type restriction, but stored safely)
- [ ] Upload 150MB file → rejected with "File size limit exceeded"
- [ ] Upload with path traversal (`../../etc/passwd`) → sanitized by express-fileupload

### API Security
- [ ] Missing Authorization header → 401
- [ ] Invalid API key → 401
- [ ] Send 100 messages in 1 minute → rate limited after 30
- [ ] Access /api/messages/send without sessionId → auto-selects connected session

### Webhook Security
- [ ] Missing signature verification → payload accepted (signature is optional)
- [ ] Invalid signature → no validation performed if no secret configured
- [ ] Replay attack → no timestamp validation implemented

### Known Security Gaps
| Gap | Risk Level | Mitigation |
|-----|-----------|------------|
| No account lockout after failed logins | Low | Rate limiting at IP level (2000/15min) |
| No 2FA (only optional email OTP) | Medium | Recommend enabling OTP |
| Webhook replay attacks possible | Low | Add timestamp validation (TODO) |
| No request signing on internal APIs | Low | Internal routes protected by session |
| File upload type not restricted | Low | Files served as static, not executed |

---

## Performance Optimization Tips

### Database
```sql
-- Add indexes for common queries (if not already present)
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_leads_user_id ON leads(user_id);
CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_scheduled_messages_status_time ON scheduled_messages(status, schedule_time);
CREATE INDEX idx_ai_queue_status_user ON ai_message_queue(status, user_id);
```

### Application
1. **Enable Gzip Compression**
```javascript
import compression from 'compression';
app.use(compression());
```

2. **Connection Pooling**
```javascript
// Already using postgres.js which pools automatically
// Increase pool size for high load:
const pool = new Pool({ max: 20 });
```

3. **Static File Caching**
```nginx
# In Nginx config
location /uploads/ {
    expires 7d;
    add_header Cache-Control "public, immutable";
}
```

4. **Redis for Sessions** (Future improvement)
```javascript
// Replace file-store with Redis for multi-server deployments
import RedisStore from 'connect-redis';
```

### WhatsApp Sessions
1. **Limit Concurrent Sessions**: Max 5-10 per server (RAM-dependent)
2. **Stagger Restarts**: Already implemented (5s delay between session restores)
3. **Monitor Chrome Processes**: Kill zombie processes periodically

### AI/Ollama
1. **Use Smaller Models**: `translategemma:4b` instead of 7B+ for faster responses
2. **GPU Acceleration**: If available, configure Ollama for CUDA
```bash
# Check GPU support
ollama run llama3.2:3b
# In another terminal: nvidia-smi
```

---

## Incident Response

### WhatsApp Session Disconnected
1. Check logs: `pm2 logs | grep "disconnected"`
2. If transient error → auto-reconnects in 10s
3. If auth failure → user must re-scan QR
4. If repeated → check internet connectivity

### High Memory Usage
1. Check Chrome processes: `ps aux | grep chrome | wc -l`
2. Expected: ~1 process per session
3. If zombie processes: `pkill -f chrome`
4. Restart app: `pm2 restart parrobyte-crm`

### Database Connection Pool Exhausted
1. Check active connections: `sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"`
2. Restart app to clear stale connections
3. Consider increasing PostgreSQL `max_connections`

### Credit System Discrepancy
1. Check transaction log for user
2. Verify `balanceAfter` chain is consistent
3. Manual adjustment via admin panel if needed

### Security Incident
1. Revoke affected API keys immediately
2. Force password reset for affected users
3. Check activity_logs for suspicious actions
4. Review webhook_logs for unauthorized deliveries
