/**
 * Diag: discover where an embed player loads its subtitles from.
 * Opens the embed, waits for playback, clicks the subtitle/CC control and any
 * language entries, logging every network request that looks subtitle-ish.
 * Run: bun scripts/diag_subtitles.ts <embedUrl> [budgetSec]
 */
import { chromium, type Page } from "patchright";

const TARGET = process.argv[2] || "https://vidnest.fun/movie/299534";
const BUDGET_MS = (parseInt(process.argv[3] || "70", 10) || 70) * 1000;

const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const ctx = await chromium.launchPersistentContext("/tmp/strix-net-profile", {
  headless: false,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--window-size=1280,720",
    "--window-position=2000,0",
  ],
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ignoreHTTPSErrors: true,
});

const page = await ctx.newPage();
const subHits: string[] = [];
const logSub = (label: string, url: string) => {
  if (subHits.includes(url)) return;
  subHits.push(url);
  console.log(`${ts()} SUB ${label}: ${url.slice(0, 180)}`);
};

page.on("request", (req) => {
  const u = req.url();
  if (/\.vtt($|\?)|\.srt($|\?)|subtitle|\/subs|\/tracks|captions/i.test(u)) {
    logSub("REQ", u);
  }
});
page.on("response", (res) => {
  const u = res.url();
  const ct = (res.headers()["content-type"] || "").toLowerCase();
  if (/\.vtt($|\?)|\.srt($|\?)|subtitle|\/subs|\/tracks|captions/i.test(u) || /vtt|subrip/i.test(ct)) {
    logSub(`RES ${res.status()} ct=${ct || "?"}`, u);
  }
});

console.log(`${ts()} goto ${TARGET}`);
await page.goto(TARGET, { timeout: 30000, waitUntil: "commit" }).catch((e) => console.log(`${ts()} goto: ${e}`));

// Wait for the player to mount and start
const deadline = t0 + BUDGET_MS;
for (let i = 0; i < 10 && Date.now() < deadline; i++) {
  await page.waitForTimeout(2500);
  const playing = await page.evaluate(() => {
    const v = document.querySelector("video");
    return Boolean(v && (v.currentSrc || v.src || !v.paused));
  }).catch(() => false);
  for (const f of page.frames()) {
    const p = await f.evaluate(() => {
      const v = document.querySelector("video");
      return Boolean(v && (v.currentSrc || v.src));
    }).catch(() => false);
    if (p) break;
  }
  if (playing) {
    console.log(`${ts()} playback started`);
    break;
  }
}

// Poke UI: click any subtitle / CC / settings-ish control across frames
const clickSubControls = async () => {
  for (const f of page.frames()) {
    const clicked = await f
      .evaluate(() => {
        const sels = [
          '[class*="ubtitle" i]:not([class*="Menu"]):not([class*="menu"])',
          '[class*="aption" i]:not([class*="Menu"]):not([class*="menu"])',
          '[aria-label*="ubtitle" i]',
          '[aria-label*="aption" i]',
          '[class*="setting" i][class*="utton" i]',
        ].join(", ");
        const els = Array.from(document.querySelectorAll(sels)) as HTMLElement[];
        let did = 0;
        for (const el of els) {
          const st = window.getComputedStyle(el);
          if (st.display !== "none" && st.visibility !== "hidden" && st.width !== "0px") {
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
            did++;
          }
        }
        return did;
      })
      .catch(() => 0);
    if (clicked > 0) console.log(`${ts()} clicked ${clicked} subtitle-ish control(s) in frame ${f.url().slice(0, 60)}`);
  }
};

await clickSubControls();
await page.waitForTimeout(3000);

// Second pass: menu items (language entries) that appeared
for (const f of page.frames()) {
  const items = await f
    .evaluate(() => {
      const out: string[] = [];
      document
        .querySelectorAll('[class*="ubtitle" i] *, [class*="enu" i] [class*="item" i], li, [role="menuitem"]')
        .forEach((el) => {
          const txt = (el.textContent || "").trim().slice(0, 30);
          if (txt && txt.length < 30 && /off|english|viet|vi\b|en\b|indones|spanish|japanese|chinese|german|french/i.test(txt)) {
            out.push(txt);
            (el as HTMLElement).dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
          }
        });
      return [...new Set(out)].slice(0, 15);
    })
    .catch(() => [] as string[]);
  if (items.length > 0) console.log(`${ts()} clicked language items: ${items.join(" | ")}`);
}

// Keep listening for subtitle network traffic
while (Date.now() < deadline) await page.waitForTimeout(2000);

console.log(`\n===== SUBTITLE SOURCE SUMMARY for ${TARGET} =====`);
console.log(subHits.length === 0 ? "  (no subtitle network traffic observed)" : "");
for (const u of subHits) console.log(`  ${u.slice(0, 160)}`);
await ctx.close();
process.exit(0);
