import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";

puppeteer.use(StealthPlugin());

const router = express.Router();

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/[\u{0080}-\u{FFFF}]/gu, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^0-9+]/g, "").trim();
}

function cleanWebsite(site) {
  if (!site) return "";
  return site.replace(/\n/g, "").replace(/\s/g, "").trim();
}

function cleanEmail(email) {
  if (!email) return "";
  const match = String(email).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase().trim() : "";
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      return true;
    } catch (err) {
      console.log(`[Scraper] Retry ${i + 1} failed:`, err.message);
      await delay(5000);
    }
  }
  return false;
}

async function humanScroll(page) {
  try {
    await page.evaluate(async () => {
      const feed =
        document.querySelector('div[role="feed"]') ||
        document.querySelector(".m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd");
      if (!feed) {
        window.scrollBy(0, 800);
        await new Promise((r) => setTimeout(r, 2000));
        return;
      }
      for (let i = 0; i < 25; i++) {
        feed.scrollBy(0, Math.floor(Math.random() * 500) + 300);
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1500) + 1000));
      }
    });
  } catch (err) {
    console.log("[Scraper] Scroll warning:", err.message);
  }
}

async function waitForResults(page) {
  const selectors = [
    'div[role="feed"]',
    ".m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd",
    "a.hfpxzc",
    "div.Nv2PK.THOPZb.CpccDe",
    '[data-test-id="search-results-feed"]',
  ];
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 15000 });
      console.log(`[Scraper] Found results via: ${selector}`);
      return true;
    } catch (e) {
      continue;
    }
  }
  try {
    await page.waitForFunction(
      () => {
        return (
          document.querySelectorAll('div[role="article"], a[href*="/maps/place"]').length > 0
        );
      },
      { timeout: 20000 }
    );
    console.log("[Scraper] Found results via fallback");
    return true;
  } catch {
    return false;
  }
}

async function extractLinks(page) {
  const selectors = [
    "a.hfpxzc",
    'a[href*="/maps/place"]',
    "div.Nv2PK a",
    ".qBF1Pd",
    '[data-test-id="place-link"]',
  ];
  for (const sel of selectors) {
    try {
      const links = await page.$$eval(sel, (els) =>
        els
          .map((el) => el.href || el.closest("a")?.href)
          .filter(Boolean)
      );
      if (links.length > 0) {
        console.log(`[Scraper] Extracted ${links.length} links via: ${sel}`);
        return [...new Set(links)];
      }
    } catch (e) {
      continue;
    }
  }
  try {
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .map((a) => a.href)
        .filter((href) => href && href.includes("/maps/place"));
    });
    if (links.length > 0) {
      console.log(`[Scraper] Extracted ${links.length} links via deep scan`);
      return [...new Set(links)];
    }
  } catch (e) {}
  return [];
}

// List all forms
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const jobs = isAdmin
      ? await db.select().from(schema.scrapingJobs).orderBy(desc(schema.scrapingJobs.createdAt))
      : await db
          .select()
          .from(schema.scrapingJobs)
          .where(eq(schema.scrapingJobs.userId, userId))
          .orderBy(desc(schema.scrapingJobs.createdAt));

    const businesses = isAdmin
      ? await db.select().from(schema.scrapedBusinesses).orderBy(desc(schema.scrapedBusinesses.createdAt))
      : await db
          .select()
          .from(schema.scrapedBusinesses)
          .where(eq(schema.scrapedBusinesses.userId, userId))
          .orderBy(desc(schema.scrapedBusinesses.createdAt));

    const planLimits = isAdmin ? { maxScrapeRecords: 9999 } : { maxScrapeRecords: 100 };

    res.render("pages/scraper/index", {
      title: "Business Scraper - ParroByte CRM",
      jobs,
      businesses,
      isAdmin,
      planLimits,
    });
  } catch (error) {
    console.error("Scraper page error:", error);
    req.flash("error", "Failed to load scraper");
    res.redirect("/dashboard");
  }
});

// Start scraping (runs in background, returns immediately)
router.post("/run", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { query, location, maxResults } = req.body;

    // Check credits for scraping
    const maxResultsNum = parseInt(maxResults) || 10;
    const creditCheck = await checkCredits(userId, "scrape", maxResultsNum);
    if (!creditCheck.allowed) {
      if (req.headers["x-requested-with"] === "XMLHttpRequest") {
        return res.json({ success: false, error: creditCheck.message });
      }
      req.flash("error", creditCheck.message);
      return res.redirect("/scraper");
    }
    const max = maxResultsNum;

    // Create job record
    const jobResult = await db
      .insert(schema.scrapingJobs)
      .values({
        userId,
        query,
        location,
        maxResults: max,
        status: "running",
      })
      .returning();
    const job = jobResult[0];

    // Support AJAX submission for modal progress
    if (req.headers["x-requested-with"] === "XMLHttpRequest") {
      res.json({ success: true, jobId: job.id });
    } else {
      res.redirect(`/scraper/progress/${job.id}`);
    }

    // Run scraping in background so HTTP request doesn't timeout
    runScrapeJob(userId, job.id, query, location, max).catch((err) => {
      console.error(`[Scraper Job ${job.id}] Background error:`, err.message);
    });
  } catch (error) {
    console.error("Scraper start error:", error);
    if (req.headers["x-requested-with"] === "XMLHttpRequest") {
      return res.json({ success: false, error: error.message });
    }
    req.flash("error", "Failed to start scraping: " + error.message);
    res.redirect("/scraper");
  }
});

// Background scraper function
async function runScrapeJob(userId, jobId, query, location, max) {
  let browser = null;
  try {
    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-IN,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });

    // Set Indian cookies to bypass EU consent
    await page.setCookie({
      name: "CONSENT",
      value: "YES+IN.en+V14+BX",
      domain: ".google.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    });
    await page.setCookie({
      name: "NID",
      value: "511=IN",
      domain: ".google.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60,
    });

    const url = `https://www.google.com/maps/search/${encodeURIComponent(query + " in " + location)}?hl=en&gl=in`;
    console.log(`[Scraper Job ${jobId}] Starting:`, url);

    const opened = await safeGoto(page, url);
    if (!opened) throw new Error("Failed to open search page");

    await delay(5000);

    // Handle cookie consent if still appears
    try {
      const hasDialog = await page.evaluate(() => {
        const text = document.body.innerText || "";
        return (
          text.includes("Cookies") ||
          text.includes("akzeptieren") ||
          text.includes("accept") ||
          text.includes("consent") ||
          document.querySelector('div[role="dialog"]') !== null ||
          document.querySelector('form[action*="consent"]') !== null
        );
      });

      if (hasDialog) {
        console.log(`[Scraper Job ${jobId}] Cookie consent detected - auto-accepting...`);
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const acceptBtn = buttons.find((b) => {
            const text = b.textContent.toLowerCase();
            return (
              text.includes("akzeptieren") ||
              text.includes("accept") ||
              text.includes("alle") ||
              text.includes("all") ||
              text.includes("agree")
            );
          });
          if (acceptBtn) {
            acceptBtn.click();
            return true;
          }
          const form = document.querySelector('form[action*="consent"]');
          if (form) {
            const submitBtn = form.querySelector('button[type="submit"], button:last-child');
            if (submitBtn) {
              submitBtn.click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          await delay(5000);
          console.log(`[Scraper Job ${jobId}] Consent accepted`);
        } else {
          await page.keyboard.press("Tab");
          await delay(500);
          await page.keyboard.press("Tab");
          await delay(500);
          await page.keyboard.press("Enter");
          await delay(3000);
          console.log(`[Scraper Job ${jobId}] Consent dismissed via keyboard`);
        }
      }
    } catch (e) {
      console.log(`[Scraper Job ${jobId}] Consent handler:`, e.message);
    }

    // Check for block page
    const pageContent = await page.content();
    if (
      pageContent.includes("unusual traffic") ||
      pageContent.includes("captcha") ||
      pageContent.includes("CAPTCHA")
    ) {
      console.log(`[Scraper Job ${jobId}] Google detected bot traffic!`);
      await page.screenshot({ path: `blocked_${jobId}.png`, fullPage: true });
      throw new Error("Google blocked the request (CAPTCHA/unusual traffic)");
    }

    const loaded = await waitForResults(page);
    if (!loaded) {
      await page.screenshot({ path: `debug_${jobId}.png`, fullPage: true });
      throw new Error("No results loaded");
    }

    console.log(`[Scraper Job ${jobId}] Scrolling...`);
    await humanScroll(page);
    await delay(4000);

    let links = await extractLinks(page);
    console.log(`[Scraper Job ${jobId}] Total links:`, links.length);

    if (links.length === 0) {
      throw new Error("No links found");
    }

    let results = [];
    let count = 1;

    for (let i = 0; i < links.length && count <= max; i++) {
      console.log(`[Scraper Job ${jobId}] Opening (${i + 1}/${links.length})`);
      const success = await safeGoto(page, links[i]);
      if (!success) {
        console.log(`[Scraper Job ${jobId}] Skipping (navigation failed)`);
        continue;
      }
      await delay(4000 + Math.floor(Math.random() * 3000));

      let data = {};
      try {
        data = await page.evaluate(() => {
          const getText = (sel) => {
            const el = document.querySelector(sel);
            return el ? el.innerText || el.textContent : "";
          };

          const name =
            getText("h1") ||
            getText(".DUwDvf") ||
            getText('[data-test-id="title"]') ||
            document.title.replace(" - Google Maps", "");

          const address =
            getText('[data-item-id="address"]') ||
            getText('[data-tooltip="Copy address"]') ||
            getText(".Io6YTe.fontBodyMedium") ||
            Array.from(document.querySelectorAll(".Io6YTe")).find((el) =>
              el.textContent.includes(",")
            )?.textContent;

          const phone =
            getText('[data-item-id^="phone"]') ||
            getText('[data-tooltip="Copy phone number"]') ||
            Array.from(document.querySelectorAll(".Io6YTe")).find((el) =>
              el.textContent.match(/[\d\s\-+]{8,}/)
            )?.textContent;

          const website =
            getText('[data-item-id="authority"]') ||
            getText('[data-tooltip="Open website"]') ||
            getText(".rogA2c") ||
            Array.from(document.querySelectorAll('a[href^="http"]')).find(
              (a) => !a.href.includes("google")
            )?.href;

          // Try to find email on the page
          const pageText = document.body.innerText || "";
          const emailMatch = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          const email = emailMatch ? emailMatch[0] : "";

          return { name, address, phone, website, email };
        });
      } catch (err) {
        console.log(`[Scraper Job ${jobId}] Extraction failed:`, err.message);
        continue;
      }

      if (!data.name || data.name === "Results" || data.name === "Google Maps" || data.name.length < 2) {
        console.log(`[Scraper Job ${jobId}] Invalid record skipped`);
        continue;
      }

      const name = cleanText(data.name);
      const address = cleanText(data.address);
      const phone = cleanPhone(data.phone);
      const website = cleanWebsite(data.website);
      const email = cleanEmail(data.email);

      // Skip Google support/policy pages
      const lowerName = name.toLowerCase();
      const lowerWebsite = website.toLowerCase();
      let isGooglePage = false;
      if (
        lowerName.includes("support.google") ||
        lowerName.includes("google support") ||
        lowerName.includes("contributionpolicy") ||
        lowerName.includes("google.com/contribution") ||
        lowerName.includes("business.google.com") ||
        lowerWebsite.includes("support.google.com") ||
        lowerWebsite.includes("policies.google.com") ||
        lowerWebsite.includes("google.com/policies") ||
        lowerWebsite.includes("business.google.com")
      ) {
        isGooglePage = true;
        console.log(`[Scraper Job ${jobId}] Cleared website for Google page:`, name);
      }

      const finalWebsite = isGooglePage ? "" : website;

      if (results.some((r) => r.name === name)) {
        console.log(`[Scraper Job ${jobId}] Duplicate skipped:`, name);
        continue;
      }

      console.log(`[Scraper Job ${jobId}] ${count}. ${name} | ${phone || "No phone"} | ${email || "No email"}`);

      // Save to DB immediately
      await db.insert(schema.scrapedBusinesses).values({
        userId,
        jobId,
        name,
        phone,
        email,
        address,
        website: finalWebsite,
        category: query,
        sourceUrl: links[i],
      });

      results.push({ sno: count++, name, phone, email, address, website: finalWebsite });
      await delay(2000);
    }

    await db
      .update(schema.scrapingJobs)
      .set({ status: "completed", recordsFound: results.length, completedAt: new Date() })
      .where(eq(schema.scrapingJobs.id, jobId));

    // Charge credits for scraped records
    if (results.length > 0) {
      try {
        await chargeCredits(
          { session: { user: { id: userId } } },
          "scrape",
          results.length,
          `Scraper job ${jobId}: ${results.length} records`
        );
        console.log(`[Scraper Job ${jobId}] Charged ${results.length} credits for ${results.length} records`);
      } catch (e) {
        console.error(`[Scraper Job ${jobId}] Credit charge failed:`, e.message);
      }
    }

    console.log(`[Scraper Job ${jobId}] Completed. Found ${results.length} businesses.`);
  } catch (error) {
    console.error(`[Scraper Job ${jobId}] Error:`, error.message);
    try {
      await db
        .update(schema.scrapingJobs)
        .set({
          status: "failed",
          recordsFound: 0,
          completedAt: new Date(),
          errorMessage: error.message,
        })
        .where(eq(schema.scrapingJobs.id, jobId));
    } catch (dbErr) {}
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
}

// Import scraped businesses to contacts
router.post("/import-contacts", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { businessIds } = req.body;
    const ids = JSON.parse(businessIds || "[]");

    const businesses = await db
      .select()
      .from(schema.scrapedBusinesses)
      .where(eq(schema.scrapedBusinesses.userId, userId));

    // Fetch jobs to get location info
    const jobs = await db.select().from(schema.scrapingJobs).where(eq(schema.scrapingJobs.userId, userId));
    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    const toImport = businesses.filter((b) => ids.includes(String(b.id)));
    let imported = 0;

    for (const b of toImport) {
      try {
        const phoneDigits = String(b.phone || "").replace(/\D/g, "");
        if (!phoneDigits) continue;
        const fullPhone = phoneDigits.startsWith("91") ? phoneDigits : "91" + phoneDigits;
        const job = jobMap.get(b.jobId);

        await db.insert(schema.contacts).values({
          userId,
          name: b.name,
          phone: fullPhone,
          countryCode: "+91",
          group: b.category || "scraped",
          tags: `Business Type: ${b.category || "N/A"} | Location: ${job?.location || "N/A"}`,
          notes: `Imported from scraper. Business Type: ${b.category || "N/A"}, Location: ${job?.location || "N/A"}, Address: ${b.address || "N/A"}, Website: ${b.website || "no website"}, Email: ${b.email || "no email"}`,
        });

        await db
          .update(schema.scrapedBusinesses)
          .set({ importedToLeads: true })
          .where(eq(schema.scrapedBusinesses.id, b.id));

        imported++;
      } catch (e) {}
    }

    req.flash("success", `${imported} businesses imported to contacts`);
    res.redirect("/scraper");
  } catch (error) {
    console.error("Import to contacts error:", error);
    req.flash("error", "Failed to import to contacts");
    res.redirect("/scraper");
  }
});

// Import scraped businesses to leads
router.post("/import-leads", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { businessIds } = req.body;
    const ids = JSON.parse(businessIds || "[]");

    const businesses = await db
      .select()
      .from(schema.scrapedBusinesses)
      .where(eq(schema.scrapedBusinesses.userId, userId));

    // Fetch jobs to get location info
    const jobs = await db.select().from(schema.scrapingJobs).where(eq(schema.scrapingJobs.userId, userId));
    const jobMap = new Map(jobs.map((j) => [j.id, j]));

    const toImport = businesses.filter((b) => ids.includes(String(b.id)));

    // Check credits
    const creditCheck = await checkCredits(userId, "lead_import", toImport.length);
    if (!creditCheck.allowed) {
      req.flash("error", creditCheck.message);
      return res.redirect("/scraper");
    }

    let imported = 0;
    for (const b of toImport) {
      try {
        const job = jobMap.get(b.jobId);
        await db.insert(schema.leads).values({
          userId,
          source: "scraper",
          name: b.name,
          phone: b.phone,
          email: b.email || "",
          address: b.address,
          data: JSON.stringify({
            website: b.website,
            category: b.category,
            businessType: b.category,
            location: job?.location || "",
            sourceUrl: b.sourceUrl,
            email: b.email || "",
          }),
          notes: `Business Type: ${b.category || "N/A"} | Location: ${job?.location || "N/A"} | Source: Google Maps Scraper | Email: ${b.email || "N/A"}`,
          status: "new",
        });

        await db
          .update(schema.scrapedBusinesses)
          .set({ importedToLeads: true })
          .where(eq(schema.scrapedBusinesses.id, b.id));

        imported++;
      } catch (e) {}
    }

    if (imported > 0) {
      await chargeCredits(req, "lead_import", imported, `Imported ${imported} scraped businesses to leads`);
    }
    req.flash("success", `${imported} businesses imported to leads`);
    res.redirect("/scraper");
  } catch (error) {
    console.error("Import to leads error:", error);
    req.flash("error", "Failed to import to leads");
    res.redirect("/scraper");
  }
});

// Job status API for progress polling
router.get("/job-status/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const jobRows = await db.select().from(schema.scrapingJobs).where(eq(schema.scrapingJobs.id, id));

    if (!jobRows.length) {
      return res.json({ success: false, error: "Job not found" });
    }

    if (jobRows[0].userId !== userId && !isAdmin) {
      return res.json({ success: false, error: "Unauthorized" });
    }

    const job = jobRows[0];
    const businessCount = await db
      .select({ count: schema.scrapedBusinesses.id })
      .from(schema.scrapedBusinesses)
      .where(eq(schema.scrapedBusinesses.jobId, id));
    const foundSoFar = businessCount.length;

    res.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        query: job.query,
        location: job.location,
        maxResults: job.maxResults,
        recordsFound: job.recordsFound,
        foundSoFar,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      },
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Progress page
router.get("/progress/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const jobRows = await db.select().from(schema.scrapingJobs).where(eq(schema.scrapingJobs.id, id));

    if (!jobRows.length) {
      req.flash("error", "Job not found");
      return res.redirect("/scraper");
    }

    if (jobRows[0].userId !== userId && !isAdmin) {
      req.flash("error", "Unauthorized");
      return res.redirect("/scraper");
    }

    res.render("pages/scraper/progress", {
      title: "Scraping in Progress - ParroByte CRM",
      job: jobRows[0],
    });
  } catch (error) {
    req.flash("error", "Failed to load progress");
    res.redirect("/scraper");
  }
});

// Download scraped businesses as CSV
router.get("/download-csv", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const { search, websiteFilter, search_name, search_phone, search_address, search_website, search_category } =
      req.query;

    let businesses = isAdmin
      ? await db.select().from(schema.scrapedBusinesses).orderBy(desc(schema.scrapedBusinesses.createdAt))
      : await db
          .select()
          .from(schema.scrapedBusinesses)
          .where(eq(schema.scrapedBusinesses.userId, userId))
          .orderBy(desc(schema.scrapedBusinesses.createdAt));

    // Apply filters server-side to match frontend
    businesses = businesses.filter((biz) => {
      const lowerName = (biz.name || "").toLowerCase();
      const lowerPhone = (biz.phone || "").toLowerCase();
      const lowerEmail = (biz.email || "").toLowerCase();
      const lowerAddress = (biz.address || "").toLowerCase();
      const lowerWebsite = (biz.website || "").toLowerCase();
      const lowerCategory = (biz.category || "").toLowerCase();

      // Global search
      if (search) {
        const s = search.toLowerCase();
        const allText =
          lowerName + " " + lowerPhone + " " + lowerEmail + " " + lowerAddress + " " + lowerWebsite + " " + lowerCategory;
        if (!allText.includes(s)) return false;
      }

      // Column filters
      if (search_name && !lowerName.includes(search_name.toLowerCase())) return false;
      if (search_phone && !lowerPhone.includes(search_phone.toLowerCase())) return false;
      if (search_address && !lowerAddress.includes(search_address.toLowerCase())) return false;
      if (search_website && !lowerWebsite.includes(search_website.toLowerCase())) return false;
      if (search_category && !lowerCategory.includes(search_category.toLowerCase())) return false;

      // Website availability filter
      if (websiteFilter && websiteFilter !== "all") {
        const hasWebsite = biz.website && biz.website.trim() !== "";
        if (websiteFilter === "has" && !hasWebsite) return false;
        if (websiteFilter === "no" && hasWebsite) return false;
      }

      return true;
    });

    // CSV header
    let csv = "S.No,Name,Phone,Email,Address,Website,Category,Status\n";

    businesses.forEach((biz, index) => {
      const row = [
        index + 1,
        `"${(biz.name || "").replace(/"/g, '""')}"`,
        `"${(biz.phone || "").replace(/"/g, '""')}"`,
        `"${(biz.email || "").replace(/"/g, '""')}"`,
        `"${(biz.address || "").replace(/"/g, '""')}"`,
        `"${(biz.website || "no website").replace(/"/g, '""')}"`,
        `"${(biz.category || "").replace(/"/g, '""')}"`,
        biz.importedToLeads ? "Imported" : "New",
      ];
      csv += row.join(",") + "\n";
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="scraped_businesses.csv"');
    res.send(csv);
  } catch (error) {
    console.error("CSV download error:", error);
    req.flash("error", "Failed to download CSV");
    res.redirect("/scraper");
  }
});

// Delete job and its businesses
router.post("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    // Verify ownership
    const jobRows = await db.select().from(schema.scrapingJobs).where(eq(schema.scrapingJobs.id, id));

    if (!jobRows.length) {
      req.flash("error", "Job not found");
      return res.redirect("/scraper");
    }

    if (jobRows[0].userId !== userId && !isAdmin) {
      req.flash("error", "Unauthorized");
      return res.redirect("/scraper");
    }

    await db.delete(schema.scrapedBusinesses).where(eq(schema.scrapedBusinesses.jobId, id));
    await db.delete(schema.scrapingJobs).where(eq(schema.scrapingJobs.id, id));
    req.flash("success", "Job and records deleted");
    res.redirect("/scraper");
  } catch (error) {
    console.error("Delete scraper job error:", error);
    req.flash("error", "Failed to delete");
    res.redirect("/scraper");
  }
});

export default router;
