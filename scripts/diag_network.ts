/**
 * Full network audit of the vidfast page: every xhr/fetch, failures, and
 * long-hangs, to find why the player stays on "FETCHING, ONE MOMENT...".
 * Run: bun scripts/diag_network.ts [url]
 */
import { chromium } from "patchright";

const TARGET = process.argv[2] || "https://vidfast.vc/movie/1657630";

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
const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

page.on("request", (req) => {
  const t = req.resourceType();
  if (t === "xhr" || t === "fetch" || t === "websocket" || t === "media") {
    console.log(`${ts()} REQ ${req.method()} [${t}] ${req.url().slice(0, 180)}`);
  }
});
page.on("requestfailed", (req) => {
  console.log(
    `${ts()} FAIL [${req.resourceType()}] ${req.failure()?.errorText} ${req.url().slice(0, 180)}`,
  );
});
page.on("response", (res) => {
  const t = res.request().resourceType();
  if (t === "xhr" || t === "fetch" || t === "websocket" || t === "media") {
    console.log(`${ts()} RES ${res.status()} [${t}] ${res.url().slice(0, 180)}`);
  }
});
page.on("console", (m) => {
  const txt = m.text();
  if (!/gtag|analytics|adservice|doubleclick/i.test(txt) && txt.length < 250) {
    console.log(`${ts()} console(${m.type()}): ${txt}`);
  }
});
page.on("pageerror", (err) => console.log(`${ts()} PAGEERROR: ${String(err).slice(0, 250)}`));

console.log(`${ts()} goto ${TARGET}`);
await page.goto(TARGET, { timeout: 20000, waitUntil: "commit" });

for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(5000);
  const st = await page
    .evaluate(() => ({
      text: (document.body?.innerText || "").slice(0, 120).replace(/\n+/g, " | "),
      videoSrc: (document.querySelector("video") as HTMLVideoElement)?.currentSrc || "",
      iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.src),
    }))
    .catch(() => ({ text: "ERR", videoSrc: "", iframes: [] }));
  console.log(`${ts()} STATE: "${st.text}" videoSrc="${st.videoSrc}" iframes=${JSON.stringify(st.iframes)}`);
  if (st.videoSrc) break;
}

await ctx.close();
