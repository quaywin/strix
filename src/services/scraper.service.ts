import { CONFIG } from "../config";
import { logger } from "../logger";
import { PitSportExtractor } from "../scraper/extractors/PitSportExtractor";
import { StrmFreeExtractor } from "../scraper/extractors/StrmFreeExtractor";
import {
  isM3u8StreamUrl,
  isMpdStreamUrl,
  scraperEngine,
} from "../scraper/ScraperEngine";
import { smartFetch } from "../utils/http";
import { TtlCache } from "../utils/ttlCache";
import { runCoalesced, type InFlightEntry } from "../utils/inFlight";

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
  private inFlightScrapes = new Map<string, InFlightEntry<ExtractedStreamResult>>();

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
    // If the playlist is already a Media Playlist (contains media segments #EXTINF),
    // it cannot contain variant streams. Segments might have '.m3u8' in their query or path,
    // which must never be confused with variant playlists.
    if (/#EXTINF[:\s]/m.test(body)) {
      return playlistUrl;
    }

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
        if (currentStreamInf) {
          try {
            const absoluteUrl = new URL(line, playlistUrl).toString();
            variants.push({
              url: absoluteUrl,
              ...currentStreamInf,
            });
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
    forceFresh: boolean = false,
  ): Promise<ExtractedStreamResult> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const cacheKey = `extract:${url}:sub:${sub}${isEmbed ? ":embed:true" : ""}`;
    if (!forceFresh) {
      const cached = streamCache.get(cacheKey);
      if (cached) {
        if (cached.isNotFound) {
          throw new NoSourceFoundError(
            "No m3u8/video source found - site may be down or content removed",
          );
        }
        return { ...cached, fromCache: true };
      }
    }

    return runCoalesced(
      this.inFlightScrapes,
      cacheKey,
      (scrapeSignal) => this.doExtractStream(url, sub, cacheKey, isEmbed, scrapeSignal),
      signal,
      () =>
        logger.info(
          `Coalescing concurrent request for: ${url} (waiting for existing in-flight scrape)`,
          "ScraperService",
        ),
    );
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
          streamCache.set(cacheKey, result, CONFIG.CACHE_TTL_MS);
          logger.info(
            `Extracted stream URL via direct extractor: ${streamUrl}`,
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
      CONFIG.SCRAPER.STREAM_TIMEOUT / 1000,
      sub,
      isEmbed,
      signal,
    );

    // Prioritize requests whose body starts with #EXTM3U, then URL with .m3u8,
    // then DASH manifests, then direct media
    const extm3uReq = requests.find(
      (r) => r.body && r.body.trim().startsWith("#EXTM3U"),
    );
    const m3u8Req = requests.find((r) => isM3u8StreamUrl(r.url));
    const mpdReq = requests.find((r) => isMpdStreamUrl(r.url));
    const mediaReq = requests.find(
      (r) =>
        r.resource_type === "media" ||
        /\.(mp4|mkv|webm)($|\?)/i.test(r.url),
    );
    const selectedReq = extm3uReq || m3u8Req || mpdReq || mediaReq || requests[0];

    logger.info(
      `Total requests captured: ${requests.length}${extm3uReq ? " (found #EXTM3U content)" : ""}`,
      "ScraperService",
    );

    if (!selectedReq) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const existing = streamCache.get(cacheKey);
      if (existing && !existing.isNotFound) {
        // A previously working stream exists in cache.
        // During upstream rotation or transient page reloads, 0 requests might temporarily be captured.
        // Do NOT poison the cache with negative cache (isNotFound: true), so player retries can recover!
        logger.warn(
          `Re-scrape for ${url} captured 0 requests; preserving last known stream without negative-caching`,
          "ScraperService",
        );
        throw new NoSourceFoundError(
          "No m3u8/video source found during re-scrape - preserving prior stream state",
        );
      }

      // Negative caching for initial discovery only: cache failure for 30s to prevent spamming browser launches on dead channels
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

    streamCache.set(cacheKey, result, CONFIG.CACHE_TTL_MS);
    logger.info(`Extracted stream URL: ${streamUrl}`, "ScraperService");
    return { ...result, fromCache: false };
  }
}

export const scraperService = new ScraperService();
