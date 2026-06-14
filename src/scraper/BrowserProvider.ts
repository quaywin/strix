import os from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { chromium } from "playwright";
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
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  window.chrome = { runtime: {} };
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
  private globalContext: BrowserContext | null = null;

  async getBrowserContext(): Promise<BrowserContext> {
    if (this.globalContext) return this.globalContext;

    const chromePath = CONFIG.CHROME_PATH;
    const userDataDir =
      CONFIG.USER_DATA_DIR ||
      path.join(os.tmpdir(), "playwright_profile_scrape_stream");

    const launchOptions = {
      headless: true,
      userAgent: USER_AGENT,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-site-isolation-trials",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-zygote",
      ],
    };

    if (chromePath) {
      (launchOptions as { executablePath?: string }).executablePath = chromePath;
    }

    this.globalContext = await chromium.launchPersistentContext(
      userDataDir,
      launchOptions,
    );
    await this.globalContext.addInitScript(STEALTH_INIT_SCRIPT);
    return this.globalContext;
  }

  async close(): Promise<void> {
    if (this.globalContext) {
      await this.globalContext.close();
      this.globalContext = null;
    }
  }
}
