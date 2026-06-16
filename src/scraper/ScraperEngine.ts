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
  ): Promise<RequestData[]> {
    const requests: RequestData[] = [];
    const responsePromises: Promise<void>[] = [];
    let page: Page | null = null;
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

    return new Promise((resolve) => {
      let resolved = false;
      (async () => {
        try {
          const context = await this.browserProvider.getBrowserContext();
          page = await context.newPage();

          // Log browser console errors/warnings and uncaught page exceptions
          page.on("console", (msg) => {
            const type = msg.type();
            if (type === "error" || type === "warning") {
              console.log(
                `[BROWSER CONSOLE] [${type.toUpperCase()}] ${msg.text()}`,
              );
            }
          });

          page.on("pageerror", (err) => {
            console.error(`[BROWSER ERROR] ${err.message}`);
          });

          const cleanup = async () => {
            for (const id of activeTimeouts) clearTimeout(id);
            activeTimeouts.clear();
            if (page) {
              try {
                await page.close();
                page = null;
              } catch (e) {
                console.error(`[SCRAPER] Error closing page: ${e}`);
              }
            }
          };

          const finalResolve = async () => {
            if (resolved) return;
            resolved = true;
            console.log(
              `[SCRAPER] m3u8 captured or timeout reached for ${url}`,
            );

            await Promise.race([
              Promise.all(responsePromises),
              trackedSleep(2000),
            ]);
            await cleanup();
            resolve(requests);
          };

          trackedTimeout(
            () => {
              console.log(`[SCRAPER] Global safety timeout reached for ${url}`);
              finalResolve();
            },
            (timeoutSec + 10) * 1000,
          );

          const handleRequest = (req: Request) => {
            const reqUrl = req.url();
            if (
              reqUrl.includes(".m3u8") ||
              reqUrl.includes(".vtt") ||
              reqUrl.includes(".srt") ||
              reqUrl.match(/\.(mp4|mkv|webm|avi|mov|flv)(\?|$)/i)
            ) {
              requests.push({
                url: reqUrl,
                method: req.method(),
                headers: req.headers(),
                resource_type: req.resourceType(),
                post_data: req.postData(),
              });
              if (
                reqUrl.includes("index.m3u8") ||
                reqUrl.includes("playlist.m3u8")
              ) {
                finalResolve();
              }
            }
          };

          const handleResponse = (response: Response) => {
            const resUrl = response.url();
            const status = response.status();

            if (status >= 400) {
              console.log(`[BROWSER HTTP ERROR] ${status} for URL: ${resUrl}`);
            }

            if (resUrl.includes(".m3u8")) {
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
                  const req = requests.find((r) => r.url === resUrl);
                  if (req) {
                    req.body = text;
                  }
                } catch (e) {
                  console.warn(
                    `[SCRAPER] Failed to get response body for ${resUrl}: ${(e as Error).message}`,
                  );
                }
              })();
              responsePromises.push(p);
            }
          };

          page.on("request", handleRequest);
          page.on("response", handleResponse);

          await page.goto(url, {
            timeout: timeoutSec * 1000,
            waitUntil: "domcontentloaded",
          });

          if (!resolved) {
            await trackedSleep(5000);
          }

          if (!resolved) {
            const clickPlay = async (frame: Frame) => {
              try {
                const selectors = [
                  ".vjs-big-play-button",
                  ".player-play-button",
                  "#play-button",
                  ".play-button",
                  '[aria-label="Play"]',
                ];
                await Promise.race([
                  frame.evaluate((selectors: string[]) => {
                    for (const selector of selectors) {
                      const btns = document.querySelectorAll(selector);
                      btns.forEach((btn) => {
                        if (
                          btn &&
                          typeof (btn as HTMLElement).click === "function"
                        ) {
                          (btn as HTMLElement).click();
                        }
                      });
                    }
                  }, selectors),
                  new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error("Frame eval timeout")),
                      2000,
                    ),
                  ),
                ]);
              } catch (e) {
                console.debug(
                  `[SCRAPER] Failed to click play button in frame: ${(e as Error).message}`,
                );
              }
            };

            const frames = page ? page.frames() : [];
            await Promise.all(frames.map((frame: Frame) => clickPlay(frame)));
          }

          if (!resolved && page) {
            await trackedSleep(3000);
          }

          await finalResolve();
        } catch (e) {
          console.error(`[SCRAPER] Error during scraping ${url}: ${e}`);
          resolve([]);
        }
      })();
    });
  }

  /**
   * Eagerly initialize the browser context and load auth state so the first
   * real request does not pay the startup cost. Safe to call multiple times;
   * the underlying provider dedups via a promise-based singleton.
   */
  async warmup(): Promise<void> {
    await this.browserProvider.getBrowserContext();
  }

  async close(): Promise<void> {
    await this.browserProvider.close();
  }
}

export const scraperEngine = new ScraperEngine();
