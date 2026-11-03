import type { Page, Request, Response } from "patchright";
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
 * Detects whether a target URL is an embed player / stream container
 * (e.g. /embed/, /cv-embed/, /live-embed/, /player/, /play/, /v/, etc.).
 */
export function isEmbedPlayerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (/(?:^|\.)[a-z0-9-]*emb[a-z0-9-]*\.[a-z]+/i.test(parsed.hostname)) {
      return true;
    }
    if (
      parsed.searchParams.has("embed") ||
      parsed.searchParams.has("is_embed") ||
      parsed.searchParams.has("player")
    ) {
      return true;
    }
  } catch (_) {}
  return /\/(embed|cv-embed|live-embed|player|play|iframe|video|v|e)(\/|\.(?:php|html?)|[?#]|$)/i.test(
    url,
  );
}

const MEDIA_CHUNK_REGEX = /\.(ts|m4s|mp4|webm|mkv)($|\?)/i;

const AD_TRACKER_REGEX =
  /(?:disable-devtool|connatix\.com|rubiconproject\.com|pubmatic\.com|openx\.net|criteo\.com|adnxs\.com|3lift\.com|sharethrough\.com|contextweb\.com|bidswitch\.net|casalemedia\.com|sonobi\.com|loopme\.me|smaato\.net|inmobi\.com|smartadserver\.com|fwmrm\.net|adsco\.re|adscale\.de|1rx\.io|iqm\.com|bidgx\.com|adform\.net|stackadapt\.com|adsrvr\.org|ingage\.tech|yellowblue\.io|gumgum\.com|turn\.com|postrelease\.com|copper6\.com|id5-sync\.com|trustedstack\.com|media\.net|google-analytics\.com|doubleclick\.net|googletagmanager\.com|adservice|scorecardresearch|quantserve|popads|popunder|exoclick|histats\.com|trafficjunky)/i;

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
    forceEmbed: boolean = false,
    signal?: AbortSignal,
  ): Promise<RequestData[]> {
    if (signal?.aborted) {
      return [];
    }

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

    // If client cancels/disconnects while scraping, abort immediately to free Chromium slot
    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => {
        console.log(`[SCRAPER] Scrape cancelled/aborted by client for ${url}`);
        markDone();
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

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

      let targetOrigin = "";
      try {
        targetOrigin = new URL(url).origin;
      } catch (_) {}

      const isEmbedUrl = forceEmbed || isEmbedPlayerUrl(url);

      // Block ads, trackers, images, fonts, and actual video/audio chunks.
      // We only need the .m3u8 playlist URL, NOT the gigabytes of video decoding in RAM.
      await page.route("**/*", (route) => {
        const req = route.request();
        const type = req.resourceType();
        const reqUrl = req.url().toLowerCase();

        // Fulfill virtual origin-matched loader request
        if (isEmbedUrl && reqUrl.includes("/strix-embed-loader.html")) {
          return route
            .fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Live Stream</title></head><body style="margin:0;padding:0;overflow:hidden;background:#000;"><iframe src="${url.replace(/"/g, "&quot;")}" width="100%" height="100%" style="border:none;width:100vw;height:100vh;" allow="autoplay *; fullscreen *; encrypted-media *; picture-in-picture *" loading="eager"></iframe></body></html>`,
            })
            .catch(() => {});
        }

        // Never block target m3u8 playlists
        if (isM3u8StreamUrl(reqUrl)) {
          return route.continue().catch(() => {});
        }

        // Once we've already captured the target m3u8 playlist, abort all subsequent non-m3u8 requests
        if (isDone) {
          return route.abort().catch(() => {});
        }

        const shouldBlock =
          type === "image" ||
          type === "font" ||
          type === "stylesheet" ||
          MEDIA_CHUNK_REGEX.test(reqUrl) ||
          AD_TRACKER_REGEX.test(reqUrl);

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

      // Handle responses: detect mpegurl Content-Type or #EXTM3U text body for fetch/xhr requests
      page.on("response", (response: Response) => {
        const resUrl = response.url();
        const status = response.status();
        const req = response.request();
        const rType = req.resourceType();

        if (status >= 400 && isM3u8StreamUrl(resUrl)) {
          console.log(
            `[SCRAPER] Stream request returned HTTP ${status}: ${resUrl}`,
          );
        }

        const contentType = (
          response.headers()["content-type"] || ""
        ).toLowerCase();
        const isMpegUrl = contentType.includes("mpegurl");
        const isKnownM3u8 = isM3u8StreamUrl(resUrl);
        const isFetchOrXhr = rType === "fetch" || rType === "xhr";

        const isMediaOrAsset =
          contentType.includes("image/") ||
          contentType.includes("video/") ||
          contentType.includes("audio/") ||
          contentType.includes("javascript") ||
          contentType.includes("text/css") ||
          contentType.includes("font/");

        // Sniff if this is a known m3u8, mpegurl, or a candidate fetch/xhr request
        const shouldSniff =
          status >= 200 &&
          status < 300 &&
          (isKnownM3u8 || isMpegUrl || (isFetchOrXhr && !isMediaOrAsset));

        if (shouldSniff) {
          const p = (async () => {
            try {
              const text = await Promise.race([
                response.text(),
                new Promise<string>((_, reject) =>
                  trackedTimeout(
                    () => reject(new Error("Response body timeout")),
                    3000,
                  ),
                ),
              ]);

              const trimmed = text.trim();
              const hasExtM3u = trimmed.startsWith("#EXTM3U");

              if (hasExtM3u || isMpegUrl) {
                // Register or update stream target with its playlist body
                const existing = requestsMap.get(resUrl);
                if (existing) {
                  existing.body = text;
                } else {
                  requestsMap.set(resUrl, {
                    url: resUrl,
                    method: req.method(),
                    headers: req.headers(),
                    resource_type: req.resourceType(),
                    post_data: req.postData(),
                    body: text,
                  });
                }
                console.log(
                  `[SCRAPER] Captured stream target via response sniffing (${hasExtM3u ? "#EXTM3U" : "mpegurl"}): ${resUrl}`,
                );
                // Mark done immediately to complete scraping in 2-3s
                markDone();
              } else if (isKnownM3u8 && resolveM3u8Body) {
                const reqData = requestsMap.get(resUrl);
                if (reqData) {
                  reqData.body = text;
                }
              }
            } catch (_) {
              // Ignore body read errors for non-playlist or cancelled responses
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
                    const btns = document.querySelectorAll(selectors.join(", "));
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
      // If URL is an embed URL (e.g. /embed/, /cv-embed/, /player/), navigate via a virtual
      // origin-matched iframe container to satisfy sec-fetch-dest: iframe, CSP frame-ancestors,
      // and anti-direct-access checks.
      const loaderUrl =
        isEmbedUrl && targetOrigin
          ? `${targetOrigin}/strix-embed-loader.html`
          : null;

      const navigatePromise = page
        .goto(loaderUrl || url, {
          timeout: timeoutSec * 1000,
          waitUntil: "commit",
        })
        .catch((err) => {
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

      // If we haven't resolved yet, wait for the remaining timeout duration
      if (!isDone) {
        const elapsed = Date.now() - startTime;
        const remainingTimeout = (timeoutSec * 1000) - elapsed;
        if (remainingTimeout > 0) {
          await Promise.race([trackedSleep(remainingTimeout), donePromise]);
        }
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

      // Wait for any pending response body resolution promises to settle (or timeout after 2s).
      // If we already captured a stream target (m3u8 or #EXTM3U), skip waiting to prevent stalling.
      const hasCapturedStream = Array.from(requestsMap.values()).some(
        (r) => r.body?.includes("#EXTM3U") || isM3u8StreamUrl(r.url),
      );
      if (responsePromises.length > 0 && !hasCapturedStream) {
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
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }

      console.log(
        `[SCRAPER] Finished scraping ${url}, found ${requestsMap.size} requests`,
      );
      return Array.from(requestsMap.values());
    }, signal);
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