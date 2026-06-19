import type { Frame, Page, Request, Response } from "playwright";
import { CONFIG } from "../config";
import { PlaywrightBrowserProvider } from "./BrowserProvider";

export interface RequestData {
  url: string;
  method: string;
  headers: Record<string, string>;
  resource_type: string;
  post_data: string | null;
  body?: string;
}

/**
 * Captures network requests made by a page after navigation.
 *
 * This is the "generic" mode from qIPTV's ScraperEngine: it matches any
 * `.m3u8` URL regardless of the `/hls/` path segment, and resolves as soon
 * as the first `.m3u8` request is observed (no subtitle requirement).
 */
export class ScraperEngine {
  private browserProvider = new PlaywrightBrowserProvider();

  async collectRequests(
    url: string,
    timeoutSec: number = CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
    resolveM3u8Body: boolean = false,
  ): Promise<RequestData[]> {
    const requestsMap = new Map<string, RequestData>();
    const responsePromises: Promise<void>[] = [];
    const activeTimeouts = new Set<NodeJS.Timeout>();
    let page: Page | null = null;
    let acquired = false;

    // Helper to track timeouts for easy cleanup
    const trackedTimeout = (fn: () => void, ms: number): NodeJS.Timeout => {
      const id = setTimeout(() => {
        activeTimeouts.delete(id);
        fn();
      }, ms);
      activeTimeouts.add(id);
      return id;
    };

    const trackedSleep = (ms: number): Promise<void> =>
      new Promise((r) => trackedTimeout(r, ms));

    // A signal promise to resolve the function when we are done (success or timeout)
    let resolveDone: () => void;
    const donePromise = new Promise<void>((r) => {
      resolveDone = r;
    });

    let isDone = false;
    const markDone = () => {
      if (isDone) return;
      isDone = true;
      resolveDone();
    };

    // Global safety timeout
    trackedTimeout(() => {
      console.log(`[SCRAPER] Global safety timeout reached for ${url}`);
      markDone();
    }, (timeoutSec + 10) * 1000);

    try {
      const context = await this.browserProvider.acquireContext();
      acquired = true;
      page = await context.newPage();

      // Block ads, trackers, images, and fonts to save memory and bandwidth
      await page.route("**/*", (route) => {
        const req = route.request();
        const type = req.resourceType();
        const reqUrl = req.url().toLowerCase();

        const shouldBlock =
          type === "image" ||
          type === "font" ||
          reqUrl.includes("google-analytics.com") ||
          reqUrl.includes("doubleclick.net") ||
          reqUrl.includes("adservice") ||
          reqUrl.includes("scorecardresearch") ||
          reqUrl.includes("quantserve") ||
          reqUrl.includes("popads") ||
          reqUrl.includes("popunder") ||
          reqUrl.includes("exoclick");

        if (shouldBlock) {
          route.abort().catch(() => {});
        } else {
          route.continue().catch(() => {});
        }
      });

      // Handle requests
      page.on("request", (req: Request) => {
        const reqUrl = req.url();
        if (reqUrl.includes("index.m3u8")) {
          requestsMap.set(reqUrl, {
            url: reqUrl,
            method: req.method(),
            headers: req.headers(),
            resource_type: req.resourceType(),
            post_data: req.postData(),
          });
          // Found the target m3u8 request, signal completion
          markDone();
        }
      });

      // Handle responses if body resolution is required
      page.on("response", (response: Response) => {
        const resUrl = response.url();
        const status = response.status();

        if (status >= 400) {
          console.log(`[BROWSER HTTP ERROR] ${status} for URL: ${resUrl}`);
        }

        if (resolveM3u8Body && resUrl.includes(".m3u8")) {
          // If the request isn't registered yet, pre-register it to avoid race condition
          if (!requestsMap.has(resUrl)) {
            const req = response.request();
            requestsMap.set(resUrl, {
              url: resUrl,
              method: req.method(),
              headers: req.headers(),
              resource_type: req.resourceType(),
              post_data: req.postData(),
            });
          }

          const p = (async () => {
            try {
              const text = await Promise.race([
                response.text(),
                new Promise<string>((_, reject) =>
                  trackedTimeout(
                    () => reject(new Error("Response body timeout")),
                    5000,
                  ),
                ),
              ]);
              const reqData = requestsMap.get(resUrl);
              if (reqData) {
                reqData.body = text;
              }
            } catch (e) {
              console.warn(
                `[SCRAPER] Failed to get response body for ${resUrl}: ${(e as Error).message}`,
              );
            }
          })();
          responsePromises.push(p);
        }
      });

      // Start play button clicker background job (polling click)
      const clickPlayJob = async () => {
        const selectors = [
          ".vjs-big-play-button",
          ".player-play-button",
          "#play-button",
          ".play-button",
          '[aria-label="Play"]',
          ".fptplay-player-play",
          ".play-icon",
        ];

        // Poll and click play buttons every 500ms for up to 8 seconds
        for (let i = 0; i < 16; i++) {
          if (isDone || !page) break;

          try {
            const frames = page.frames();
            await Promise.all(
              frames.map(async (frame) => {
                try {
                  await frame.evaluate((selectors: string[]) => {
                    for (const selector of selectors) {
                      const btns = document.querySelectorAll(selector);
                      btns.forEach((btn) => {
                        if (
                          btn &&
                          typeof (btn as HTMLElement).click === "function"
                        ) {
                          const style = window.getComputedStyle(btn);
                          if (
                            style.display !== "none" &&
                            style.visibility !== "hidden"
                          ) {
                            (btn as HTMLElement).click();
                          }
                        }
                      });
                    }
                  }, selectors);
                } catch (e) {
                  // Ignore frame evaluation errors
                }
              }),
            );
          } catch (e) {
            // Ignore frame list retrieval errors
          }

          await Promise.race([trackedSleep(500), donePromise]);
        }
      };

      // Start page navigation
      const navigatePromise = page
        .goto(url, {
          timeout: timeoutSec * 1000,
          waitUntil: "domcontentloaded",
        })
        .catch((err) => {
          if (!isDone) {
            console.error(
              `[SCRAPER] Navigation error for ${url}: ${err.message}`,
            );
          }
        });

      // Execute navigation and click-play polling in parallel, racing with donePromise
      await Promise.race([
        Promise.all([navigatePromise, clickPlayJob()]),
        donePromise,
      ]);

      // If we haven't resolved yet, wait a short additional time for requests to complete
      if (!isDone) {
        await Promise.race([trackedSleep(3000), donePromise]);
      }
    } catch (e) {
      console.error(`[SCRAPER] Error during scraping ${url}: ${e}`);
    } finally {
      // Mark done to release any pending promise races
      markDone();

      // Clear all active timeouts
      for (const id of activeTimeouts) {
        clearTimeout(id);
      }
      activeTimeouts.clear();

      // Wait for any pending response body resolution promises to settle (or timeout after 2s)
      if (responsePromises.length > 0) {
        await Promise.race([
          Promise.all(responsePromises),
          new Promise((r) => setTimeout(r, 2000)),
        ]).catch(() => {});
      }

      // Clean up browser page and context
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.error(`[SCRAPER] Error closing page: ${e}`);
        }
      }
      if (acquired) {
        await this.browserProvider.releaseContext();
      }
    }

    console.log(
      `[SCRAPER] Finished scraping ${url}, found ${requestsMap.size} requests`,
    );
    return Array.from(requestsMap.values());
  }

  /**
   * Eagerly initialize the browser context and load auth state so the first
   * real request does not pay the startup cost. Safe to call multiple times;
   * the underlying provider dedups via a promise-based singleton.
   */
  async warmup(): Promise<void> {
    await this.browserProvider.acquireContext();
    await this.browserProvider.releaseContext();
  }

  async close(): Promise<void> {
    await this.browserProvider.close();
  }
}

export const scraperEngine = new ScraperEngine();
