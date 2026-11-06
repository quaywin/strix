import type { Frame, Page, Request, Response, Route } from "patchright";
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

/**
 * Validates whether a URL is a genuine .m3u8 playlist stream rather than
 * a tracking beacon, analytics image, or an embed player container.
 */
export function isM3u8StreamUrl(url: string): boolean {
  try {
    if (isEmbedPlayerUrl(url)) {
      return false;
    }
    const parsed = new URL(url);
    const pathnameLower = parsed.pathname.toLowerCase();
    if (
      pathnameLower.includes("ping.gif") ||
      pathnameLower.endsWith(".gif") ||
      pathnameLower.endsWith(".png") ||
      pathnameLower.endsWith(".jpg") ||
      pathnameLower.endsWith(".jpeg") ||
      pathnameLower.endsWith(".webp") ||
      pathnameLower.includes("/ping")
    ) {
      return false;
    }
    if (
      pathnameLower.includes(".m3u8") ||
      pathnameLower.includes("/m3u8") ||
      pathnameLower.includes(".m3u") ||
      /\/hls\d*\/.*\.txt$/i.test(pathnameLower) ||
      /\/(master|playlist|index|list|video)\.txt$/i.test(pathnameLower)
    ) {
      return true;
    }
    const format =
      parsed.searchParams.get("format") ||
      parsed.searchParams.get("type") ||
      parsed.searchParams.get("ext") ||
      parsed.searchParams.get("output");
    if (format && format.toLowerCase().includes("m3u8")) {
      return true;
    }
    return false;
  } catch (_) {
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
    return (
      lower.includes(".m3u8") ||
      lower.includes("/m3u8") ||
      /\/hls\d*\/.*\.txt($|\?)/i.test(lower) ||
      /\/(master|playlist|index|list|video)\.txt($|\?)/i.test(lower)
    );
  }
}

const MEDIA_CHUNK_REGEX = /\.(ts|m4s|mp4|webm|mkv)($|\?)/i;

/** Play-button selectors nudged by the stream-mode click loop. */
const STREAM_CLICK_SELECTORS = [
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

/** Play-button selectors nudged by the VOD-mode click+inspect loop. */
const VOD_CLICK_SELECTORS = [
  ".vjs-big-play-button",
  ".player-play-button",
  "#play-button",
  ".play-button",
  '[aria-label="Play"]',
  ".play-icon",
  ".jw-display-icon-container",
  ".jwplayer",
  ".art-video-player",
];

/**
 * Stall recovery for embeds with a server picker (vidnest's cloud menu:
 * Lamda / Zeta / Filxer / Ophim). When no video shows up after
 * SERVER_CYCLE_START_MS, click through the server options one by one every
 * SERVER_CYCLE_INTERVAL_MS until some backend emits a stream. A no-op on
 * providers without such a menu.
 */
const SERVER_CYCLE_START_MS = 8000;
const SERVER_CYCLE_INTERVAL_MS = 6000;
/** Menu open animation wait before a server radio can be activated. */
const SERVER_MENU_OPEN_WAIT_MS = 1200;

/**
 * MPEG-DASH manifest detection (e.g. vidlink.pro serves clear-DASH .mpd).
 * Matches URLs whose path ends in .mpd (query string allowed after it).
 */
export function isMpdStreamUrl(url: string): boolean {
  return /\.mpd($|\?)/i.test(url);
}

const AD_TRACKER_REGEX =
  /(?:disable-devtool|connatix\.com|rubiconproject\.com|pubmatic\.com|openx\.net|criteo\.com|adnxs\.com|3lift\.com|sharethrough\.com|contextweb\.com|bidswitch\.net|casalemedia\.com|sonobi\.com|loopme\.me|smaato\.net|inmobi\.com|smartadserver\.com|fwmrm\.net|adsco\.re|adscale\.de|1rx\.io|iqm\.com|bidgx\.com|adform\.net|stackadapt\.com|adsrvr\.org|ingage\.tech|yellowblue\.io|gumgum\.com|turn\.com|postrelease\.com|copper6\.com|id5-sync\.com|trustedstack\.com|media\.net|google-analytics\.com|doubleclick\.net|googletagmanager\.com|adservice|scorecardresearch|quantserve|popads|popunder|exoclick|histats\.com|trafficjunky)/i;

/**
 * Per-scrape session handed to the mode-specific handlers registered via
 * `withScrapeSession`. The session owns the done-signal, timer bookkeeping
 * and the background click-loop, so capture logic can stay pure.
 */
interface ScrapeSession {
  page: Page;
  markDone: () => void;
  isDone: () => boolean;
  donePromise: Promise<void>;
  trackedTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  trackedSleep: (ms: number) => Promise<void>;
  /** Response-body resolution promises; drained during teardown. */
  responsePromises: Promise<void>[];
  isEmbedUrl: boolean;
  /** Prebuilt origin-matched iframe loader page for embed navigation. */
  embedLoaderHtml: string;
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

  /**
   * Shared browser-scrape session: acquires a page from the browser pool,
   * wires the done-signal / abort / safety-timeout scaffolding, installs the
   * embed-loader route, runs navigation plus the background click loop, and
   * guarantees full teardown. Mode-specific capture handlers are registered
   * via `opts.registerHandlers`; the result is assembled from the caller's
   * own closures once the session settles.
   */
  private async withScrapeSession<T>(
    opts: {
      url: string;
      timeoutSec: number;
      logTag: string;
      loaderTitle: string;
      forceEmbed: boolean;
      signal?: AbortSignal;
      /** Max wait (ms) for pending response-body reads during teardown. */
      responseWaitMs: number;
      /** When provided, skips the response-promise wait if a stream was captured. */
      hasCapturedStream?: () => boolean;
      registerHandlers: (session: ScrapeSession) => void;
      processFrame: (frame: Frame, session: ScrapeSession) => Promise<void>;
    },
    assemble: () => T,
  ): Promise<T> {
    const { url, timeoutSec, logTag, signal } = opts;
    const activeTimeouts = new Set<NodeJS.Timeout>();
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

    let isDone = false;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((r) => {
      resolveDone = r;
    });
    const markDone = () => {
      if (isDone) return;
      isDone = true;
      resolveDone();
    };

    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => {
        console.log(
          `[${logTag}] Scrape cancelled/aborted by client for ${url}`,
        );
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
      console.log(`[${logTag}] Global safety timeout reached for ${url}`);
      markDone();
    }, (timeoutSec + 10) * 1000);

    let page: Page | null = null;
    let acquired = false;
    const popups = new Set<Page>();
    const responsePromises: Promise<void>[] = [];

    let targetOrigin = "";
    try {
      targetOrigin = new URL(url).origin;
    } catch (_) {}
    const isEmbedUrl = opts.forceEmbed || isEmbedPlayerUrl(url);
    const embedLoaderHtml = this.buildEmbedLoaderHtml(url, opts.loaderTitle);

    const session: ScrapeSession = {
      get page() {
        return page as Page;
      },
      markDone,
      isDone: () => isDone,
      donePromise,
      trackedTimeout,
      trackedSleep,
      responsePromises,
      isEmbedUrl,
      embedLoaderHtml,
    };

    try {
      const context = await this.browserProvider.acquireContext();
      acquired = true;
      page = await context.newPage();

      // Track and immediately close any popup tabs spawned by click-jacking
      page.on("popup", (popup) => {
        popups.add(popup);
        popup.close().catch(() => {}).finally(() => popups.delete(popup));
      });

      await opts.registerHandlers(session);

      const startTime = Date.now();
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
              `[${logTag}] Navigation error for ${url}: ${err.message}`,
            );
          }
        });

      // Background loop: click play controls / inspect frames every 500ms
      (async () => {
        while (!isDone && page && !page.isClosed()) {
          try {
            const frames = page.frames();
            await Promise.all(
              frames.map((frame) =>
                opts.processFrame(frame, session).catch(() => {}),
              ),
            );
          } catch (_) {
            // Ignore frame list retrieval errors
          }
          await Promise.race([trackedSleep(500), donePromise]);
        }
      })();

      await Promise.race([navigatePromise, donePromise]);

      // If we haven't resolved yet, wait for the remaining timeout duration
      if (!isDone) {
        const elapsed = Date.now() - startTime;
        const remainingTimeout = timeoutSec * 1000 - elapsed;
        if (remainingTimeout > 0) {
          await Promise.race([trackedSleep(remainingTimeout), donePromise]);
        }
      }
    } catch (e) {
      console.error(`[${logTag}] Error during scraping ${url}: ${e}`);
    } finally {
      // Mark done to release any pending promise races
      markDone();

      // Clear all active timeouts
      for (const id of activeTimeouts) {
        clearTimeout(id);
      }
      activeTimeouts.clear();

      // Wait for any pending response body resolution promises to settle
      // (bounded), unless the capture is already complete.
      if (
        responsePromises.length > 0 &&
        !(opts.hasCapturedStream?.() ?? false)
      ) {
        await Promise.race([
          Promise.all(responsePromises),
          new Promise((r) => setTimeout(r, opts.responseWaitMs)),
        ]).catch(() => {});
      }

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
          console.error(`[${logTag}] Error closing page: ${e}`);
        }
      }
      if (acquired) {
        await this.browserProvider.releaseContext();
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }

    return assemble();
  }

  /** Fulfills the virtual origin-matched embed loader request. Returns true when handled. */
  private tryFulfillEmbedLoader(
    route: Route,
    session: ScrapeSession,
    reqUrl: string,
  ): boolean {
    if (session.isEmbedUrl && reqUrl.includes("/strix-embed-loader.html")) {
      route
        .fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: session.embedLoaderHtml,
        })
        .catch(() => {});
      return true;
    }
    return false;
  }

  /** Builds the virtual origin-matched iframe loader page for embed navigation. */
  private buildEmbedLoaderHtml(url: string, title: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title></head><body style="margin:0;padding:0;overflow:hidden;background:#000;"><iframe src="${url.replace(/"/g, "&quot;")}" width="100%" height="100%" style="border:none;width:100vw;height:100vh;" allow="autoplay *; fullscreen *; encrypted-media *; picture-in-picture *" loading="eager"></iframe></body></html>`;
  }

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

      return await this.withScrapeSession(
        {
          url,
          timeoutSec,
          logTag: "SCRAPER",
          loaderTitle: "Live Stream",
          forceEmbed,
          signal,
          responseWaitMs: 2000,
          hasCapturedStream: () =>
            Array.from(requestsMap.values()).some(
              (r) =>
                r.body?.includes("#EXTM3U") ||
                isM3u8StreamUrl(r.url) ||
                isMpdStreamUrl(r.url),
            ),
          registerHandlers: (session) => {
            // Block ads, trackers, images, fonts, and actual video/audio chunks.
            // We only need the playlist URL, NOT the gigabytes of video decoding in RAM.
            session.page.route("**/*", (route) => {
              const req = route.request();
              const type = req.resourceType();
              const reqUrl = req.url().toLowerCase();

              // Fulfill virtual origin-matched loader request
              if (this.tryFulfillEmbedLoader(route, session, reqUrl)) return;

              // Never block target m3u8 playlists
              if (isM3u8StreamUrl(reqUrl)) {
                return route.continue().catch(() => {});
              }

              // Once we've already captured the target playlist, abort all subsequent requests
              if (session.isDone()) {
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

            // Capture m3u8/mpd playlist requests (never document navigations)
            session.page.on("request", (req: Request) => {
              const reqUrl = req.url();
              if (
                req.resourceType() !== "document" &&
                (isM3u8StreamUrl(reqUrl) || isMpdStreamUrl(reqUrl))
              ) {
                requestsMap.set(reqUrl, {
                  url: reqUrl,
                  method: req.method(),
                  headers: req.headers(),
                  resource_type: req.resourceType(),
                  post_data: req.postData(),
                });
                // Found the target playlist request, signal completion
                session.markDone();
              }
            });

            // Detect mpegurl Content-Type or #EXTM3U text body for fetch/xhr requests
            session.page.on("response", (response: Response) => {
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
              const isKnownMpd =
                isMpdStreamUrl(resUrl) || contentType.includes("dash+xml");
              const isFetchOrXhr = rType === "fetch" || rType === "xhr";

              const isMediaOrAsset =
                contentType.includes("image/") ||
                contentType.includes("video/") ||
                contentType.includes("audio/") ||
                contentType.includes("javascript") ||
                contentType.includes("text/css") ||
                contentType.includes("font/");

              // Sniff known playlists plus any non-asset fetch/xhr candidate
              const shouldSniff =
                status >= 200 &&
                status < 300 &&
                (isKnownM3u8 ||
                  isMpegUrl ||
                  isKnownMpd ||
                  (isFetchOrXhr && !isMediaOrAsset));

              if (shouldSniff) {
                const p = (async () => {
                  try {
                    const text = await Promise.race([
                      response.text(),
                      new Promise<string>((_, reject) =>
                        session.trackedTimeout(
                          () => reject(new Error("Response body timeout")),
                          3000,
                        ),
                      ),
                    ]);

                    const trimmed = text.trim();
                    const hasExtM3u = trimmed.startsWith("#EXTM3U");

                    if (hasExtM3u || isMpegUrl || isKnownMpd) {
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
                      session.markDone();
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
                session.responsePromises.push(p);
              }
            });
          },
          processFrame: async (frame) => {
            // Poll and click play buttons; nudge player APIs
            await frame.evaluate((selectors: string[]) => {
              const btns = document.querySelectorAll(selectors.join(", "));
              btns.forEach((btn) => {
                if (btn && typeof (btn as HTMLElement).click === "function") {
                  const style = window.getComputedStyle(btn);
                  if (style.display !== "none" && style.visibility !== "hidden") {
                    (btn as HTMLElement).click();
                  }
                }
              });

              // Trigger player APIs if present (JWPlayer / Clappr)
              try {
                const win = window as any;
                if (typeof win.jwplayer === "function") {
                  const jw =
                    win.jwplayer("player") ||
                    win.jwplayer("jwplayer") ||
                    win.jwplayer();
                  if (jw && typeof jw.play === "function") {
                    const state =
                      typeof jw.getState === "function" ? jw.getState() : "";
                    if (state !== "playing" && state !== "buffering") {
                      jw.play();
                    }
                  }
                }
                if (typeof win.Clappr === "object" || win.player?.play) {
                  win.player?.play?.();
                }
              } catch (_) {}
            }, STREAM_CLICK_SELECTORS);
          },
        },
        () => {
          console.log(
            `[SCRAPER] Finished scraping ${url}, found ${requestsMap.size} requests`,
          );
          return Array.from(requestsMap.values());
        },
      );
    }, signal);
  }

  /**
   * VOD-specialized scraper: captures a primary video stream (m3u8, mp4, mkv, webm)
   * along with all subtitle tracks (VTT, SRT) from network requests, DOM <track> tags,
   * and player runtimes (JWPlayer, Artplayer, VideoJS).
   */
  async collectVideo(
    url: string,
    timeoutSec: number = 20,
    forceEmbed: boolean = false,
    signal?: AbortSignal,
  ): Promise<RequestData | null> {
    if (signal?.aborted) {
      return null;
    }

    if (this.semaphore.activeCount >= this.semaphore.maxConcurrency) {
      console.log(
        `[SCRAPER-VOD] Concurrency limit (${this.semaphore.maxConcurrency}) reached. Queuing VOD scrape for ${url}...`,
      );
    }

    return this.semaphore.run(async () => {
      let capturedVideo: RequestData | null = null;
      let domVideoFallback: RequestData | null = null;
      // Server-cycling state (shared across frames; only one frame acts per interval)
      let cycleStartedAt = 0;
      let lastCycleAt = 0;
      let cycleIndex = 0;

      return await this.withScrapeSession(
        {
          url,
          timeoutSec,
          logTag: "SCRAPER-VOD",
          loaderTitle: "Video Player",
          forceEmbed,
          signal,
          // Drain window that lets the m3u8 body attach to the captured video
          responseWaitMs: 1000,
          registerHandlers: (s) => {
            s.page.route("**/*", (route) => {
              const req = route.request();
              const type = req.resourceType();
              const reqUrl = req.url().toLowerCase();

              if (this.tryFulfillEmbedLoader(route, s, reqUrl)) return;

              const isM3u8 = isM3u8StreamUrl(reqUrl);
              const isDirectMedia =
                /\.(mp4|mkv|webm|mpd)($|\?)/i.test(reqUrl) || type === "media";
              const isSegment = /\.(ts|m4s)($|\?)/i.test(reqUrl);

              if (isM3u8 || isDirectMedia) {
                return route.continue().catch(() => {});
              }

              // If we already verified primary video, abort all subsequent heavy video segments
              if (capturedVideo && isSegment) {
                return route.abort().catch(() => {});
              }

              if (s.isDone()) {
                return route.abort().catch(() => {});
              }

              const shouldBlock =
                type === "image" ||
                type === "font" ||
                type === "stylesheet" ||
                isSegment ||
                AD_TRACKER_REGEX.test(reqUrl);

              if (shouldBlock) {
                route.abort().catch(() => {});
              } else {
                route.continue().catch(() => {});
              }
            });

            // Capture video streams that actually succeed (HTTP 200 / 206)
            s.page.on("response", (response: Response) => {
              const resUrl = response.url();
              const status = response.status();
              const contentType = (
                response.headers()["content-type"] || ""
              ).toLowerCase();

              const isSegment = /\.(ts|m4s)($|\?)/i.test(resUrl);
              const isVideoResponse =
                (status === 200 || status === 206) &&
                (contentType.includes("video/") ||
                  contentType.includes("mpegurl") ||
                  contentType.includes("dash+xml") ||
                  /\.(m3u8|mp4|mkv|webm|mpd)($|\?)/i.test(resUrl) ||
                  isM3u8StreamUrl(resUrl) ||
                  (domVideoFallback && resUrl === domVideoFallback.url) ||
                  response.request().resourceType() === "media") &&
                !isSegment &&
                !resUrl.includes("ping") &&
                !resUrl.endsWith(".gif") &&
                !resUrl.endsWith(".png");

              if (!capturedVideo && isVideoResponse) {
                capturedVideo = {
                  url: resUrl,
                  method: response.request().method(),
                  headers: response.request().headers(),
                  resource_type: response.request().resourceType(),
                  post_data: response.request().postData(),
                };
                console.log(
                  `[SCRAPER-VOD] Verified working video stream (HTTP ${status}): ${resUrl}`,
                );
                s.markDone();
              }

              // Attach playlist body to the captured video (or capture it standalone)
              const isMpegUrl = contentType.includes("mpegurl");
              const isKnownM3u8 = isM3u8StreamUrl(resUrl);

              if (status >= 200 && status < 300 && (isKnownM3u8 || isMpegUrl)) {
                const p = (async () => {
                  try {
                    const text = await Promise.race([
                      response.text(),
                      new Promise<string>((_, reject) =>
                        s.trackedTimeout(
                          () => reject(new Error("Response body timeout")),
                          3000,
                        ),
                      ),
                    ]);
                    const trimmed = text.trim();
                    if (trimmed.startsWith("#EXTM3U") || isMpegUrl) {
                      if (capturedVideo && capturedVideo.url === resUrl) {
                        capturedVideo.body = text;
                      } else if (!capturedVideo) {
                        capturedVideo = {
                          url: resUrl,
                          method: response.request().method(),
                          headers: response.request().headers(),
                          resource_type: response.request().resourceType(),
                          post_data: response.request().postData(),
                          body: text,
                        };
                        console.log(
                          `[SCRAPER-VOD] Captured m3u8 body: ${resUrl}`,
                        );
                        s.markDone();
                      }
                    }
                  } catch (_) {}
                })();
                s.responsePromises.push(p);
              }
            });
          },
          processFrame: async (frame) => {
            // Stall recovery: cycle the embed's server picker when nothing loads.
            // Timed from the first frame tick so the default server gets its
            // SERVER_CYCLE_START_MS grace period before we start switching.
            const now = Date.now();
            if (!cycleStartedAt) cycleStartedAt = now;
            if (
              !capturedVideo &&
              !domVideoFallback &&
              now - cycleStartedAt >= SERVER_CYCLE_START_MS &&
              now - lastCycleAt >= SERVER_CYCLE_INTERVAL_MS
            ) {
              lastCycleAt = now;
              // 1) Open the server menu (skipped when it is already open)
              await frame
                .evaluate(() => {
                  const menuButton = document.querySelector(
                    '[class*="ServerMenu"][class*="menuButton"]',
                  ) as HTMLElement | null;
                  const menuContent = document.querySelector(
                    '[class*="ServerMenu"][class*="menuContent"]',
                  );
                  if (
                    menuButton &&
                    (!menuContent ||
                      menuContent.getBoundingClientRect().width === 0)
                  ) {
                    menuButton.click();
                  }
                })
                .catch(() => {});
              // 2) Let the menu finish animating before touching the radios
              await new Promise((r) =>
                setTimeout(r, SERVER_MENU_OPEN_WAIT_MS),
              );
              // 3) Dispatch a full pointer sequence on the next server radio.
              //    Start at index 1 — index 0 is the default server that already stalled.
              const switched = await frame.evaluate((idx: number) => {
                const radios = Array.from(
                  document.querySelectorAll('[class*="ServerMenu"]'),
                ).filter((el) => {
                  const cls = String(el.className);
                  // Only the radio rows, not the group/label/sub-label shells
                  return (
                    cls.includes("radio") &&
                    !cls.includes("Label") &&
                    !cls.includes("Group") &&
                    !cls.includes("Sub")
                  );
                }) as HTMLElement[];
                const skipDefault = radios.length > 1 ? 1 : 0;
                const target =
                  radios[skipDefault + (idx % (radios.length - skipDefault))];
                if (!target) return false;

                const eventOpts = {
                  bubbles: true,
                  cancelable: true,
                  button: 0,
                  buttons: 1,
                };
                target.dispatchEvent(
                  new PointerEvent("pointerdown", {
                    ...eventOpts,
                    pointerId: 1,
                    pointerType: "mouse",
                    isPrimary: true,
                  } as PointerEventInit),
                );
                target.dispatchEvent(new MouseEvent("mousedown", eventOpts));
                target.dispatchEvent(
                  new PointerEvent("pointerup", {
                    ...eventOpts,
                    pointerId: 1,
                    pointerType: "mouse",
                    isPrimary: true,
                  } as PointerEventInit),
                );
                target.dispatchEvent(new MouseEvent("mouseup", eventOpts));
                target.click();
                return true;
              }, cycleIndex);
              if (switched) {
                cycleIndex++;
                console.log(
                  `[SCRAPER-VOD] No stream yet — cycling embed server (option #${cycleIndex})`,
                );
              }
            }

            // Click play controls; observe the DOM video src as a fallback capture
            const videoSrc = await frame.evaluate((selectors: string[]) => {
              const btns = document.querySelectorAll(selectors.join(", "));
              btns.forEach((btn) => {
                if (btn && typeof (btn as HTMLElement).click === "function") {
                  const style = window.getComputedStyle(btn);
                  if (style.display !== "none" && style.visibility !== "hidden") {
                    (btn as HTMLElement).click();
                  }
                }
              });

              // Trigger player APIs
              try {
                const win = window as any;
                if (typeof win.jwplayer === "function") {
                  const jw = win.jwplayer("player") || win.jwplayer("jwplayer") || win.jwplayer();
                  if (jw && typeof jw.play === "function") {
                    const state = typeof jw.getState === "function" ? jw.getState() : "";
                    if (state !== "playing" && state !== "buffering") {
                      jw.play();
                    }
                  }
                }
              } catch (_) {}

              const videoEl = document.querySelector("video");
              const src = videoEl?.currentSrc || videoEl?.src || "";
              return src.startsWith("http") && !src.startsWith("blob:") ? src : "";
            }, VOD_CLICK_SELECTORS);

            if (!capturedVideo && !domVideoFallback && videoSrc) {
              domVideoFallback = {
                url: videoSrc,
                method: "GET",
                headers: {},
                resource_type: "media",
                post_data: null,
              };
              console.log(
                `[SCRAPER-VOD] Observed video src from DOM: ${videoSrc}`,
              );

              // Allow a brief debounce (600ms) for the network response listener to capture
              // the request headers and m3u8 playlist body if available, then markDone so
              // the scraper doesn't stall for the remaining 20s timeout.
              s.trackedTimeout(() => {
                if (!s.isDone()) {
                  s.markDone();
                }
              }, 600);
            }
          },
        },
        () => {
          if (!capturedVideo && domVideoFallback) {
            capturedVideo = domVideoFallback;
          }

          console.log(
            `[SCRAPER-VOD] Finished scraping VOD ${url}: video=${Boolean(capturedVideo)}`,
          );

          return capturedVideo;
        },
      );
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