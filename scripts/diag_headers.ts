/**
 * Dump the exact HTTP request headers Chromium sends for a document
 * navigation, to spot automation leaks (Sec-CH-UA "HeadlessChrome", etc.).
 * Run: bun scripts/diag_headers.ts
 */
import { chromium } from "patchright";

const profile = "/tmp/strix-diag-headers-profile";

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ignoreHTTPSErrors: true,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--headless=new",
    "--window-size=1280,720",
    "--lang=en-US,en;q=0.9",
  ],
});

const page = await ctx.newPage();
page.on("request", (req) => {
  if (req.resourceType() === "document") {
    console.log("=== DOCUMENT REQUEST HEADERS ===");
    console.log(JSON.stringify(req.headers(), null, 2));
  }
});

await page.goto("https://httpbin.org/headers", {
  timeout: 20000,
  waitUntil: "domcontentloaded",
}).catch((e) => console.log(`goto: ${e.message}`));

// Also read what the SERVER saw (httpbin echoes the real wire headers)
const text = await page
  .evaluate(() => document.body.innerText)
  .catch(() => "n/a");
console.log("=== SERVER-SIDE VIEW (httpbin echo) ===");
console.log(text.slice(0, 2000));

await ctx.close();
