# ParroByte CRM — Security & Performance Audit Report
**Date:** 2026-05-01  
**Auditor:** Code Review (Static Analysis)  
**Scope:** All routes, libraries, database queries, authentication, authorization, input validation

---

## Executive Summary

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 CRITICAL | 5 | Must fix immediately |
| 🟠 HIGH | 5 | Fix before production |
| 🟡 MEDIUM | 6 | Fix in next sprint |
| 🟢 LOW | 4 | Address when convenient |

**Overall Security Rating: D (Multiple critical vulnerabilities present)**  
**Overall Performance Rating: C (Blocking operations, missing indexes, memory leaks)**

---

## 🔴 CRITICAL VULNERABILITIES

### 1. IDOR — Any User Can Update/Delete ANY Lead (CVSS: 8.1)
**File:** `server/routes/leads.js`  
**Lines:** 140-168

```js
// BUG: No ownership check!
router.post("/update/:id", async (req, res) => {
  await db.update(schema.leads).set({...}).where(eq(schema.leads.id, id));
});
router.post("/delete/:id", async (req, res) => {
  await db.delete(schema.leads).where(eq(schema.leads.id, id));
});
```

**Impact:** Any logged-in user can modify or delete leads belonging to other users by guessing IDs.  
**Fix:** Add `eq(schema.leads.userId, req.session.user.id)` to WHERE clause.

---

### 2. IDOR — Any User Can Modify/Delete ANY Social Automation Rule (CVSS: 8.1)
**File:** `server/routes/socialAutomation.js`  
**Lines:** 62-99

```js
// BUG: No ownership check on update, delete, toggle!
router.post("/update/:id", async (req, res) => {
  await db.update(schema.socialAutomations).set({...}).where(eq(schema.socialAutomations.id, id));
});
```

**Impact:** Complete takeover of other users' social media automation rules.  
**Fix:** Add userId check to all update/delete/toggle queries.

---

### 3. Razorpay Webhook — Fake Payment = Free Credits (CVSS: 9.8)
**File:** `server/routes/payments.js`  
**Lines:** 197-233

```js
// BUG: No signature verification!
router.post("/webhook", async (req, res) => {
  const event = req.body;
  if (event.event === "payment.captured") {
    // Directly adds credits without verifying Razorpay signature
    await addCredits(userId, pkgCredits, ...);
  }
});
```

**Impact:** Attacker crafts a fake `payment.captured` JSON payload → unlimited free credits for any user.  
**Fix:** Verify Razorpay webhook signature using `crypto.createHmac('sha256', secret)`.

---

### 4. Email Incoming Webhook — Unauthenticated Email Injection (CVSS: 8.6)
**File:** `server/routes/email.js`  
**Lines:** 569-697

```js
// BUG: No auth! Anyone can POST to /email/incoming
router.post("/incoming", async (req, res) => {
  const { userId, from, subject, body } = req.body; // userId from body!
  // Creates contacts, leads, triggers auto-replies, sends emails FROM victim's SMTP
});
```

**Impact:**
- Spam any user's contact list with auto-replies
- Exhaust victim's SMTP quota
- Flood victim's CRM with fake leads
- Trigger webhooks to victim's endpoints

**Fix:** Require a shared secret or API key in headers.

---

### 5. Scheduled Emails Cron — Never Executes (Logic Bug)
**File:** `server/routes/email.js`  
**Line:** 765

```js
// BUG: eq() checks exact millisecond equality — almost never matches
const pending = await db.select().from(schema.scheduledEmails)
  .where(and(eq(schema.scheduledEmails.status, "pending"), eq(schema.scheduledEmails.scheduledAt, now)));
```

**Impact:** All scheduled emails sit in "pending" forever.  
**Fix:** Use `lte()` (less than or equal) instead of `eq()`.

---

## 🟠 HIGH VULNERABILITIES

### 6. Credit System Race Condition (TOCTOU) (CVSS: 6.5)
**File:** `server/lib/credits.js`  
**Lines:** 93-166

```js
// checkCredits() and deductCredits() are separate calls
const check = await checkCredits(userId, "send_email", 100);
// <-- ANOTHER REQUEST DEDUCTS HERE
await deductCredits(userId, "send_email", 100, ...); // Can go negative!
```

**Impact:** Under concurrent requests, balance can go negative.  
**Fix:** Combine check+deduct into a single atomic database transaction.

---

### 7. No Brute-Force Protection on Auth (CVSS: 7.5)
**File:** `server/routes/auth.js`

- Login: unlimited attempts, no CAPTCHA
- OTP: 6-digit numeric, unlimited attempts, 10-min expiry
- Password reset: same OTP reused for verification

**Impact:** OTP can be brute-forced in ~10 minutes with parallel requests.  
**Fix:** Add per-IP rate limiting (5 attempts/min) on auth routes.

---

### 8. Webhook SSRF — Internal Network Scanning (CVSS: 6.5)
**File:** `server/lib/webhookTrigger.js`  
**Line:** 99

```js
// No URL validation — can hit 127.0.0.1, 169.254.169.254 (AWS metadata), internal APIs
const response = await fetch(hook.url, ...);
```

**Impact:** Attacker configures webhook to `http://169.254.169.254/latest/meta-data/` and steals cloud credentials.  
**Fix:** Validate URL — block private IP ranges, localhost, metadata endpoints.

---

### 9. No Rate Limiting on Public Forms (CVSS: 5.3)
**Endpoints:**
- `POST /landing/submit`
- `POST /enterprise/submit`
- `POST /email/incoming`
- `POST /api/lead-url/:slug`

**Impact:** Spam/DDoS, database bloat, email flooding.  
**Fix:** Add per-IP rate limiting (10 requests/min).

---

### 10. Passwords Stored in Plaintext (Email SMTP) (CVSS: 6.5)
**File:** `db/schema.js` — `email_configs.emailPass`

**Impact:** Database breach exposes all users' email passwords.  
**Fix:** Encrypt with AES-256-GCM using a server-side master key.

---

## 🟡 MEDIUM VULNERABILITIES

### 11. Memory Leak in AI Queue Processor
**File:** `server/lib/aiQueueProcessor.js`

```js
const processingUsers = new Set(); // Never cleans up old userIds
const lastProcessedTime = new Map(); // Never cleans up old entries
```

**Impact:** Over months, memory grows unbounded with many users.  
**Fix:** Periodically clear entries older than 1 hour.

---

### 12. Admin Dashboard Loads ALL Data into Memory
**File:** `server/routes/admin.js` lines 11-32

```js
const contacts = await db.select().from(schema.contacts); // ALL contacts
const messages = await db.select().from(schema.messages); // ALL messages
```

**Impact:** With 10k users, admin page crashes the server (OOM).  
**Fix:** Use COUNT queries instead of `select().from()`.

---

### 13. File Upload Path Traversal Risk
**File:** `server/routes/templates.js`, `messages.js`

```js
const fileName = `${Date.now()}_${file.name}`; // file.name from user!
```

**Impact:** If `file.name` is `../../../etc/passwd`, may write outside upload dir.  
**Fix:** Sanitize filename — strip path components, allow only alphanum+ext.

---

### 14. Social Automation Account ID Not Validated
**File:** `server/routes/socialAutomation.js` lines 34-59

```js
// Creates automation for accountId without verifying it belongs to user
await db.insert(schema.socialAutomations).values({ accountId: parseInt(accountId), ... });
```

**Impact:** User can create rules for another user's social account.  
**Fix:** Verify `accountId` belongs to `req.session.user.id`.

---

### 15. API Keys Stored in Plaintext
**File:** `db/schema.js` — `api_keys.apiKey`

**Impact:** DB breach exposes all API keys.  
**Fix:** Hash API keys with SHA-256, only show full key once on creation.

---

### 16. Information Disclosure via Query Parameters
**File:** `server/routes/developer.js`

```js
const apiKey = req.query.apiKey || "wcrm_your_api_key_here";
```

**Impact:** API keys logged in server logs, browser history, referrer headers.  
**Fix:** Never accept API keys in query params; use headers only.

---

## 🟢 LOW ISSUES

| # | Issue | File |
|---|-------|------|
| 17 | `users.sessionToken` stored plaintext | `db/schema.js` |
| 18 | Error stack traces leaked to logs (may contain sensitive data) | Multiple |
| 19 | No Content-Type validation on file uploads | `templates.js`, `messages.js` |
| 20 | Bulk messaging blocks HTTP response instead of background processing | `messages.js` |

---

## Performance Issues

### Blocking Operations
| Operation | File | Impact |
|-----------|------|--------|
| Bulk message send (30s gaps) | `messages.js` | HTTP request hangs for minutes |
| Lead send-whatsapp (35s gaps) | `leads.js` | HTTP request hangs for minutes |
| Scraper browser launch | `scraper.js` | Background but no timeout on page.evaluate |

### Missing Database Indexes
```sql
-- These indexes are missing and will cause full table scans:
CREATE INDEX idx_messages_user_id ON messages(userId);
CREATE INDEX idx_contacts_user_id ON contacts(userId);
CREATE INDEX idx_leads_user_id ON leads(userId);
CREATE INDEX idx_credit_transactions_user_service ON creditTransactions(userId, serviceKey);
CREATE INDEX idx_scheduled_emails_status_time ON scheduledEmails(status, scheduledAt);
CREATE INDEX idx_ai_queue_status_user ON aiMessageQueue(status, userId);
```

### Resource Bottlenecks
- **RAM:** Each WhatsApp session = ~300MB. 10 sessions = 3GB RAM.
- **CPU:** Ollama AI spikes CPU to 100% per request.
- **Disk:** `.wwebjs_auth/` grows indefinitely; no cleanup of old session data.

---

## Remediation Priority

### Week 1 (Critical)
1. Fix IDOR in `leads.js` — add ownership checks
2. Fix IDOR in `socialAutomation.js` — add ownership checks
3. Add Razorpay webhook signature verification
4. Add authentication to `/email/incoming`
5. Fix scheduled emails `eq()` → `lte()`

### Week 2 (High)
6. Add auth route rate limiting (5/min per IP)
7. Add public endpoint rate limiting
8. Fix credit system race condition
9. Add webhook URL SSRF protection
10. Encrypt `email_configs.emailPass`

### Week 3 (Medium)
11. Fix AI queue processor memory leak
12. Fix admin dashboard COUNT queries
13. Sanitize file upload filenames
14. Add missing database indexes
15. Hash API keys in database
