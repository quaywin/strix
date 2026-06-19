import { CONFIG } from "../config";
import { logger } from "../logger";
import { scraperEngine } from "../scraper/ScraperEngine";

class TtlCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private defaultTtlMs: number) {
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
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.cache.delete(key);
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

// Global cache instance
const streamCache = new TtlCache<string>(CONFIG.CACHE_TTL_MS);

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
]);

export class ScraperService {
  /**
   * Removes the cached stream URL for a given source page. Used by callers
   * (e.g. the proxy handler) when a previously cached URL turns out to be
   * stale (e.g. upstream returned 403) so the next extractStreamUrl() call
   * performs a fresh scrape.
   */
  invalidateCache(url: string): void {
    streamCache.delete(`extract:${url}`);
    streamCache.delete(`extract:${url}:sub:true`);
    streamCache.delete(`extract:${url}:sub:false`);
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
   * requests, and returns the best .m3u8 (or mp4/mkv as a fallback) URL it
   * can find. Result is cached for CONFIG.CACHE_TTL_MS.
   */
  async extractStreamUrl(url: string, sub: boolean = false): Promise<string> {
    const cacheKey = `extract:${url}:sub:${sub}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    logger.info(
      `Extracting raw stream URL for: ${url} (sub=${sub})`,
      "ScraperService",
    );

    const requests = await scraperEngine.collectRequests(
      url,
      CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
      sub,
    );

    // Prefer master > playlist > mono > any m3u8 > mp4/mkv.
    const selectedReq = requests.find((r) => r.url.includes(".m3u8"));

    logger.info(
      `Total requests captured: ${requests.length}`,
      "ScraperService",
    );

    if (!selectedReq) {
      throw new NoSourceFoundError(
        "No m3u8/video source found - site may be down or content removed",
      );
    }

    let playlistBody = selectedReq.body;
    if (sub && !playlistBody && selectedReq.url.includes(".m3u8")) {
      try {
        const headers = new Headers();
        if (selectedReq.headers) {
          for (const [key, value] of Object.entries(selectedReq.headers)) {
            const lowerKey = key.toLowerCase();
            if (!FORBIDDEN_HEADERS.has(lowerKey)) {
              headers.set(key, value);
            }
          }
        }
        const res = await fetch(selectedReq.url, {
          headers,
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
    if (sub && playlistBody) {
      const resolved = this.resolveM3u8Playlist(selectedReq.url, playlistBody);
      if (resolved !== selectedReq.url) {
        logger.info(
          `Resolved master playlist to sub-playlist: ${resolved}`,
          "ScraperService",
        );
        streamUrl = resolved;
      }
    }

    streamCache.set(cacheKey, streamUrl, CONFIG.CACHE_TTL_MS);
    logger.info(`Extracted stream URL: ${streamUrl}`, "ScraperService");
    return streamUrl;
  }
}

export const scraperService = new ScraperService();
