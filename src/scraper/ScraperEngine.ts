import type { Frame, Page, Request, Response } from "playwright";
import { CONFIG } from "../config";
import { Semaphore } from "../utils/semaphore";
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
 * Validates whether a URL is a genuine .m3u8 playlist stream rather than
 * a tracking beacon or analytics image (e.g. ping.gif?mu=...m3u8).
 */
export function isM3u8StreamUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (
    lower.includes("ping.gif") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".webp") ||
    lower.includes("/ping")
  ) {
    return false;
  }
  return lower.includes(".m3u8") || lower.includes("/m3u8");
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
  private semaphore = new Semaphore(CONFIG.SCRAPER.MAX_CONCURRENT);

  async collectRequests(
    url: string,
    timeoutSec: number = CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
    resolveM3u8Body: boolean = false,
  ): Promise<RequestData[]> {
    if (this.semaphore.activeCount >= this.semaphore.maxConcurrency) {
      console.log(
        `[SCRAPER] Concurrency limit (${this.semaphore.maxConcurrency}) reached. Queuing scrape for ${url} (queue position: ${this.semaphore.queuedCount + 1})...`,
      );
    }

    return this.semaphore.run(async () => {
      const requestsMap = new Map<string, RequestData>();
      const responsePromises: Promise<void>[] = [];
      const activeTimeouts = new Set<NodeJS.Timeout>();
      const popups = new Set<Page>();
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

      // Track and immediately close any popup tabs spawned by click-jacking or target="_blank"
      page.on("popup", (popup) => {
        popups.add(popup);
        popup.close().catch(() => {}).finally(() => popups.delete(popup));
      });

      // Block ads, trackers, images, fonts, and actual video/audio chunks.
      // We only need the .m3u8 playlist URL, NOT the gigabytes of video decoding in RAM.
      await page.route("**/*", (route) => {
        const req = route.request();
        const type = req.resourceType();
        const reqUrl = req.url().toLowerCase();

        // Never block target m3u8 playlists
        if (isM3u8StreamUrl(reqUrl)) {
          return route.continue().catch(() => {});
        }

        // Once we've already captured the target m3u8 playlist, abort all subsequent non-m3u8 requests
        if (isDone) {
          return route.abort().catch(() => {});
        }

        const isMediaChunk =
          type === "media" ||
          reqUrl.includes(".ts?") ||
          reqUrl.endsWith(".ts") ||
          reqUrl.includes(".m4s?") ||
          reqUrl.endsWith(".m4s") ||
          reqUrl.includes(".mp4?") ||
          reqUrl.endsWith(".mp4") ||
          reqUrl.includes(".webm?") ||
          reqUrl.endsWith(".webm");

        const isAdOrTracker =
          reqUrl.includes("disable-devtool") ||
          reqUrl.includes("connatix.com") ||
          reqUrl.includes("rubiconproject.com") ||
          reqUrl.includes("pubmatic.com") ||
          reqUrl.includes("openx.net") ||
          reqUrl.includes("criteo.com") ||
          reqUrl.includes("adnxs.com") ||
          reqUrl.includes("3lift.com") ||
          reqUrl.includes("sharethrough.com") ||
          reqUrl.includes("contextweb.com") ||
          reqUrl.includes("bidswitch.net") ||
          reqUrl.includes("casalemedia.com") ||
          reqUrl.includes("sonobi.com") ||
          reqUrl.includes("loopme.me") ||
          reqUrl.includes("smaato.net") ||
          reqUrl.includes("inmobi.com") ||
          reqUrl.includes("smartadserver.com") ||
          reqUrl.includes("fwmrm.net") ||
          reqUrl.includes("adsco.re") ||
          reqUrl.includes("adscale.de") ||
          reqUrl.includes("1rx.io") ||
          reqUrl.includes("iqm.com") ||
          reqUrl.includes("bidgx.com") ||
          reqUrl.includes("adform.net") ||
          reqUrl.includes("stackadapt.com") ||
          reqUrl.includes("adsrvr.org") ||
          reqUrl.includes("ingage.tech") ||
          reqUrl.includes("yellowblue.io") ||
          reqUrl.includes("gumgum.com") ||
          reqUrl.includes("turn.com") ||
          reqUrl.includes("postrelease.com") ||
          reqUrl.includes("copper6.com") ||
          reqUrl.includes("id5-sync.com") ||
          reqUrl.includes("trustedstack.com") ||
          reqUrl.includes("media.net") ||
          reqUrl.includes("google-analytics.com") ||
          reqUrl.includes("doubleclick.net") ||
          reqUrl.includes("googletagmanager.com") ||
          reqUrl.includes("adservice") ||
          reqUrl.includes("scorecardresearch") ||
          reqUrl.includes("quantserve") ||
          reqUrl.includes("popads") ||
          reqUrl.includes("popunder") ||
          reqUrl.includes("exoclick") ||
          reqUrl.includes("histats.com") ||
          reqUrl.includes("trafficjunky");

        const shouldBlock =
          isMediaChunk ||
          isAdOrTracker ||
          type === "image" ||
          type === "font";

        if (shouldBlock) {
          route.abort().catch(() => {});
        } else {
          route.continue().catch(() => {});
        }
      });

      // Handle requests
      page.on("request", (req: Request) => {
        const reqUrl = req.url();
        if (isM3u8StreamUrl(reqUrl)) {
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

        if (resolveM3u8Body && isM3u8StreamUrl(resUrl)) {
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
          // JWPlayer selectors
          ".jw-display-icon-container",
          ".jw-icon-display",
          ".jw-preview",
          ".jw-button-color",
          ".jwplayer",
        ];

        // Poll and click play buttons every 500ms while scraping is active
        while (!isDone && page && !page.isClosed()) {
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

                    // Check and trigger player APIs if present (e.g. JWPlayer)
                    try {
                      const win = window as any;
                      if (typeof win.jwplayer === "function") {
                        const jw =
                          win.jwplayer("player") ||
                          win.jwplayer("jwplayer") ||
                          win.jwplayer();
                        if (jw && typeof jw.play === "function") {
                          const state =
                            typeof jw.getState === "function"
                              ? jw.getState()
                              : "";
                          if (state !== "playing" && state !== "buffering") {
                            jw.play();
                          }
                        }
                      }
                      if (typeof win.Clappr === "object" || win.player?.play) {
                        win.player?.play?.();
                      }
                    } catch (_) {}
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

      const startTime = Date.now();

      // Start page navigation
      // If URL is an embed URL (e.g. /embed/, /e/, /player/), wrap in an iframe container
      // to bypass anti-direct-access checks (where players require window.top !== window.self)
      const isEmbedUrl = /\/(embed|e|player)(\/|\.php|\?|$)/i.test(url);
      const navigatePromise = (
        isEmbedUrl
          ? page.setContent(
              `<!DOCTYPE html><html><head><title>Strix Embed Loader</title></head><body style="margin:0;padding:0;overflow:hidden;background:#000;"><iframe src="${url}" width="100%" height="100%" style="border:none;width:100vw;height:100vh;" allow="autoplay; fullscreen; encrypted-media"></iframe></body></html>`,
              { timeout: timeoutSec * 1000, waitUntil: "domcontentloaded" },
            )
          : page.goto(url, {
              timeout: timeoutSec * 1000,
              waitUntil: "domcontentloaded",
            })
      ).catch((err) => {
        if (!isDone) {
          console.error(
            `[SCRAPER] Navigation error for ${url}: ${err.message}`,
          );
        }
      });

      // Start clickPlayJob in background (non-blocking)
      clickPlayJob();

      // Execute navigation and wait for donePromise to resolve
      await Promise.race([navigatePromise, donePromise]);

      // If we haven't resolved yet, wait for the remaining timeout duration (minimum 3 seconds fallback)
      if (!isDone) {
        const elapsed = Date.now() - startTime;
        const remainingTimeout = Math.max(3000, (timeoutSec * 1000) - elapsed);
        await Promise.race([trackedSleep(remainingTimeout), donePromise]);
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

      // Clean up popups, browser page, and context
      if (popups.size > 0) {
        for (const p of popups) {
          if (!p.isClosed()) {
            await p.close().catch(() => {});
          }
        }
        popups.clear();
      }

      if (page && !page.isClosed()) {
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
    });
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