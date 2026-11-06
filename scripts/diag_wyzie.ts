/**
 * Diag: pass subs.com.ru browser verification, then query the Wyzie
 * subtitle API from inside the verified page context.
 * Run: bun scripts/diag_wyzie.ts <tmdbId>
 */
import { chromium } from "patchright";

const KEY = process.argv[3] || "";
const TMDB = process.argv[2] || "1792170";

const ctx = await chromium.launchPersistentContext("/tmp/strix-net-profile", {
  headless: false,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,720",
    "--window-position=2000,0",
  ],
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ignoreHTTPSErrors: true,
});

const page = await ctx.newPage();
console.log("goto https://subs.com.ru ...");
await page.goto("https://subs.com.ru", { timeout: 30000, waitUntil: "commit" }).catch(() => {});

// Wait out the JS verification
const t0 = Date.now();
while (Date.now() - t0 < 25000) {
  await page.waitForTimeout(2000);
  const title = await page.title().catch(() => "?");
  if (!/browser verification/i.test(title)) {
    console.log(`verification passed after ${((Date.now() - t0) / 1000).toFixed(1)}s — title: ${title}`);
    break;
  }
}
await page.waitForLoadState("load").catch(() => {});
await page.waitForTimeout(3000);
console.log("settled url:", page.url());

// Query the API candidates from inside the verified origin
const endpoints = [
  `/api/subs/search?id=${TMDB}`,
  `/api/subs/search?tmdb_id=${TMDB}`,
  `/api/subs/search/${TMDB}`,
];
for (const ep of endpoints) {
  let out = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    out = await page
      .evaluate(
        async ({ ep, key }) => {
          try {
            const res = await fetch(ep, {
              headers: { authorization: `Bearer ${key}`, accept: "application/json" },
            });
            const text = await res.text();
            return `HTTP ${res.status} ct=${res.headers.get("content-type")} :: ${text.slice(0, 400)}`;
          } catch (e: any) {
            return `FETCH ERROR: ${e.message}`;
          }
        },
        { ep, key: KEY },
      )
      .catch((e) => `EVAL ERROR: ${String(e).slice(0, 120)}`);
    if (!String(out).startsWith("EVAL ERROR")) break;
    await page.waitForTimeout(2000);
    await page.waitForLoadState("load").catch(() => {});
  }
  console.log(`[${ep}] → ${String(out).slice(0, 420)}`);
}

await ctx.close();
process.exit(0);
