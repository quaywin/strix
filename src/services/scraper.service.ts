import { CONFIG } from "../config";
import { logger } from "../logger";
import { PitSportExtractor } from "../scraper/extractors/PitSportExtractor";
import { StrmFreeExtractor } from "../scraper/extractors/StrmFreeExtractor";
import { isM3u8StreamUrl, scraperEngine } from "../scraper/ScraperEngine";
import { smartFetch } from "../utils/http";

interface TtlEntry<T> {
  value: T;
  expiresAt: number;
  staleAt?: number;
  isRevalidating?: boolean;
}

class TtlCache<T> {
  private cache = new Map<string, TtlEntry<T>>();
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

  getWithStale(key: string): { value: T; isStale: boolean } | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    const isStale = Boolean(
      entry.staleAt && now > entry.staleAt && !entry.isRevalidating,
    );
    if (isStale) {
      entry.isRevalidating = true;
    }
    return { value: entry.value, isStale };
  }

  clearRevalidating(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.isRevalidating = false;
    }
  }

  set(
    key: string,
    value: T,
    ttlMs: number = this.defaultTtlMs,
    staleMs?: number,
  ): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Evict oldest entry (first key in Map insertion order) to cap memory usage
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    const now = Date.now();
    this.cache.set(key, {
      value,
      expiresAt: now + ttlMs,
      staleAt: staleMs !== undefined ? now + staleMs : undefined,
      isRevalidating: false,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  deletePrefix(prefix: string, predicate?: (value: T) => boolean): boolean {
    let deletedAny = false;
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        if (!predicate || predicate(entry.value)) {
          this.cache.delete(key);
          deletedAny = true;
        }
      }
    }
    return deletedAny;
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
  extractedAt?: number;
  fromCache?: boolean;
  isNotFound?: boolean;
}

// Global cache instance
export const streamCache = new TtlCache<ExtractedStreamResult>(CONFIG.CACHE_TTL_MS);

export interface StreamTtlConfig {
  ttlMs: number;
  staleMs?: number;
}

/**
 * Calculates a safe cache TTL and soft stale threshold (SWR) for an extracted stream URL.
 * Signed / rolling tokens (e.g. Pecufa, Matchora, Cinevid, Akamai HDN, CDN tokens)
 * typically expire in 10-15 minutes. By returning both a hard ttlMs and a soft staleMs,
 * the stream can be refreshed in the background without forcing the client to wait.
 */
export function calculateStreamTtl(
  streamUrl: string,
  defaultTtlMs: number = CONFIG.CACHE_TTL_MS,
): StreamTtlConfig {
  const ROLLING_TOKEN_TTL_MS = 7.5 * 60 * 1000; // 7.5 minutes (450,000ms) - hard expiry
  const ROLLING_TOKEN_STALE_MS = 5 * 60 * 1000; // 5.0 minutes (300,000ms) - background revalidate trigger
  const MIN_TTL_MS = 60 * 1000; // 1 minute minimum

  try {
    const parsedUrl = new URL(streamUrl);
    const params = parsedUrl.searchParams;

    const parseEpoch = (num: number): StreamTtlConfig | null => {
      if (!isNaN(num) && num > 1_600_000_000 && num < 2_500_000_000) {
        const remainingMs = num * 1000 - Date.now();
        if (remainingMs > MIN_TTL_MS) {
          const ttlMs = Math.min(defaultTtlMs, Math.max(MIN_TTL_MS, remainingMs - 60_000));
          const staleBufferMs = Math.min(180_000, ttlMs / 2);
          const staleMs = Math.max(30_000, ttlMs - staleBufferMs);
          return { ttlMs, staleMs };
        }
      }
      return null;
    };

    // 1. Explicit expiry parameters (seconds since epoch)
    const expKeys = ["expires", "exp", "e", "until", "timeout", "expire"];
    for (const key of expKeys) {
      const val = params.get(key);
      if (val) {
        const result = parseEpoch(parseInt(val, 10));
        if (result) return result;
      }
    }

    // 2. Encoded / pipe-separated token timestamps (e.g. Pecufa/Matchora ?t=1909974|1793730554||||...)
    for (const [_, val] of params.entries()) {
      if (val.includes("|")) {
        const parts = val.split("|");
        for (const part of parts) {
          const result = parseEpoch(parseInt(part, 10));
          if (result) return result;
        }
      }
    }

    // 3. Known query parameters indicative of rolling/signed tokens
    const tokenParamNames = [
      "token",
      "t",
      "tk",
      "sign",
      "signature",
      "auth_key",
      "hdnts",
      "st",
      "et",
      "h",
      "wmsauthsign",
      "hash",
      "key",
      "access_token",
      "verify",
    ];
    const hasTokenParam = tokenParamNames.some((key) => params.has(key));

    // Also check for signed token segments in the path (e.g. /token=.../ or /h=.../ or /live/...~exp=...)
    const pathHasToken =
      /\/(token|auth|sign|h|verify)[\/=]/i.test(parsedUrl.pathname) ||
      /~exp=/i.test(parsedUrl.pathname);

    if (hasTokenParam || pathHasToken) {
      const ttlMs = Math.min(defaultTtlMs, ROLLING_TOKEN_TTL_MS);
      return { ttlMs, staleMs: ROLLING_TOKEN_STALE_MS };
    }
  } catch (_) {
    // If streamUrl cannot be parsed as a standard URL, fall back to default
  }

  return {
    ttlMs: defaultTtlMs,
    staleMs: Math.round(defaultTtlMs * 0.8),
  };
}

export function calculateStreamTtlMs(
  streamUrl: string,
  defaultTtlMs: number = CONFIG.CACHE_TTL_MS,
): number {
  return calculateStreamTtl(streamUrl, defaultTtlMs).ttlMs;
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

const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
]);

interface InFlightScrape {
  promise: Promise<ExtractedStreamResult>;
  controller: AbortController;
  subscribers: number;
}

export class ScraperService {
  // Deduplicates concurrent in-flight scrapes for the exact same stream (Thundering Herd protection)
  private inFlightScrapes = new Map<string, InFlightScrape>();

  /**
   * Removes the cached stream URL for a given source page.
   * If `ifExtractedAtOrBefore` is provided, only deletes the entry if it was
   * extracted at or before that timestamp. This prevents a concurrent or late
   * request from accidentally wiping out a brand-new cache entry that was
   * literally just created by another request.
   */
  invalidateCache(url: string, ifExtractedAtOrBefore?: number): boolean {
    return streamCache.deletePrefix(`extract:${url}`, (val) => {
      if (ifExtractedAtOrBefore === undefined) return true;
      return (val.extractedAt ?? 0) <= ifExtractedAtOrBefore;
    });
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
    signal?: AbortSignal,
  ): Promise<ExtractedStreamResult> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const cacheKey = `extract:${url}:sub:${sub}${isEmbed ? ":embed:true" : ""}`;
    const cacheEntry = streamCache.getWithStale(cacheKey);
    if (cacheEntry) {
      const { value, isStale } = cacheEntry;
      if (value.isNotFound) {
        throw new NoSourceFoundError(
          "No m3u8/video source found - site may be down or content removed",
        );
      }

      // Stale-While-Revalidate: If stale and no revalidation is currently in flight,
      // refresh in background without making the user wait (0ms delay for user).
      if (isStale && !this.inFlightScrapes.has(cacheKey)) {
        logger.info(
          `Stream cache is stale for: ${url}, refreshing in background (SWR)`,
          "ScraperService",
        );
        const bgController = new AbortController();
        const bgPromise = this.doExtractStream(
          url,
          sub,
          cacheKey,
          isEmbed,
          bgController.signal,
        )
          .catch((err) => {
            logger.warn(
              `Background SWR refresh failed for ${url}: ${(err as Error).message}`,
              "ScraperService",
            );
            streamCache.clearRevalidating(cacheKey);
          })
          .finally(() => {
            const current = this.inFlightScrapes.get(cacheKey);
            if (current && current.promise === bgPromise) {
              this.inFlightScrapes.delete(cacheKey);
            }
          });
        this.inFlightScrapes.set(cacheKey, {
          promise: bgPromise,
          controller: bgController,
          subscribers: 1,
        });
      }

      return { ...value, fromCache: true };
    }

    // Coalesce concurrent in-flight requests for the exact same stream (Thundering Herd protection)
    let inFlight = this.inFlightScrapes.get(cacheKey);
    if (inFlight) {
      logger.info(
        `Coalescing concurrent request for: ${url} (waiting for existing in-flight scrape)`,
        "ScraperService",
      );
      inFlight.subscribers++;
    } else {
      const controller = new AbortController();
      const promise = this.doExtractStream(
        url,
        sub,
        cacheKey,
        isEmbed,
        controller.signal,
      ).finally(() => {
        const current = this.inFlightScrapes.get(cacheKey);
        if (current && current.promise === promise) {
          this.inFlightScrapes.delete(cacheKey);
        }
      });
      inFlight = { promise, controller, subscribers: 1 };
      this.inFlightScrapes.set(cacheKey, inFlight);
    }

    // If client signal aborts (e.g. user switched channel), decrement subscriber count.
    // If all subscribers have abandoned, abort the underlying scrape to free Chromium slot immediately.
    let onAbort: (() => void) | undefined;
    let abortPromise: Promise<never> | undefined;

    if (signal) {
      abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
          if (inFlight) {
            inFlight.subscribers--;
            if (inFlight.subscribers <= 0) {
              inFlight.controller.abort();
              this.inFlightScrapes.delete(cacheKey);
            }
          }
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    try {
      return await (abortPromise
        ? Promise.race([inFlight.promise, abortPromise])
        : inFlight.promise);
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async doExtractStream(
    url: string,
    sub: boolean,
    cacheKey: string,
    isEmbed: boolean = false,
    signal?: AbortSignal,
  ): Promise<ExtractedStreamResult> {
    logger.info(
      `Extracting raw stream URL for: ${url} (sub=${sub}${isEmbed ? ", embed=true" : ""})`,
      "ScraperService",
    );

    // Fast-path: try specialized direct HTTP extractors if available
    if (PitSportExtractor.canHandle(url)) {
      try {
        logger.info(
          `Attempting direct PitSport API extraction for: ${url}`,
          "ScraperService",
        );
        const extracted = await PitSportExtractor.extract(url);
        if (extracted?.url) {
          // Point URL to the extracted embed stream URL for subsequent processing
          url = extracted.url;
          isEmbed = true;
          logger.info(
            `PitSport resolved to underlying embed: ${url}`,
            "ScraperService",
          );
        }
      } catch (e) {
        logger.warn(
          `PitSport direct extractor failed for ${url}: ${(e as Error).message}`,
          "ScraperService",
        );
      }
    }

    if (StrmFreeExtractor.canHandle(url)) {
      try {
        logger.info(
          `Attempting direct HTTP extraction for: ${url}`,
          "ScraperService",
        );
        const extracted = await StrmFreeExtractor.extract(url);
        if (extracted?.url) {
          let streamUrl = extracted.url;
          if (sub && isM3u8StreamUrl(streamUrl)) {
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
            extractedAt: Date.now(),
          };
          const { ttlMs, staleMs } = calculateStreamTtl(streamUrl, CONFIG.CACHE_TTL_MS);
          streamCache.set(cacheKey, result, ttlMs, staleMs);
          logger.info(
            `Extracted stream URL via direct extractor: ${streamUrl} (TTL: ${Math.round(ttlMs / 1000)}s, SWR at: ${staleMs ? Math.round(staleMs / 1000) : "none"}s)`,
            "ScraperService",
          );
          return { ...result, fromCache: false };
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
      signal,
    );

    // Prioritize requests whose body starts with #EXTM3U, then URL with .m3u8, then direct media
    const extm3uReq = requests.find(
      (r) => r.body && r.body.trim().startsWith("#EXTM3U"),
    );
    const m3u8Req = requests.find((r) => isM3u8StreamUrl(r.url));
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
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      // Negative caching: cache the failure for 30s to prevent spamming browser launches on dead channels
      streamCache.set(
        cacheKey,
        {
          url: "",
          isNotFound: true,
          extractedAt: Date.now(),
        },
        30_000,
      );
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
      isM3u8StreamUrl(selectedReq.url);

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
      extractedAt: Date.now(),
    };

    const { ttlMs, staleMs } = calculateStreamTtl(streamUrl, CONFIG.CACHE_TTL_MS);
    streamCache.set(cacheKey, result, ttlMs, staleMs);
    logger.info(
      `Extracted stream URL: ${streamUrl} (TTL: ${Math.round(ttlMs / 1000)}s, SWR at: ${staleMs ? Math.round(staleMs / 1000) : "none"}s)`,
      "ScraperService",
    );
    return { ...result, fromCache: false };
  }
}

export const scraperService = new ScraperService();
