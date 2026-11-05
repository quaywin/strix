/**
 * Minimal patchright variants vs Cloudflare: which setup passes?
 * Variant A: headless, zero overrides (patchright as intended)
 * Variant B: headed, zero overrides
 * Variant C: headless + UA override only (current server's UA spoof)
 * Variant D: headed + FULL replica of the server's launch config
 * Usage: bun scripts/diag_minimal.ts [A|B|C|D]
 */
import { chromium } from "patchright";
import { STEALTH_INIT_SCRIPT } from "../src/scraper/BrowserProvider";

const variant = (process.argv[2] || "A").toUpperCase();
const TARGET = process.argv[3] || "https://vidfast.vc/movie/1657630";
const headed = variant === "B" || variant === "D" || variant === "F";

const args = headed
  ? []
  : ["--headless=new"];

if (variant === "C") {
  args.push("--disable-blink-features=AutomationControlled");
}

if (variant === "D" || variant === "E" || variant === "F") {
  args.push(
    "--disable-blink-features=AutomationControlled",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-site-isolation-trials",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--mute-audio",
    "--renderer-process-limit=2",
    "--disable-accelerated-video-decode",
    "--disable-webrtc",
    "--disk-cache-size=10485760",
    "--media-cache-size=10485760",
    "--js-flags=--max-old-space-size=256",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-zygote",
    "--disable-breakpad",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-prompt-on-repost",
    "--disable-webgl",
    "--disable-3d-apis",
    "--ignore-certificate-errors",
    "--password-store=basic",
    "--use-mock-keychain",
    "--process-per-site",
    "--lang=en-US,en;q=0.9",
    "--window-size=1280,720",
  );
}

const ctx = await chromium.launchPersistentContext("/tmp/strix-diag-min-profile", {
  headless: !headed,
  args,
  ...(variant === "C" || variant === "D" || variant === "E" || variant === "F"
    ? {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      }
    : {}),
  ignoreHTTPSErrors: true,
});

if (variant === "E") {
  await ctx.addInitScript(STEALTH_INIT_SCRIPT);
}

const page = await ctx.newPage();

// Variant F: mimic the engine's page.route("**/*") passthrough
if (variant === "F") {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    const u = route.request().url().toLowerCase();
    if (/\.(vtt|srt|m3u8|mp4|mkv|webm)($|\?)/.test(u)) {
      route.continue().catch(() => {});
      return;
    }
    if (
      type === "image" || type === "font" || type === "stylesheet" ||
      /\.(ts|m4s)($|\?)/.test(u)
    ) {
      route.abort().catch(() => {});
      return;
    }
    route.continue().catch(() => {});
  });
}

page.on("response", (res) => {
  if (res.request().resourceType() === "document") {
    console.log(`[${variant}] document: ${res.status()} ${res.url()}`);
  }
  const u = res.url();
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("video/") || /\.(m3u8|mp4|vtt|srt)($|\?)/i.test(u)) {
    console.log(`[${variant}] MEDIA ${res.status()} [${ct}] ${u.slice(0, 140)}`);
  }
});

await page.goto(TARGET, { timeout: 20000, waitUntil: "commit" });

for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(5000);
  const state = await page
    .evaluate(() => ({
      title: document.title,
      hasVideo: !!document.querySelector("video"),
      iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.src),
    }))
    .catch(() => ({ title: "ERR", hasVideo: false, iframes: [] }));
  console.log(
    `[${variant}] +${(i + 1) * 5}s title="${state.title}" hasVideo=${state.hasVideo} iframes=${JSON.stringify(state.iframes)}`,
  );
  if (i === 1) {
    await page.mouse.click(640, 360).catch(() => {});
    await page
      .evaluate(() => {
        document
          .querySelectorAll('[class*=play], [class*=player], video, [role=button]')
          .forEach((el) => (el as HTMLElement).click());
      })
      .catch(() => {});
  }
}

await ctx.close();
