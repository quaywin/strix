import { CONFIG } from "../config";
import { logger } from "../logger";
import { scraperEngine } from "../scraper/ScraperEngine";
import { smartFetch } from "../utils/http";
import { buildMasterPlaylistWithSubtitles } from "../utils/m3u8";
import {
  normalizeSubtitleTracks,
  srtToVtt,
  type RawSubtitleCandidate,
  type SubtitleTrack,
} from "../utils/subtitles";

interface TtlEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private cache = new Map<string, TtlEntry<T>>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private defaultTtlMs: number,
    private maxSize: number = CONFIG.CACHE_MAX_ITEMS,
  ) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
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
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  deletePrefix(prefix: string): boolean {
    let deleted = false;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) {
        this.cache.delete(k);
        deleted = true;
      }
    }
    return deleted;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

export interface VideoStreamInfo {
  url: string;
  format: "m3u8" | "mp4" | "mkv" | "webm";
  headers: Record<string, string>;
  body?: string;
}

export interface ExtractedVideoResult {
  video: VideoStreamInfo;
  subtitles: SubtitleTrack[];
  masterPlaylist?: string;
  extractedAt: number;
  fromCache?: boolean;
  isNotFound?: boolean;
}

interface CachedVideoPayload {
  video: VideoStreamInfo;
  rawSubtitles: RawSubtitleCandidate[];
  extractedAt: number;
  isNotFound?: boolean;
}

interface InFlightVideoScrape {
  promise: Promise<CachedVideoPayload>;
  controller: AbortController;
  subscribers: number;
}

export class VideoScraperService {
  private videoCache = new TtlCache<CachedVideoPayload>(CONFIG.VOD_CACHE_TTL_MS);
  private subCache = new TtlCache<string>(CONFIG.SUBTITLE_CACHE_TTL_MS);
  private inFlightScrapes = new Map<string, InFlightVideoScrape>();

  invalidateCache(url: string): boolean {
    return this.videoCache.deletePrefix(`vod:${url}`);
  }

  private formatResult(
    payload: CachedVideoPayload,
    url: string,
    requestOrigin: string,
    fromCache: boolean = false,
  ): ExtractedVideoResult {
    const subtitles = normalizeSubtitleTracks(
      payload.rawSubtitles,
      requestOrigin,
      url,
    );

    const isHls =
      payload.video.format === "m3u8" ||
      payload.video.url.toLowerCase().includes(".m3u8") ||
      Boolean(payload.video.body?.trim().startsWith("#EXTM3U"));

    const masterPlaylist = isHls
      ? buildMasterPlaylistWithSubtitles(
          payload.video.url,
          subtitles,
          {
            videoBody: payload.video.body,
            proxySegmentUrl: (targetUrl) => {
              return `${requestOrigin}/proxy-chunk?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(url)}`;
            },
          },
        )
      : undefined;

    return {
      video: payload.video,
      subtitles,
      masterPlaylist,
      extractedAt: payload.extractedAt,
      fromCache,
    };
  }

  async extractVideo(
    url: string,
    requestOrigin: string,
    isEmbed: boolean = false,
    signal?: AbortSignal,
    forceFresh: boolean = false,
  ): Promise<ExtractedVideoResult> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const cacheKey = `vod:${url}${isEmbed ? ":embed:true" : ""}`;

    if (!forceFresh) {
      const cached = this.videoCache.get(cacheKey);
      if (cached) {
        if (cached.isNotFound) {
          throw new Error("No playable video source found on page");
        }
        return this.formatResult(cached, url, requestOrigin, true);
      }
    }

    let inFlight = this.inFlightScrapes.get(cacheKey);
    if (inFlight) {
      logger.info(
        `Coalescing concurrent VOD request for: ${url}`,
        "VideoScraperService",
      );
      inFlight.subscribers++;
    } else {
      const controller = new AbortController();
      const promise = this.doExtractVideo(
        url,
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
      const payload = await (abortPromise
        ? Promise.race([inFlight.promise, abortPromise])
        : inFlight.promise);
      return this.formatResult(payload, url, requestOrigin, false);
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async doExtractVideo(
    url: string,
    cacheKey: string,
    isEmbed: boolean,
    signal?: AbortSignal,
  ): Promise<CachedVideoPayload> {
    logger.info(`Scraping VOD and subtitles for: ${url}`, "VideoScraperService");

    const collection = await scraperEngine.collectVideoAndSubtitles(
      url,
      CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
      isEmbed,
      signal,
    );

    if (!collection.video) {
      // Negative cache for 30 seconds to protect against crawler spam
      this.videoCache.set(
        cacheKey,
        {
          video: { url: "", format: "m3u8", headers: {} },
          rawSubtitles: [],
          extractedAt: Date.now(),
          isNotFound: true,
        },
        30000,
      );
      throw new Error("No playable video source found on page");
    }

    const videoReq = collection.video;
    let format: "m3u8" | "mp4" | "mkv" | "webm" = "m3u8";
    const vLower = videoReq.url.toLowerCase();
    if (vLower.includes(".mkv") || vLower.includes("video/x-matroska")) {
      format = "mkv";
    } else if (vLower.includes(".mp4") || vLower.includes("video/mp4")) {
      format = "mp4";
    } else if (vLower.includes(".webm") || vLower.includes("video/webm")) {
      format = "webm";
    }

    const payload: CachedVideoPayload = {
      video: {
        url: videoReq.url,
        format,
        headers: videoReq.headers,
        body: videoReq.body,
      },
      rawSubtitles: collection.subtitles,
      extractedAt: Date.now(),
    };

    this.videoCache.set(cacheKey, payload, CONFIG.VOD_CACHE_TTL_MS);
    return payload;
  }

  async getSubtitle(
    url: string,
    referer?: string,
    userAgent?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = this.subCache.get(url);
    if (cached) {
      return cached;
    }

    const headers: Record<string, string> = {
      "user-agent":
        userAgent ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    };
    if (referer) {
      headers["referer"] = referer;
    }

    const res = await smartFetch(url, {
      headers,
      signal: signal || AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      // If 403 and referer was used, retry without referer
      if (res.status === 403 && referer) {
        delete headers["referer"];
        const retryRes = await smartFetch(url, {
          headers,
          signal: signal || AbortSignal.timeout(15000),
        });
        if (retryRes.ok) {
          const rawText = await retryRes.text();
          const vttText = srtToVtt(rawText);
          this.subCache.set(url, vttText, CONFIG.SUBTITLE_CACHE_TTL_MS);
          return vttText;
        }
      }
      throw new Error(`Failed to fetch subtitle: HTTP ${res.status}`);
    }

    const rawText = await res.text();
    const vttText = srtToVtt(rawText);
    this.subCache.set(url, vttText, CONFIG.SUBTITLE_CACHE_TTL_MS);
    return vttText;
  }
}

export const videoScraperService = new VideoScraperService();
