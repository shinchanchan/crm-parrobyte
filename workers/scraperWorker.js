#!/usr/bin/env node
/**
 * Scraper Worker — BullMQ Worker Process
 * Handles Google Maps business scraping with Puppeteer
 * Limited concurrency to prevent server overload
 */
import { Worker } from "bullmq";
import IORedis from "ioredis";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { db } from "../server/lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { checkCredits, deductCredits } from "../server/lib/credits.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

puppeteer.use(StealthPlugin());

async function findChrome() {
  const paths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ];
  for (const p of paths) if (p) return p;
  return undefined;
}

async function processScrape(job) {
  const { userId, jobId, query, location, maxResults } = job.data;
  console.log(`[ScraperWorker] Job ${jobId}: "${query}" in "${location}", max=${maxResults}`);

  let browser = null;
  try {
    // Check credits before starting
    const creditCheck = await checkCredits(userId, "scrape", maxResults);
    if (!creditCheck.allowed) {
      throw new Error("Insufficient credits for scraping");
    }

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: await findChrome(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
        "--disable-features=site-per-process",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--memory-model=low",
        "--max_old_space_size=256",
        "--window-size=800,600",
      ],
      defaultViewport: { width: 800, height: 600 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Build search URL
    const searchQuery = encodeURIComponent(`${query} in ${location}`);
    const searchUrl = `https://www.google.com/maps/search/${searchQuery}`;
    console.log(`[ScraperWorker] Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Extract business listings
    const results = await page.evaluate((max) => {
      const listings = [];
      const cards = document.querySelectorAll('[data-result-index]');
      cards.forEach((card, idx) => {
        if (idx >= max) return;
        try {
          const name = card.querySelector(".fontHeadlineSmall")?.textContent?.trim() || "";
          const phone = card.querySelector('[data-item-id*="phone"]')?.textContent?.trim() || "";
          const address = card.querySelector('[data-item-id*="address"]')?.textContent?.trim() || "";
          const website = card.querySelector("a[href^='http']")?.href || "";
          const rating = card.querySelector(".MW4etd")?.textContent?.trim() || "";
          listings.push({ name, phone, address, website, rating });
        } catch (e) {}
      });
      return listings;
    }, maxResults);

    console.log(`[ScraperWorker] Job ${jobId}: Found ${results.length} results`);

    // Save results
    for (const r of results) {
      if (!r.name) continue;
      await db.insert(schema.scrapedBusinesses).values({
        userId,
        jobId,
        name: r.name,
        phone: r.phone || null,
        address: r.address || null,
        website: r.website || null,
        category: query,
      });
    }

    // Update job status
    await db.update(schema.scrapingJobs)
      .set({ status: "completed", recordsFound: results.length, completedAt: new Date() })
      .where(eq(schema.scrapingJobs.id, jobId));

    // Deduct credits
    await deductCredits(userId, "scrape", results.length, `Scraper job ${jobId}: ${results.length} records`);

    await job.updateProgress(100);
  } catch (error) {
    console.error(`[ScraperWorker] Job ${jobId} failed:`, error.message);
    await db.update(schema.scrapingJobs)
      .set({ status: "failed", errorMessage: error.message, completedAt: new Date() })
      .where(eq(schema.scrapingJobs.id, jobId));
    throw error;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

const scraperWorker = new Worker("scraper", processScrape, {
  connection,
  concurrency: 1, // ONLY ONE scrape at a time — Puppeteer is heavy
  limiter: { max: 1, duration: 2000 },
});

scraperWorker.on("completed", job => console.log(`[ScraperWorker] Job ${job.id} completed`));
scraperWorker.on("failed", (job, err) => console.error(`[ScraperWorker] Job ${job?.id} failed:`, err.message));

console.log("[ScraperWorker] Started. Concurrency=1 (one scrape at a time).");

process.on("SIGTERM", async () => {
  await scraperWorker.close();
  await connection.quit();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await scraperWorker.close();
  await connection.quit();
  process.exit(0);
});
