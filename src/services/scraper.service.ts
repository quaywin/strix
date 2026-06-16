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

  /**
   * Eagerly warm up the browser context (launch Chromium + load auth) so the
   * first scrape request is fast. Call once at server startup; failures are
   * logged but non-fatal — the first request will retry creation.
   */
  async warmup(): Promise<void> {
    await scraperEngine.warmup();
  }

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
      const rawLine = lines[i];
      if (!rawLine) continue;
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        const bandwidth =
          bandwidthMatch && bandwidthMatch[1]
            ? parseInt(bandwidthMatch[1], 10)
            : 0;
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
      const rawLine = lines[i];
      if (!rawLine) continue;
      const line = rawLine.trim();
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

  async extractStreamUrl(url: string): Promise<string> {
    const cacheKey = `extract:${url}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return cached;
    }

    logger.info(`Extracting raw stream URL for: ${url}`, "ScraperService");

    const requests = await scraperEngine.collectRequests(url);

    // Prefer master > playlist > mono > any m3u8 > mp4/mkv.
    // ping.gif is a common analytics beacon that falsely matches .m3u8 via
    // query params on some CDNs, so we explicitly exclude it.
    const selectedReq = requests.find((r) => r.url.includes(".m3u8"));

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

    let playlistBody = selectedReq.body;
    if (!playlistBody && selectedReq.url.includes(".m3u8")) {
      try {
        const headers = new Headers();
        if (selectedReq.headers) {
          for (const [key, value] of Object.entries(selectedReq.headers)) {
            const lowerKey = key.toLowerCase();
            if (
              ![
                "host",
                "connection",
                "content-length",
                "accept-encoding",
              ].includes(lowerKey)
            ) {
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
    if (playlistBody) {
      const resolved = this.resolveM3u8Playlist(selectedReq.url, playlistBody);
      if (resolved !== selectedReq.url) {
        logger.info(
          `Resolved master playlist to sub-playlist: ${resolved}`,
          "ScraperService",
        );
        streamUrl = resolved;
      }
    }

    requests.length = 0;

    setCached(cacheKey, streamUrl, CONFIG.CACHE_TTL_MS);
    logger.info(`Extracted stream URL: ${streamUrl}`, "ScraperService");
    return streamUrl;
  }
}

export const scraperService = new ScraperService();
