import { CONFIG } from "../config";
import { logger } from "../logger";
import { StrmFreeExtractor } from "../scraper/extractors/StrmFreeExtractor";
import { scraperEngine } from "../scraper/ScraperEngine";
import { smartFetch } from "../utils/http";

class TtlCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private defaultTtlMs: number,
    private maxSize: number = CONFIG.CACHE_MAX_ITEMS,
  ) {
    // Periodic cleanup every 10 minutes to avoid memory leaks
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    // Allow Node/Bun process to exit even if interval is active
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === "function") {
      this.cleanupInterval.unref();
    }
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Evict oldest entry (first key in Map insertion order) to cap memory usage
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

export interface ExtractedStreamResult {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

// Global cache instance
const streamCache = new TtlCache<ExtractedStreamResult>(CONFIG.CACHE_TTL_MS);

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

const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
]);

export class ScraperService {
  // Deduplicates concurrent in-flight scrapes for the exact same stream (Thundering Herd protection)
  private inFlightScrapes = new Map<string, Promise<ExtractedStreamResult>>();

  /**
   * Removes the cached stream URL for a given source page. Used by callers
   * (e.g. the proxy handler) when a previously cached URL turns out to be
   * stale (e.g. upstream returned 403) so the next extractStream() call
   * performs a fresh scrape.
   */
  invalidateCache(url: string): void {
    streamCache.deletePrefix(`extract:${url}`);
  }

  /**
   * Eagerly warm up the browser context (launch Chromium + load auth) so the
   * first scrape request is fast. Call once at server startup; failures are
   * logged but non-fatal — the first request will retry creation.
   */
  async warmup(): Promise<void> {
    await scraperEngine.warmup();
  }

  /**
   * Parses an HLS Master Playlist and resolves the best variant stream URL.
   */
  resolveM3u8Playlist(playlistUrl: string, body: string): string {
    const lines = body.split(/\r?\n/);
    const variants: {
      url: string;
      bandwidth: number;
      width: number;
      height: number;
    }[] = [];

    let currentStreamInf: {
      bandwidth: number;
      width: number;
      height: number;
    } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        
        let bandwidth = 0;
        if (bandwidthMatch && bandwidthMatch[1]) {
          bandwidth = parseInt(bandwidthMatch[1], 10);
        }

        let width = 0;
        let height = 0;
        if (resolutionMatch && resolutionMatch[1] && resolutionMatch[2]) {
          width = parseInt(resolutionMatch[1], 10);
          height = parseInt(resolutionMatch[2], 10);
        }

        currentStreamInf = { bandwidth, width, height };
      } else if (!line.startsWith("#")) {
        if (line.includes(".m3u8")) {
          try {
            const absoluteUrl = new URL(line, playlistUrl).toString();
            if (currentStreamInf) {
              variants.push({
                url: absoluteUrl,
                ...currentStreamInf,
              });
            } else {
              variants.push({
                url: absoluteUrl,
                bandwidth: 0,
                width: 0,
                height: 0,
              });
            }
          } catch (e) {
            logger.warn(
              `Failed to resolve relative URL: ${line} against ${playlistUrl}`,
              "ScraperService",
            );
          }
        }
        currentStreamInf = null;
      }
    }

    if (variants.length > 0) {
      // Sort variants: highest resolution first, then highest bandwidth
      variants.sort((a, b) => {
        const areaA = a.width * a.height;
        const areaB = b.width * b.height;
        if (areaB !== areaA) {
          return areaB - areaA;
        }
        return b.bandwidth - a.bandwidth;
      });
      return variants[0]?.url || playlistUrl;
    }

    // Fallback: check for any non-comment lines containing .m3u8
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (line && !line.startsWith("#") && line.includes(".m3u8")) {
        try {
          return new URL(line, playlistUrl).toString();
        } catch (e) {
          logger.warn(
            `Failed to resolve fallback relative URL: ${line} against ${playlistUrl}`,
            "ScraperService",
          );
        }
      }
    }

    return playlistUrl;
  }

  /**
   * Visits the given page in a real (stealth) browser, waits for media
   * requests, and returns the best .m3u8 (or mp4/mkv as a fallback) URL and
   * captured dynamic request headers. Result is cached for CONFIG.CACHE_TTL_MS.
   */
  async extractStream(
    url: string,
    sub: boolean = false,
    isEmbed: boolean = false,
  ): Promise<ExtractedStreamResult> {
    const cacheKey = `extract:${url}:sub:${sub}${isEmbed ? ":embed:true" : ""}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Coalesce concurrent in-flight requests for the exact same stream (Thundering Herd protection)
    const existingInFlight = this.inFlightScrapes.get(cacheKey);
    if (existingInFlight) {
      logger.info(
        `Coalescing concurrent request for: ${url} (waiting for existing in-flight scrape)`,
        "ScraperService",
      );
      return existingInFlight;
    }

    const scrapePromise = this.doExtractStream(url, sub, cacheKey, isEmbed);
    this.inFlightScrapes.set(cacheKey, scrapePromise);

    try {
      return await scrapePromise;
    } finally {
      this.inFlightScrapes.delete(cacheKey);
    }
  }

  private async doExtractStream(
    url: string,
    sub: boolean,
    cacheKey: string,
    isEmbed: boolean = false,
  ): Promise<ExtractedStreamResult> {
    logger.info(
      `Extracting raw stream URL for: ${url} (sub=${sub}${isEmbed ? ", embed=true" : ""})`,
      "ScraperService",
    );

    // Fast-path: try specialized direct HTTP extractor if available
    if (StrmFreeExtractor.canHandle(url)) {
      try {
        logger.info(
          `Attempting direct HTTP extraction for: ${url}`,
          "ScraperService",
        );
        const extracted = await StrmFreeExtractor.extract(url);
        if (extracted?.url) {
          let streamUrl = extracted.url;
          if (sub && streamUrl.includes(".m3u8")) {
            try {
              const res = await smartFetch(streamUrl, {
                headers: {
                  ...extracted.headers,
                  "accept-encoding": "identity",
                },
                signal: AbortSignal.timeout(5000),
              });
              if (res.ok) {
                const body = await res.text();
                streamUrl = this.resolveM3u8Playlist(streamUrl, body);
              }
            } catch (e) {
              logger.warn(
                `Direct extractor sub-resolution failed: ${(e as Error).message}`,
                "ScraperService",
              );
            }
          }
          const result: ExtractedStreamResult = {
            url: streamUrl,
            headers: extracted.headers,
          };
          streamCache.set(cacheKey, result, CONFIG.CACHE_TTL_MS);
          logger.info(
            `Extracted stream URL via direct extractor: ${streamUrl}`,
            "ScraperService",
          );
          return result;
        }
      } catch (e) {
        logger.warn(
          `Direct extractor failed for ${url}, falling back to browser scraper: ${(e as Error).message}`,
          "ScraperService",
        );
      }
    }

    const requests = await scraperEngine.collectRequests(
      url,
      CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
      sub,
      isEmbed,
    );

    // Prioritize requests whose body starts with #EXTM3U, then URL with .m3u8, then direct media
    const extm3uReq = requests.find(
      (r) => r.body && r.body.trim().startsWith("#EXTM3U"),
    );
    const m3u8Req = requests.find((r) => r.url.toLowerCase().includes(".m3u8"));
    const mediaReq = requests.find(
      (r) =>
        r.resource_type === "media" ||
        /\.(mp4|mkv|webm)($|\?)/i.test(r.url),
    );
    const selectedReq = extm3uReq || m3u8Req || mediaReq || requests[0];

    logger.info(
      `Total requests captured: ${requests.length}${extm3uReq ? " (found #EXTM3U content)" : ""}`,
      "ScraperService",
    );

    if (!selectedReq) {
      throw new NoSourceFoundError(
        "No m3u8/video source found - site may be down or content removed",
      );
    }

    const upstreamHeaders: Record<string, string> = {};
    if (selectedReq.headers) {
      for (const [key, value] of Object.entries(selectedReq.headers)) {
        const lowerKey = key.toLowerCase();
        if (!FORBIDDEN_HEADERS.has(lowerKey)) {
          upstreamHeaders[lowerKey] = value;
        }
      }
    }
    // Fallback: if browser request had no referer, default to the page URL
    if (!upstreamHeaders["referer"]) {
      upstreamHeaders["referer"] = url;
    }

    let playlistBody = selectedReq.body;
    const isM3u8Content =
      Boolean(playlistBody?.trim().startsWith("#EXTM3U")) ||
      selectedReq.url.toLowerCase().includes(".m3u8");

    if (sub && !playlistBody && isM3u8Content) {
      try {
        const res = await smartFetch(selectedReq.url, {
          headers: {
            ...upstreamHeaders,
            "accept-encoding": "identity",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          playlistBody = await res.text();
        }
      } catch (e) {
        logger.warn(
          `Failed to fetch playlist body for ${selectedReq.url}: ${(e as Error).message}`,
          "ScraperService",
        );
      }
    }

    let streamUrl = selectedReq.url;
    if (sub && playlistBody && playlistBody.trim().startsWith("#EXTM3U")) {
      const resolved = this.resolveM3u8Playlist(selectedReq.url, playlistBody);
      if (resolved !== selectedReq.url) {
        logger.info(
          `Resolved master playlist to sub-playlist: ${resolved}`,
          "ScraperService",
        );
        streamUrl = resolved;
      }
    }

    const result: ExtractedStreamResult = {
      url: streamUrl,
      headers: upstreamHeaders,
      body: playlistBody,
    };

    streamCache.set(cacheKey, result, CONFIG.CACHE_TTL_MS);
    logger.info(`Extracted stream URL: ${streamUrl}`, "ScraperService");
    return result;
  }
}

export const scraperService = new ScraperService();
