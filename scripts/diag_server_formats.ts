/**
 * Diag: per-server format census for one embed URL.
 *
 * Opens the embed (headed, Cloudflare-friendly profile), records the stream
 * format each server in the embed's ServerMenu produces:
 *   1. default server (no click) — first m3u8/mp4/mpd/mkv/webm seen
 *   2. each radio in the server menu, clicked one by one
 *
 * Run: bun scripts/diag_server_formats.ts <embedUrl> [budgetSec]
 */
import { chromium, type Page } from "patchright";

const TARGET = process.argv[2];
const BUDGET_MS = (parseInt(process.argv[3] || "75", 10) || 75) * 1000;

if (!TARGET) {
  console.error("usage: bun scripts/diag_server_formats.ts <embedUrl> [budgetSec]");
  process.exit(1);
}

const MENU_OPEN_WAIT_MS = 1500;
const SERVER_SETTLE_MS = 12000;

function classify(url: string): string | null {
  const u = url.toLowerCase();
  if (u.includes(".m3u8") || u.includes("mpegurl")) return "m3u8";
  if (u.includes(".mpd") || u.includes("dash+xml")) return "mpd";
  if (u.includes(".mkv") || u.includes("matroska")) return "mkv";
  if (u.includes(".webm")) return "webm";
  if (u.includes(".mp4")) return "mp4";
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

interface ServerResult {
  name: string;
  format: string;
  url: string;
  atSec: number;
}

const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

async function clickPlayButtons(page: Page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        const sels = [
          ".jw-display-icon-container",
          ".vjs-big-play-button",
          '[class*="PlayIcon"]',
          '[class*="playButton" i]',
          '[class*="controlItem" i][class*="play" i]',
          "button[aria-label*='lay' i]",
        ].join(", ");
        document.querySelectorAll(sels).forEach((b) => {
          const el = b as HTMLElement;
          const st = window.getComputedStyle(el);
          if (st.display !== "none" && st.visibility !== "hidden") el.click();
        });
      })
      .catch(() => {});
  }
}

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
const results: ServerResult[] = [];
const seenUrls = new Set<string>();
let activeServer = "__default";

const onResp = (res: any) => {
  try {
    const url = res.url();
    const ct = (res.headers()["content-type"] || "").toLowerCase();
    let fmt = classify(url);
    if (!fmt && ct.includes("mpegurl")) fmt = "m3u8";
    if (!fmt && ct.includes("dash+xml")) fmt = "mpd";
    if (!fmt) return;
    const key = `${activeServer}|${url}`;
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    // Variant playlists of an already-seen master: ignore (same server, same source)
    const existing = results.find((r) => r.format === fmt && hostOf(r.url) === hostOf(url));
    if (existing) return;
    const rec: ServerResult = {
      name: activeServer,
      format: fmt,
      url,
      atSec: (Date.now() - t0) / 1000,
    };
    results.push(rec);
    console.log(`${ts()} STREAM [${activeServer}] ${fmt} ← ${hostOf(url)} ${url.slice(0, 110)}`);
  } catch {}
};
page.on("response", onResp);

page.on("pageerror", (e) => console.log(`${ts()} PAGEERROR: ${String(e).slice(0, 120)}`));

console.log(`${ts()} goto ${TARGET}`);
await page.goto(TARGET, { timeout: 30000, waitUntil: "commit" }).catch((e) =>
  console.log(`${ts()} goto failed: ${e}`),
);

// Phase 0: default server — give it up to 18s to emit something
const deadline = t0 + BUDGET_MS;
while (Date.now() - t0 < 18000 && Date.now() < deadline) {
  await clickPlayButtons(page);
  await page.waitForTimeout(2000);
  if (results.length > 0) break;
}
console.log(`${ts()} default server done: ${results.length} stream(s)`);

// Phase 1: find the frame hosting the ServerMenu and enumerate radios
let playerFrame = null as any;
for (let round = 0; round < 5 && !playerFrame; round++) {
  for (const f of page.frames()) {
    const has = await f
      .evaluate(() => Boolean(document.querySelector('[class*="ServerMenu"]')))
      .catch(() => false);
    if (has) {
      playerFrame = f;
      break;
    }
  }
  if (!playerFrame) await page.waitForTimeout(2000);
}

if (!playerFrame) {
  console.log(`${ts()} NO ServerMenu found on this provider (single-server embed).`);
} else {
  const openMenu = async () => {
    await playerFrame.evaluate(() => {
      const btn = document.querySelector(
        '[class*="ServerMenu"][class*="menuButton"]',
      ) as HTMLElement | null;
      const content = document.querySelector('[class*="ServerMenu"][class*="menuContent"]');
      if (btn && (!content || content.getBoundingClientRect().width === 0)) btn.click();
    }).catch(() => {});
    await page.waitForTimeout(MENU_OPEN_WAIT_MS);
  };

  const readRadios = async (): Promise<{ idx: number; name: string }[]> =>
    playerFrame.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[class*="ServerMenu"]')).filter(
        (el) => {
          const cls = String((el as HTMLElement).className);
          return (
            cls.includes("radio") &&
            !cls.includes("Label") &&
            !cls.includes("Group") &&
            !cls.includes("Sub")
          );
        },
      ) as HTMLElement[];
      return rows.map((el, i) => ({
        idx: i,
        name: (el.innerText || `radio#${i}`).split("\n")[0]?.trim().slice(0, 40) ?? `radio#${i}`,
      }));
    }).catch(() => []);

  await openMenu();
  const radios = await readRadios();
  console.log(`${ts()} servers in menu (${radios.length}): ${radios.map((r) => r.name).join(" | ")}`);

  // Click each non-default radio; attribute the first NEW stream to it
  for (const r of radios.slice(1)) {
    if (Date.now() > deadline) {
      console.log(`${ts()} budget exhausted, stopping.`);
      break;
    }
    const before = results.length;
    activeServer = r.name;
    const clicked = await playerFrame.evaluate((idx: number) => {
      const rows = Array.from(document.querySelectorAll('[class*="ServerMenu"]')).filter(
        (el) => {
          const cls = String((el as HTMLElement).className);
          return (
            cls.includes("radio") &&
            !cls.includes("Label") &&
            !cls.includes("Group") &&
            !cls.includes("Sub")
          );
        },
      ) as HTMLElement[];
      const target = rows[idx];
      if (!target) return false;
      const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
      target.dispatchEvent(
        new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true } as PointerEventInit),
      );
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(
        new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true } as PointerEventInit),
      );
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.click();
      return true;
    }, r.idx).catch(() => false);

    if (!clicked) {
      console.log(`${ts()} [${r.name}] click failed`);
      continue;
    }
    console.log(`${ts()} switched to server "${r.name}"`);

    const settleEnd = Date.now() + SERVER_SETTLE_MS;
    while (Date.now() < settleEnd) {
      await clickPlayButtons(page);
      // Reopen menu if the click closed it before we get to the next radio
      await page.waitForTimeout(2000);
      if (results.length > before) break;
    }
    const got = results.slice(before).filter((x) => x.name === r.name);
    if (got.length === 0) console.log(`${ts()} [${r.name}] no new stream within ${SERVER_SETTLE_MS / 1000}s (stalled?)`);
    await openMenu().catch(() => {});
  }
}

console.log("\n===== SUMMARY for", TARGET, "=====");
const byServer = new Map<string, ServerResult>();
for (const r of results) {
  const prev = byServer.get(r.name);
  // Prefer m3u8 > mp4 > webm > mkv > mpd when one server emits several
  const rank: Record<string, number> = { m3u8: 5, mp4: 4, webm: 3, mkv: 2, mpd: 1 };
  if (!prev || (rank[r.format] || 0) > (rank[prev.format] || 0)) byServer.set(r.name, r);
}
for (const [name, r] of byServer) {
  console.log(`  ${name.padEnd(20)} → ${r.format.padEnd(5)} (${hostOf(r.url)})`);
}
console.log(`  distinct formats: ${[...new Set([...byServer.values()].map((r) => r.format))].join(", ") || "NONE"}`);

await ctx.close();
process.exit(0);
