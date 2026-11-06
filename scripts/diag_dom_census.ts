/**
 * Diag: dump any DOM elements whose class hints at a server/quality menu,
 * across all frames — to verify whether vidfast actually has a server picker
 * under a different class name than [class*="ServerMenu"].
 * Run: bun scripts/diag_dom_census.ts <embedUrl>
 */
import { chromium } from "patchright";

const TARGET = process.argv[2] || "https://vidfast.vc/movie/299534";

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
await page.goto(TARGET, { timeout: 30000, waitUntil: "commit" }).catch(() => {});

// Let the app fully mount, poke the UI a bit
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(3000);
  for (const f of page.frames()) {
    await f
      .evaluate(() => {
        document
          .querySelectorAll(
            "button, [role='button'], [class*='control' i] > *, [class*='settings' i], [class*='gear' i]",
          )
          .forEach((el) => {
            const cls = String((el as HTMLElement).className);
            const label = (el as HTMLElement).getAttribute?.("aria-label") || "";
            if (/setting|gear|quality|server/i.test(cls + " " + label)) {
              (el as HTMLElement).click();
            }
          });
      })
      .catch(() => {});
  }
}

for (const f of page.frames()) {
  const info = await f
    .evaluate(() => {
      const hits = new Set<string>();
      document.querySelectorAll("*").forEach((el) => {
        const cls = String((el as HTMLElement).className || "");
        if (/server|quality|source/i.test(cls) && cls.length < 120) {
          hits.add(cls);
        }
      });
      return {
        url: location.href.slice(0, 120),
        hits: [...hits].slice(0, 30),
      };
    })
    .catch(() => null);
  if (info && (info.hits.length > 0 || page.frames().length <= 3)) {
    console.log(`FRAME ${info.url}`);
    for (const h of info.hits) console.log(`   class: ${h}`);
  }
}

await ctx.close();
process.exit(0);
