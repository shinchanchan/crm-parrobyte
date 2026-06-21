const puppeteer = require('puppeteer');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// CSV setup
const csvWriter = createCsvWriter({
    path: 'shops.csv',
    header: [
        { id: 'sno', title: 'S.No' },
        { id: 'name', title: 'Name' },
        { id: 'phone', title: 'Phone Number' },
        { id: 'address', title: 'Address' },
        { id: 'website', title: 'Website' }
    ]
});

const maxResults = 50;

// delay helper
const delay = ms => new Promise(res => setTimeout(res, ms));

/* ================= CLEAN FUNCTIONS ================= */

function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/[\u{0080}-\u{FFFF}]/gu, '')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanPhone(phone) {
    if (!phone) return '';
    return phone.replace(/[^0-9+]/g, '').trim();
}

function cleanWebsite(site) {
    if (!site) return '';
    return site.replace(/\n/g, '').replace(/\s/g, '').trim();
}

/* ================= SAFE NAVIGATION ================= */

async function safeGoto(page, url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            return true;
        } catch (err) {
            console.log(`⚠️ Retry ${i + 1} failed:`, err.message);
            await delay(2000);
        }
    }
    return false;
}

/* ================= SCROLL ================= */

async function autoScroll(page) {
    try {
        await page.evaluate(async () => {
            const scrollable = document.querySelector('div[role="feed"]');
            if (!scrollable) return;

            for (let i = 0; i < 15; i++) {
                scrollable.scrollBy(0, 1000);
                await new Promise(r => setTimeout(r, 1000));
            }
        });
    } catch (err) {
        console.log("⚠️ Scroll skipped");
    }
}

/* ================= WAIT FOR RESULTS ================= */

async function waitForResults(page) {
    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
        return true;
    } catch {
        console.log("⚠️ feed not found, using fallback...");

        try {
            await page.waitForFunction(() => {
                return document.querySelectorAll('div[role="article"]').length > 0;
            }, { timeout: 20000 });
            return true;
        } catch {
            return false;
        }
    }
}

/* ================= MAIN SCRAPER ================= */

async function scrape(query, location) {

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: '/usr/bin/google-chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    );

    const url = `https://www.google.com/maps/search/${encodeURIComponent(query + " in " + location)}`;

    console.log("🌐 Opening:", url);

    const opened = await safeGoto(page, url);

    if (!opened) {
        console.log("❌ Failed to open search page");
        await browser.close();
        return;
    }

    const loaded = await waitForResults(page);

    if (!loaded) {
        console.log("❌ No results loaded → exit safely");
        await browser.close();
        return;
    }

    console.log("🔍 Scrolling...");
    await autoScroll(page);

    let links = [];

    try {
        links = await page.$$eval('a.hfpxzc', els => els.map(el => el.href));
    } catch (err) {
        console.log("❌ Failed to extract links");
    }

    console.log("📊 Total links:", links.length);

    let results = [];
    let count = 1;

    for (let i = 0; i < links.length && count <= maxResults; i++) {

        console.log(`➡️ Opening (${i + 1}/${links.length})`);

        const success = await safeGoto(page, links[i]);

        if (!success) {
            console.log("⚠️ Skipping (navigation failed)");
            continue;
        }

        await delay(2000);

        let data = {};

        try {
            data = await page.evaluate(() => {
                const get = (sel) => document.querySelector(sel)?.innerText || '';

                return {
                    name: get('h1'),
                    address: get('[data-item-id="address"]'),
                    phone: get('[data-item-id^="phone"]'),
                    website: get('[data-item-id="authority"]')
                };
            });
        } catch (err) {
            console.log("⚠️ Extraction failed");
            continue;
        }

        if (!data.name || data.name === "Results") {
            console.log("⚠️ Invalid record skipped");
            continue;
        }

        const name = cleanText(data.name);
        const address = cleanText(data.address);
        const phone = cleanPhone(data.phone);
        const website = cleanWebsite(data.website);

        // duplicate check
        if (results.some(r => r.name === name)) {
            console.log("⚠️ Duplicate skipped:", name);
            continue;
        }

        console.log(`✅ ${count}. ${name}`);

        results.push({
            sno: count++,
            name,
            phone,
            address,
            website
        });

        await delay(1000);
    }

    try {
        await csvWriter.writeRecords(results);
        console.log("📁 CSV saved as shops.csv");
    } catch (err) {
        console.log("❌ CSV write failed");
    }

    console.log("✅ Total collected:", results.length);

    await browser.close();
}

/* ================= RUN ================= */

(async () => {
    try {
        await scrape("Dentist", "Madurai Tamil Nadu");
    } catch (err) {
        console.log("🔥 Critical crash prevented:", err.message);
    }
})();

