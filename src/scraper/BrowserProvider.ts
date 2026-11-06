import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext } from "patchright";
import { chromium } from "patchright";
import { CONFIG } from "../config";

/**
 * Anti-bot detection init script.
 *
 * Sites like dlhd.pk inspect `navigator.userAgentData.brands` and detect
 * `HeadlessChrome`. This script overrides the common automation signals:
 *  - navigator.webdriver -> undefined
 *  - navigator.plugins / languages -> non-empty realistic values
 *  - window.chrome -> present
 *  - navigator.userAgentData -> regular Chrome brands (NOT HeadlessChrome)
 *  - permissions.query for notifications -> mirrors Notification.permission
 *
 * Source: adapted from the debug_dlhd.ts experiment in qIPTV.
 */
const STEALTH_INIT_SCRIPT = `
  // Mock visibility state to prevent video players from pausing or delaying streams in headless mode
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  const blockVisibility = (e) => { e.stopImmediatePropagation(); };
  document.addEventListener('visibilitychange', blockVisibility, true);
  document.addEventListener('webkitvisibilitychange', blockVisibility, true);

  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  window.chrome = { runtime: {} };

  // Neutralize anti-embed sandbox detector (e.g. sandDetect object/PDF error trick)
  try {
    Object.defineProperty(window, 'sandDetect', {
      get: () => () => {},
      set: () => {},
      configurable: true,
    });
  } catch (e) {}

  // Disable popup window opening to block click-jack ads from spawning new tabs
  try {
    window.open = () => ({ closed: true, focus: () => {}, close: () => {} });
  } catch (e) {}
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
  try {
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [
          { brand: 'Chromium', version: '130' },
          { brand: 'Google Chrome', version: '130' },
          { brand: 'Not?A_Brand', version: '99' },
        ],
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: () => Promise.resolve({
          architecture: 'arm',
          bitness: '64',
          fullVersionList: [
            { brand: 'Chromium', version: '130.0.0.0' },
            { brand: 'Google Chrome', version: '130.0.0.0' },
          ],
          mobile: false,
          model: '',
          platform: 'macOS',
          platformVersion: '10.15.7',
          uaFullVersion: '130.0.0.0',
        }),
        toJSON: () => ({
          brands: [
            { brand: 'Chromium', version: '130' },
            { brand: 'Google Chrome', version: '130' },
            { brand: 'Not?A_Brand', version: '99' },
          ],
          mobile: false,
          platform: 'macOS',
        }),
      }),
    });
  } catch (e) {}
`;

// A realistic desktop Chrome UA — Playwright's default headless UA leaks
// "HeadlessChrome" in the string itself, which is another common detection vector.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export class PlaywrightBrowserProvider {
  // Promise-based singleton so concurrent callers (e.g. eager warmup racing
  // with the first request) await the SAME in-flight creation instead of
  // each spawning a separate browser context.
  private contextPromise: Promise<BrowserContext> | null = null;
  private activeCount = 0;
  private totalUses = 0;

  async acquireContext(): Promise<BrowserContext> {
    this.activeCount++;
    this.totalUses++;

    if (!this.contextPromise) {
      console.log("[BROWSER] Launching browser context...");
      this.contextPromise = this.createContext().catch((err) => {
        // Clear the cached promise on failure so the next call can retry
        // creation instead of all future callers permanently rejecting.
        this.contextPromise = null;
        this.activeCount = Math.max(0, this.activeCount - 1);
        throw err;
      });
    }
    return this.contextPromise;
  }

  async releaseContext(): Promise<void> {
    this.activeCount = Math.max(0, this.activeCount - 1);

    // When completely idle (no active scrapes currently in flight)
    if (this.activeCount === 0) {
      if (this.totalUses >= CONFIG.MAX_BROWSER_USES) {
        console.log(
          `[BROWSER] Context reached ${this.totalUses} uses. Recycling browser context to free RAM...`,
        );
        await this.recycle();
      } else if (this.contextPromise) {
        // Sweep and close any leftover orphan tabs to keep Chromium at 0 open pages while idle
        try {
          const ctx = await this.contextPromise;
          const pages = ctx.pages();
          for (const p of pages) {
            if (!p.isClosed()) {
              await p.close().catch(() => {});
            }
          }
        } catch (_) {}
      }

      // Collect memory in Bun runtime
      if (typeof (Bun as any)?.gc === "function") {
        (Bun as any).gc(false);
      }
    }
  }

  async recycle(): Promise<void> {
    const promise = this.contextPromise;
    this.contextPromise = null;
    this.totalUses = 0;
    if (promise) {
      try {
        const ctx = await promise;
        await ctx.close();
        console.log("[BROWSER] Browser context recycled successfully.");
      } catch (e) {
        // Ignored
      }
    }
    // Non-blocking GC in Bun to reclaim memory without freezing the event loop
    if (typeof (Bun as any)?.gc === "function") {
      (Bun as any).gc(false);
    }
  }

  private async createContext(): Promise<BrowserContext> {
    const chromePath = CONFIG.CHROME_PATH;
    const userDataDir =
      CONFIG.USER_DATA_DIR ||
      path.join(os.tmpdir(), "playwright_profile_strix");

    const args = [
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
      "--disk-cache-size=10485760", // Cap disk cache to 10MB
      "--media-cache-size=10485760", // Cap media cache to 10MB
      "--js-flags=--max-old-space-size=256", // Cap V8 heap to 256MB
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
    ];

    if (CONFIG.HEADLESS) {
      args.push("--headless=new");
    }

    const launchOptions = {
      headless: CONFIG.HEADLESS,
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      args,
    };

    if (chromePath) {
      (launchOptions as { executablePath?: string }).executablePath =
        chromePath;
    }

    if (CONFIG.PROXY_SERVER) {
      (launchOptions as any).proxy = {
        server: CONFIG.PROXY_SERVER,
      };
      console.log(`[BROWSER] Using proxy server: ${CONFIG.PROXY_SERVER}`);
    }

    console.log(
      `[BROWSER] Headless mode is set to: ${CONFIG.HEADLESS} (executable: ${chromePath || "bundled chromium"})`,
    );

    const context = await chromium.launchPersistentContext(
      userDataDir,
      launchOptions,
    );

    // Only inject the stealth script in headless mode. In headed mode the
    // real browser fingerprint is already internally consistent, and the
    // script's coarse overrides (fake plugins array, synthetic window.chrome,
    // version-skewed userAgentData) create detectable inconsistencies that
    // Cloudflare WAF flags with a hard 403 block (verified against
    // vidfast.vc on 2026-11-05: headed+script=403, headed without=200).
    if (CONFIG.HEADLESS) {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }

    // Close initial blank page created by launchPersistentContext so Chromium starts with 0 idle tabs
    for (const p of context.pages()) {
      await p.close().catch(() => {});
    }

    // Auto reset the singleton context when it closes or crashes
    context.on("close", () => {
      console.log(
        "[BROWSER] Browser context closed or crashed. Resetting singleton...",
      );
      if (this.contextPromise) {
        this.contextPromise
          .then((ctx) => {
            if (ctx === context) {
              this.contextPromise = null;
              this.activeCount = 0;
            }
          })
          .catch(() => {
            this.contextPromise = null;
            this.activeCount = 0;
          });
      }
    });

    // Load auth state (per-domain files in auth/, with legacy auth.json fallback)
    await this.loadAuthState(userDataDir, context);

    return context;
  }

  /**
   * Load authentication state into the global browser context.
   *
   * Reads per-domain files from the `auth/` directory at the project root.
   * Each file is a Playwright storageState blob (`{ cookies, origins }`)
   * named after the target domain (e.g. `auth/dlhd.pk.json`). Files ending
   * in `.example.json` are skipped. Falls back to a single legacy `auth.json`
   * at the project root (or `userDataDir`) when `auth/` is absent, for
   * backward compatibility.
   */
  private async loadAuthState(
    userDataDir: string,
    context: BrowserContext,
  ): Promise<void> {
    const authDir = path.join(process.cwd(), "auth");
    if (fs.existsSync(authDir) && fs.statSync(authDir).isDirectory()) {
      const files = fs
        .readdirSync(authDir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"))
        .sort();

      let loaded = 0;
      for (const file of files) {
        const filePath = path.join(authDir, file);
        try {
          const authData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          const count = await this.applyAuthData(authData, context);
          console.log(
            `[BROWSER] Loaded auth from ${file} (${count.cookies} cookies, ${count.origins} origins)`,
          );
          loaded++;
        } catch (error) {
          console.error(`[BROWSER] Error loading ${filePath}:`, error);
        }
      }
      if (loaded > 0) {
        console.log(`[BROWSER] Loaded auth for ${loaded} domain(s) from auth/`);
      }
      return;
    }

    // Legacy fallback: single auth.json (project root, then userDataDir)
    let authPath = path.join(process.cwd(), "auth.json");
    if (!fs.existsSync(authPath)) {
      authPath = path.join(userDataDir, "auth.json");
    }
    if (fs.existsSync(authPath)) {
      try {
        const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        const count = await this.applyAuthData(authData, context);
        console.log(
          `[BROWSER] Loaded legacy ${path.basename(authPath)} (${count.cookies} cookies, ${count.origins} origins). Consider migrating to auth/<domain>.json.`,
        );
      } catch (error) {
        console.error(`[BROWSER] Error loading ${authPath}:`, error);
      }
    }
  }

  /**
   * Apply a single Playwright storageState blob to the given context.
   * Returns the number of cookies and origins applied for logging.
   */
  private async applyAuthData(
    authData: {
      cookies?: unknown[];
      origins?: Array<{ origin?: string; localStorage?: unknown[] }>;
    },
    context: BrowserContext,
  ): Promise<{ cookies: number; origins: number }> {
    let cookieCount = 0;
    if (Array.isArray(authData.cookies)) {
      await context.addCookies(
        authData.cookies as Parameters<BrowserContext["addCookies"]>[0],
      );
      cookieCount = authData.cookies.length;
    }

    let originCount = 0;
    if (Array.isArray(authData.origins)) {
      for (const originEntry of authData.origins) {
        if (originEntry.origin && Array.isArray(originEntry.localStorage)) {
          await context.addInitScript(
            (data: {
              origin: string;
              localStorage: Array<{ name: string; value: string }>;
            }) => {
              try {
                if (window.location.origin === data.origin) {
                  for (const item of data.localStorage) {
                    window.localStorage.setItem(item.name, item.value);
                  }
                }
              } catch (e) {
                console.error(
                  "[BROWSER] Failed to set localStorage in init script:",
                  e,
                );
              }
            },
            {
              origin: originEntry.origin,
              localStorage: originEntry.localStorage as Array<{
                name: string;
                value: string;
              }>,
            },
          );
          originCount++;
        }
      }
    }

    return { cookies: cookieCount, origins: originCount };
  }

  async close(): Promise<void> {
    const promise = this.contextPromise;
    this.contextPromise = null;
    this.activeCount = 0;
    if (promise) {
      try {
        const context = await promise;
        await context.close();
        console.log("[BROWSER] Browser context closed successfully.");
      } catch (e) {
        // Creation may have failed; nothing to close.
      }
    }
  }
}