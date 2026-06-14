import { CONFIG } from "../config";
import { logger } from "../logger";
import { scraperEngine } from "../scraper/ScraperEngine";

// Tiny in-process TTL cache. We only cache one thing: the extracted stream URL
// per source page. Signed m3u8 URLs typically carry short-lived ?expires= style
// tokens, so we keep the TTL short (default 5 min, see CONFIG.CACHE_TTL_MS).
const cache = new Map<string, { value: string; expiresAt: number }>();

function getCached(key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached(key: string, value: string, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Thrown when the scraper could not find any playable stream URL on the
 * target page. Callers can distinguish this from server-side failures
 * (network errors, scraper crashes) and map it to a 404.
 */
export class NoSourceFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSourceFoundError";
  }
}

export class ScraperService {
  /**
   * Visits the given page in a real (stealth) browser, waits for media
   * requests, and returns the best .m3u8 (or mp4/mkv as a fallback) URL it
   * can find. Result is cached for CONFIG.CACHE_TTL_MS.
   */
  /**
   * Removes the cached stream URL for a given source page. Used by callers
   * (e.g. the proxy handler) when a previously cached URL turns out to be
   * stale (e.g. upstream returned 403) so the next extractStreamUrl() call
   * performs a fresh scrape.
   */
  invalidateCache(url: string): void {
    cache.delete(`extract:${url}`);
  }

  async extractStreamUrl(url: string): Promise<string> {
    const cacheKey = `extract:${url}`;
    const cached = getCached(cacheKey);
    if (cached) {
      logger.info(`Returning cached stream URL for: ${url}`, "ScraperService");
      return cached;
    }

    logger.info(`Extracting raw stream URL for: ${url}`, "ScraperService");

    const requests = await scraperEngine.collectRequests(url);

    // Prefer master > playlist > mono > any m3u8 > mp4/mkv.
    // ping.gif is a common analytics beacon that falsely matches .m3u8 via
    // query params on some CDNs, so we explicitly exclude it.
    const selectedReq =
      requests.find(
        (r) => r.url.includes("master.m3u8") && !r.url.includes("ping.gif"),
      ) ??
      requests.find(
        (r) => r.url.includes("playlist.m3u8") && !r.url.includes("ping.gif"),
      ) ??
      requests.find(
        (r) => r.url.includes("mono.m3u8") && !r.url.includes("ping.gif"),
      ) ??
      requests.find(
        (r) => r.url.includes(".m3u8") && !r.url.includes("ping.gif"),
      ) ??
      requests.find(
        (r) =>
          (r.url.includes(".mp4") || r.url.includes(".mkv")) &&
          !r.url.includes("ping.gif"),
      );

    logger.info(
      `Total requests captured: ${requests.length}`,
      "ScraperService",
    );

    if (!selectedReq) {
      requests.length = 0;
      throw new NoSourceFoundError(
        "No m3u8/video source found - site may be down or content removed",
      );
    }

    const streamUrl = selectedReq.url;
    requests.length = 0;

    setCached(cacheKey, streamUrl, CONFIG.CACHE_TTL_MS);
    logger.info(`Extracted stream URL: ${streamUrl}`, "ScraperService");
    return streamUrl;
  }
}

export const scraperService = new ScraperService();
