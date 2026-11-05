/**
 * Headless speed probe: time-to-first-link and time-to-subtitles.
 * Pure patchright headless (no overrides) — mirrors a headless-first server.
 * Usage: bun scripts/diag_headless_speed.ts <url> [maxSeconds]
 */
import { chromium } from "patchright";

const TARGET = process.argv[2];
const MAX = parseInt(process.argv[3] || "45", 10);

if (!TARGET) {
  console.error("usage: bun scripts/diag_headless_speed.ts <url> [maxSeconds]");
  process.exit(1);
}

const t0 = Date.now();
const at = () => ` [+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
let gotLink = false;
let gotSub = false;

const profile = `/tmp/strix-speed-${Math.random().toString(36).slice(2, 8)}`;
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  args: ["--headless=new", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  ignoreHTTPSErrors: true,
});

const page = await ctx.newPage();
page.on("response", (res) => {
  const u = res.url();
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  const isM3u8 = ct.includes("mpegurl") || /\.m3u8($|\?)/i.test(u);
  const isMedia = ct.includes("video/") || /\.(mp4|mkv)($|\?)/i.test(u);
  const isSub = ct.includes("text/vtt") || /\.vtt($|\?)/i.test(u);
  if ((isM3u8 || isMedia) && !gotLink) {
    gotLink = true;
    console.log(`${at()} 🎬 LINK (${res.status()}) [${ct || "?"}] ${u.slice(0, 110)}`);
  } else if (isM3u8 || isMedia) {
    console.log(`${at()}    +more [${ct}] ${u.slice(0, 90)}`);
  }
  if (isSub && !gotSub) {
    gotSub = true;
    console.log(`${at()} 💬 SUB (${res.status()}) ${u.slice(0, 110)}`);
  }
});
page.on("requestfailed", (r) => {
  if (r.resourceType() === "document")
    console.log(`${at()} ❌ DOC FAIL ${r.failure()?.errorText} ${r.url().slice(0, 90)}`);
});

console.log(`${at()} goto ${TARGET}`);
await page.goto(TARGET, { timeout: 20000, waitUntil: "commit" }).catch((e) =>
  console.log(`${at()} goto err: ${(e as Error).message.slice(0, 80)}`),
);

const deadline = t0 + MAX * 1000;
while (Date.now() < deadline && !(gotLink && gotSub)) {
  await page.waitForTimeout(2000);
  // nudge play-like controls every other tick
  if (Math.floor((Date.now() - t0) / 2000) % 2 === 0) {
    await page
      .evaluate(() => {
        document
          .querySelectorAll("video, [class*=play], [class*=player], button, [role=button]")
          .forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) (el as HTMLElement).click();
          });
      })
      .catch(() => {});
  }
  const st = await page
    .evaluate(() => ({
      title: document.title.slice(0, 60),
      hasVideo: !!document.querySelector("video"),
      blocked: document.title.includes("Attention Required"),
    }))
    .catch(() => ({ title: "ERR", hasVideo: false, blocked: false }));
  if (st.blocked) {
    console.log(`${at()} 🚫 CLOUDFLARE BLOCK`);
    break;
  }
  if (!gotLink && st.hasVideo) {
    console.log(`${at()} video element present (no src yet) title="${st.title}"`);
  }
}

console.log(
  `\nRESULT: link=${gotLink ? `${((Date.now() - t0) / 1000).toFixed(1)}s` : "NOT CAPTURED"} sub=${gotSub ? "yes" : "no"}`,
);
await ctx.close();
