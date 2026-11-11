import { CONFIG } from "../config";
import { logger } from "../logger";
import { CinejoyExtractor } from "../scraper/extractors/CinejoyExtractor";
import { scraperEngine, type RequestData } from "../scraper/ScraperEngine";
import {
  buildVdrkSubtitleCandidates,
  parseEmbedVideoIdentity,
} from "../utils/embedSubtitles";
import { fetchWyzieSubtitles, wyzieToCandidates } from "../utils/wyzie";
import { curlFetch, DEFAULT_USER_AGENT, smartFetch } from "../utils/http";
import {
  buildMasterPlaylistWithSubtitles,
  flattenMasterChain,
  parseHlsSubtitleRenditions,
  proxyChunkUrl,
  rewriteM3u8Playlist,
  resolveUrlWithBaseParams,
  extractDurationFromMediaPlaylist,
  extractPlaylistDuration,
  extractFirstSegmentUrl,
} from "../utils/m3u8";
import {
  maybeFixMojibake,
  mergeHlsVttSegments,
  filterTracksByLanguages,
  missingLanguages,
  srtToVtt,
  normalizeSubtitleTracks,
  isWyzieSubtitleUrl,
  extractDurationFromVtt,
  type RawSubtitleCandidate,
  type SubtitleTrack,
} from "../utils/subtitles";
import {
  alignSubtitleCues,
  applyVttTimeTransform,
  type SubtitleSyncTransform,
} from "../utils/subtitleSync";
import { TtlCache } from "../utils/ttlCache";
import { Semaphore } from "../utils/semaphore";
import { runCoalesced, type InFlightEntry } from "../utils/inFlight";

export interface VideoStreamInfo {
  url: string;
  format: "m3u8" | "mp4" | "mkv" | "webm" | "mpd";
  headers: Record<string, string>;
  body?: string;
}

export interface ExtractedVideoResult {
  video: VideoStreamInfo;
  duration?: number;
  /**
   * Subtitle tracks from the upstream master's own renditions plus the
   * vidnest-family static caption cache (empty for direct-video sources).
   */
  subtitles: SubtitleTrack[];
  masterPlaylist?: string;
  extractedAt: number;
  fromCache?: boolean;
  isNotFound?: boolean;
}

interface CachedVideoPayload {
  video: VideoStreamInfo;
  duration?: number;
  extractedAt: number;
  isNotFound?: boolean;
  /** Raw candidates from the master body + caption cache; normalized per-request. */
  subCandidates?: RawSubtitleCandidate[];
  /**
   * Variant playlist URLs whose bodies were harvested (and cached in
   * variantBodies) at scrape time — kept so invalidateCache can purge them
   * together with the payload.
   */
  variantUrls?: string[];
  /** Variant URLs whose segments failed upstream check (403/404/502). */
  unplayableVariantUrls?: Set<string>;
}

/**
 * Megacloud-family /proxy endpoints never answer with a real HTTP error:
 * upstream failures come back as HTTP 200 + an HTML error page whose lines
 * are rewritten into fake /ts-proxy "segment" URLs, served even with an
 * application/vnd.apple.mpegurl content-type. The only reliable error signal
 * is the absence of HLS tags in the body.
 */
const HLS_MARKER_RE = /#EXTM3U|#EXTINF|#EXT-X-/;

/** Normalized "label language" tag of a candidate, for language matching. */
function candidateLangTag(c: RawSubtitleCandidate): string {
  return `${c.label || ""} ${c.language || ""}`.toLowerCase();
}

export class VideoScraperService {
  private videoCache = new TtlCache<CachedVideoPayload>(CONFIG.VOD_CACHE_TTL_MS);
  private subCache = new TtlCache<string>(CONFIG.SUBTITLE_CACHE_TTL_MS);
  /**
   * Wyzie URL → calibrated linear time transform (see utils/subtitleSync).
   * Keyed by the same raw-URL key as subCache; TTL matches it so neither
   * outlives the other. subCache stores RAW text unconditionally and the
   * transform is applied at READ time (applySyncTransform) — that split is
   * what makes the invariant unbreakable: concurrent fetches of the same
   * Wyzie URL can land in any order, but raw writes never poison anything
   * and a transform landing after a cached fetch takes effect immediately
   * on the next read.
   */
  private subtitleSyncCache = new TtlCache<SubtitleSyncTransform>(
    CONFIG.SUBTITLE_CACHE_TTL_MS,
  );
  /**
   * Variant playlists downloaded at scrape time, keyed by their absolute
   * upstream URL. Serving them from memory removes the play-time refetch —
   * historically the step that died first when a proxy entered its
   * disguised-error window. Bodies above MAX_VARIANT_CACHE_BYTES are served
   * but not stored, bounding worst-case RAM at roughly entries × limit.
   */
  private variantBodies = new TtlCache<string>(CONFIG.VOD_CACHE_TTL_MS, 40);
  /** Titles Wyzie had no subs for — protects the API quota on re-scrapes. */
  private wyzieMissCache = new TtlCache<boolean>(24 * 60 * 60 * 1000);
  /**
   * vdrk probe results (possibly empty) keyed by embedUrl+languages. The
   * cache is slow (0.6-8s/file) and fresh scrapes re-probe the same TMDB id
   * after VOD expiry — caching the outcome, including the empty one, turns
   * those repeats into zero-network lookups.
   */
  private vdrkProbeCache = new TtlCache<RawSubtitleCandidate[]>(
    15 * 60 * 1000,
  );
  /** Individual vdrk URLs known missing — shared by the probe and the
   * sync-reference lookup so a learned 404 is never paid twice. */
  private vdrkMissCache = new TtlCache<boolean>(15 * 60 * 1000);
  /** Variant URLs known to fail upstream (e.g. 429 rate limit or non-HLS error) — prevents hammering retry loops at play time. */
  private failedPlaylistCache = new TtlCache<boolean>(60 * 1000);
  private inFlightScrapes = new Map<string, InFlightEntry<CachedVideoPayload>>();

  /** Masters carry up to 4-5 quality variants (4K, 1080p, 720p, 480p, 360p). */
  private static readonly MAX_VARIANTS_PER_VOD = 5;
  /** Playlists observed in the wild max out ~2.3MB; don't retain bigger. */
  private static readonly MAX_VARIANT_CACHE_BYTES = 6 * 1024 * 1024;
  /** Refuse to buffer responses larger than any real playlist. */
  private static readonly MAX_PLAYLIST_FETCH_BYTES = 32 * 1024 * 1024;
  /** Wall-clock cap so scrape+harvest stays under the 120s server idle timeout. */
  private static readonly HARVEST_BUDGET_MS = 45_000;

  invalidateCache(url: string): boolean {
    // Purge harvested variant bodies belonging to the dying payloads so a
    // forced refresh never keeps serving the old token's playlists.
    for (const suffix of ["", ":embed:true"]) {
      const payload = this.videoCache.get(`vod:${url}${suffix}`);
      for (const variantUrl of payload?.variantUrls || []) {
        this.variantBodies.delete(variantUrl);
      }
    }
    return this.videoCache.deletePrefix(`vod:${url}`);
  }

  /**
   * Retrieves the cached media duration (in seconds) for a video page URL or stream URL.
   */
  getDuration(url?: string): number | undefined {
    if (!url) return undefined;
    for (const suffix of ["", ":embed:true"]) {
      const payload = this.videoCache.get(`vod:${url}${suffix}`);
      if (payload?.duration && payload.duration > 0) {
        return payload.duration;
      }
    }
    return undefined;
  }

  /**
   * Estimates duration from cached subtitle cue timestamps if available.
   */
  getSubtitleDuration(subUrl: string): number | undefined {
    const cached = this.subCache.get(subUrl);
    if (cached) {
      const dur = extractDurationFromVtt(cached);
      if (dur > 0) return dur;
    }
    return undefined;
  }

  /**
   * Fetches an upstream m3u8 playlist (variant/media playlist) and rewrites
   * every URI — segments, encryption keys, init maps — to route through
   * strix's /proxy-chunk. Browsers then never talk to the anti-hotlink CDN
   * directly, sidestepping its Referer checks and missing CORS headers no
   * matter which origin the player is served from.
   */
  async getProxiedPlaylist(
    playlistUrl: string,
    referer: string | undefined,
    requestOrigin: string,
    signal?: AbortSignal,
    origin?: string,
  ): Promise<string> {
    const headers: Record<string, string> = {};
    if (referer) headers["referer"] = referer;
    if (origin) headers["origin"] = origin;

    // Playlists harvested at scrape time are served straight from memory —
    // no upstream request at all on the play path.
    const harvested = this.variantBodies.get(playlistUrl);
    const normalized = harvested
      ? harvested
      : await this.fetchPlaylistText(playlistUrl, headers, signal);

    // Two playlist shapes with different child-URL routing:
    // - nested MASTER (#EXT-X-STREAM-INF): its children are playlists too
    //   (variants, audio renditions) — they must re-enter /playlist so their
    //   own segments get rewritten;
    // - MEDIA playlist: every URI line is a segment — straight to
    //   /proxy-chunk.
    const isNestedMaster = normalized.includes("#EXT-X-STREAM-INF");
    const refererParam = encodeURIComponent(referer || playlistUrl);
    const originParam = origin ? `&origin=${encodeURIComponent(origin)}` : "";
    return rewriteM3u8Playlist(normalized, playlistUrl, {
      proxySegmentUrl: (targetUrl) =>
        isNestedMaster
          ? `${requestOrigin}/playlist?url=${encodeURIComponent(targetUrl)}&referer=${refererParam}${originParam}`
          : proxyChunkUrl(
              requestOrigin,
              targetUrl,
              `url=${encodeURIComponent(targetUrl)}&referer=${refererParam}${originParam}`,
            ),
    });
  }

  /**
   * Fetches an upstream playlist and returns it normalized (with an
   * #EXTM3U header), retrying through the megacloud-family disguised-error
   * window: those proxies answer bursts with HTTP 200 + an HTML error page
   * rewritten to look like a playlist, usually for only seconds at a time.
   * A bare failure here kills playback outright, so back off and retry
   * before surfacing anything to the player.
   */
  private async fetchPlaylistText(
    playlistUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
    maxAttempts: number = 3,
  ): Promise<string> {
    if (this.failedPlaylistCache.get(playlistUrl)) {
      throw new Error("Upstream playlist response is not an m3u8 document (cached failure)");
    }
    const BACKOFF_MS = [1000, 2500];
    let lastError: unknown;
    // Prepare headers for both stacks: smartFetch applies these defaults
    // itself, curlFetch does not.
    const reqHeaders: Record<string, string> = { ...headers };
    if (!reqHeaders["user-agent"]) reqHeaders["user-agent"] = DEFAULT_USER_AGENT;
    if (playlistUrl.toLowerCase().includes(".m3u8")) {
      reqHeaders["accept-encoding"] = "identity";
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      try {
        // Alternate network stacks between attempts: the proxy sometimes
        // answers non-browser TLS fingerprints with the disguised error
        // page (HTTP 200, no HLS tags) — a status smartFetch's curl
        // fallback never sees, so switch to curl's native stack explicitly.
        const timeoutSignal = signal || AbortSignal.timeout(15000);
        const res =
          attempt > 0
            ? await curlFetch(playlistUrl, reqHeaders, timeoutSignal)
            : await smartFetch(playlistUrl, {
                headers: reqHeaders,
                signal: timeoutSignal,
              });
        if (!res.ok) {
          throw new Error(`Upstream playlist fetch failed: HTTP ${res.status}`);
        }
        // /playlist is a public route — refusing oversized bodies here is
        // what stops a misdirected ?url= from buffering a whole video into
        // RAM. (Only a guard, not a guarantee: chunked responses carry no
        // Content-Length to check.)
        const contentLength = Number(res.headers.get("content-length") || 0);
        if (contentLength > VideoScraperService.MAX_PLAYLIST_FETCH_BYTES) {
          throw new Error(
            `Upstream playlist too large: ${Math.round(contentLength / 1024 / 1024)}MB`,
          );
        }
        const text = await res.text();
        // Error pages can come back with 200/3xx statuses — never hand them
        // to the player disguised as a playlist. Some upstreams (megacloud
        // /proxy) omit the #EXTM3U header entirely while still being valid
        // media playlists (EXTINF lines + segment URLs), so require any HLS
        // tag.
        if (!HLS_MARKER_RE.test(text)) {
          throw new Error("Upstream playlist response is not an m3u8 document");
        }
        return text.includes("#EXTM3U") ? text : `#EXTM3U\n${text}`;
      } catch (e) {
        if (
          signal?.aborted ||
          (e as Error).name === "AbortError" ||
          attempt === maxAttempts - 1
        ) {
          this.failedPlaylistCache.set(playlistUrl, true, 60000);
          throw e;
        }
        lastError = e;
        logger.warn(
          `Playlist fetch attempt ${attempt + 1}/${maxAttempts} failed for ${playlistUrl.slice(0, 120)} (${(e as Error).message}); retrying in ${BACKOFF_MS[attempt] ?? 2500}ms`,
          "VideoScraperService",
        );
        await Bun.sleep(BACKOFF_MS[attempt] ?? 2500);
      }
    }
    this.failedPlaylistCache.set(playlistUrl, true, 60000);
    throw lastError instanceof Error
      ? lastError
      : new Error("Upstream playlist fetch failed");
  }

  /**
   * Performs a lightweight probe on the first segment/init map of a media variant.
   * If upstream explicitly responds with 4xx or 5xx (e.g. 403 Forbidden, 404 Not Found, 502 Bad Gateway),
   * the rendition variant is unplayable (often declared in master template but absent from storage)
   * and should be excluded from the master playlist to prevent player playback errors or unwanted degradation.
   */
  private async probeSegmentPlayable(
    segUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const timeoutSignal = AbortSignal.timeout(3000);
      const combined = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      let res = await fetch(segUrl, {
        method: "HEAD",
        headers,
        signal: combined,
      });
      if (res.status === 405) {
        res = await fetch(segUrl, {
          method: "GET",
          headers: { ...headers, Range: "bytes=0-1" },
          signal: combined,
        });
      }
      return res.status >= 200 && res.status < 400;
    } catch {
      // Conservative on network glitches: only drop on explicit upstream failure responses
      return true;
    }
  }

  /**
   * Downloads and caches the whole playlist chain immediately after a fresh
   * scrape — the token is at its freshest and the player hasn't added its
   * own request burst yet (the two together regularly trip the proxy's
   * disguised-error window). Follows masters down to media playlists
   * (this CDN nests them 2-3 levels) plus EXT-X-MEDIA renditions, so the
   * play path's playlist fetches all come from memory. Doubles as
   * end-to-end verification: a master can verify in-browser while every
   * variant is server-side unfetchable — exactly the source shape that
   * plays nothing. Best-effort: failures are logged and play time falls
   * back to live fetching with retries.
   */
  private async harvestVariantPlaylists(
    payload: CachedVideoPayload,
  ): Promise<number> {
    const headers = this.pickForwardableHeaders(payload.video.headers);
    const visited = new Set<string>();
    const unplayableVariants = new Set<string>();
    let okCount = 0;
    let mediaOkCount = 0;
    let totalBytes = 0;
    let budgetExceeded = false;
    const body = payload.video.body || "";
    const isMaster = body.includes("#EXT-X-STREAM-INF");
    if (!isMaster && body.includes("#EXTINF")) {
      const dur = extractDurationFromMediaPlaylist(body);
      if (dur > 0 && (!payload.duration || dur > payload.duration)) {
        payload.duration = Math.round(dur);
      }
    }
    const deadline = Date.now() + VideoScraperService.HARVEST_BUDGET_MS;

    const harvestOne = async (
      url: string,
      bodyText: string | null,
      depth: number,
    ): Promise<void> => {
      if (visited.has(url) || visited.size >= 10) return;
      // Bound total wall time: worst-case per-URL retry chains (2 × 15s
      // timeouts + backoff) across 10 URLs would otherwise outlive the
      // server's idle timeout and strand the requesting player.
      if (Date.now() > deadline) {
        budgetExceeded = true;
        return;
      }
      visited.add(url);

      let text = bodyText;
      if (text === null) {
        // 2 attempts at scrape time; play-time fetches keep the 3-attempt budget.
        try {
          text = await this.fetchPlaylistText(url, headers, undefined, 2);
        } catch (e) {
          logger.warn(
            `Variant playlist harvest failed for ${url.slice(0, 120)}: ${(e as Error).message}`,
            "VideoScraperService",
          );
          this.failedPlaylistCache.set(url, true, 60000);
          return;
        }
      }

      // Validate every body before caching — including the scrape-captured
      // master. The engine's capture can accept a body on mpegurl
      // content-type alone, which is exactly what the disguised error page
      // presents; caching it would serve garbage to the player.
      if (!HLS_MARKER_RE.test(text)) {
        logger.warn(
          `Harvest skipped non-HLS body for ${url.slice(0, 120)}`,
          "VideoScraperService",
        );
        this.failedPlaylistCache.set(url, true, 60000);
        return;
      }

      if (!text.includes("#EXT-X-STREAM-INF")) {
        const segUrl = extractFirstSegmentUrl(text, url);
        if (segUrl) {
          const playable = await this.probeSegmentPlayable(segUrl, headers);
          if (!playable) {
            logger.warn(
              `Variant playlist segment check failed (unplayable upstream): ${url.slice(0, 100)}`,
              "VideoScraperService",
            );
            unplayableVariants.add(url);
            this.failedPlaylistCache.set(url, true, 60000);
            return;
          }
        }
        mediaOkCount++;
        const dur = extractDurationFromMediaPlaylist(text);
        if (dur > 0 && (!payload.duration || dur > payload.duration)) {
          payload.duration = Math.round(dur);
        }
      }

      if (text.length <= VideoScraperService.MAX_VARIANT_CACHE_BYTES) {
        this.variantBodies.set(url, text);
      }
      okCount++;
      totalBytes += text.length;

      // Nested master: children (variants + EXT-X-MEDIA renditions) are
      // playlists too and re-enter /playlist at play time — harvest one
      // more level so the whole chain is served from memory. Sequential
      // with a small gap: parallel bursts are what trips the proxy's
      // abuse heuristics (a real player fetches one playlist at a time).
      if (text.includes("#EXT-X-STREAM-INF") && depth < 2) {
        const children: string[] = [];
        const parsedVariants: { url: string; score: number }[] = [];
        let curScore = 0;
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith("#EXT-X-MEDIA:")) {
            const uri = trimmed.match(/URI="([^"]+)"/i)?.[1];
            if (uri) {
              try {
                children.push(resolveUrlWithBaseParams(uri, url));
              } catch {}
            }
            continue;
          }
          if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
            const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/i);
            const resMatch = trimmed.match(/RESOLUTION=(\d+)x(\d+)/i);
            const width = resMatch?.[1] ? parseInt(resMatch[1], 10) : 0;
            const bandwidth = bwMatch?.[1] ? parseInt(bwMatch[1], 10) : 0;
            curScore = width > 0 ? width * 10000000 + bandwidth : bandwidth;
            continue;
          }
          if (!trimmed || trimmed.startsWith("#")) continue;
          try {
            parsedVariants.push({
              url: resolveUrlWithBaseParams(trimmed, url),
              score: curScore,
            });
          } catch {}
          curScore = 0;
        }
        // Prioritize highest-quality variants (4K, 1080p, 720p) first
        parsedVariants.sort((a, b) => b.score - a.score);
        for (const v of parsedVariants.slice(
          0,
          VideoScraperService.MAX_VARIANTS_PER_VOD,
        )) {
          children.push(v.url);
        }
        for (const childUrl of children) {
          await harvestOne(childUrl, null, depth + 1);
          await Bun.sleep(300);
        }
      }
    };

    if (body.includes("#EXTM3U") || body.includes("#EXT-X-")) {
      await harvestOne(payload.video.url, body, 0);
    } else {
      // Body-less DOM-src fallback: probe the stream URL server-side once
      // (anti-hotlink hosts may refuse; logged, never fatal).
      await harvestOne(payload.video.url, null, 0);
    }

    if (isMaster && mediaOkCount === 0) {
      logger.warn(
        `Master playlist has variants declared but 0 media variants succeeded harvest for: ${payload.video.url.slice(0, 100)}`,
        "VideoScraperService",
      );
      return 0;
    }

    if (unplayableVariants.size > 0) {
      payload.unplayableVariantUrls = unplayableVariants;
    }
    payload.variantUrls = [...visited];
    logger.info(
      `Harvested ${okCount}/${visited.size} playlist(s) (${Math.round(totalBytes / 1024)}KB${budgetExceeded ? ", budget exceeded — rest fetch live" : ""}) for: ${payload.video.url.slice(0, 100)}`,
      "VideoScraperService",
    );
    return okCount;
  }

  /** Headers safe to forward upstream for our own playlist/segment fetches. */  private static readonly FORWARDABLE_HEADERS = [
    "user-agent",
    "referer",
    "origin",
    "cookie",
    "accept",
    "accept-language",
  ];

  private pickForwardableHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lower = k.toLowerCase();
      if (VideoScraperService.FORWARDABLE_HEADERS.includes(lower) && v) {
        out[lower] = v;
      }
    }
    return out;
  }

  /**
   * Liveness check for a cached payload. Signed stream tokens die within
   * minutes; before serving a stale cached m3u8, ping the playlist so
   * players never receive URLs that 404.
   *
   * The HTTP status alone is not enough: megacloud-family proxies wrap even
   * hard failures in HTTP 200 + an HTML error page disguised as a playlist
   * (rewritten /ts-proxy lines, mpegurl content-type). A dead token therefore
   * "pings green" and would stay cached until the TTL expires, leaving
   * players with a master that loads but whose every variant 502s — so the
   * body must actually contain HLS tags.
   */
  private async isPayloadAlive(payload: CachedVideoPayload): Promise<boolean> {
    if (payload.video.format !== "m3u8") return true;
    if (Date.now() - payload.extractedAt < CONFIG.STREAM_REVALIDATE_MS) return true;

    try {
      const res = await smartFetch(payload.video.url, {
        headers: this.pickForwardableHeaders(payload.video.headers),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return false;
      const text = await res.text();
      return HLS_MARKER_RE.test(text);
    } catch {
      return false;
    }
  }

  /**
   * Normalizes raw rendition candidates into SubtitleTracks, deduplicating
   * URLs and ensuring a single default track. Never throws.
   */
  private normalizeCandidates(
    candidates: RawSubtitleCandidate[],
    requestOrigin: string,
    pageUrl?: string,
  ): SubtitleTrack[] {
    try {
      return normalizeSubtitleTracks(candidates, requestOrigin, pageUrl);
    } catch (err) {
      logger.warn(
        `Subtitle candidate normalization failed: ${err instanceof Error ? err.message : err}`,
        "VideoScraperService",
      );
      return [];
    }
  }

  private formatResult(
    payload: CachedVideoPayload,
    url: string,
    requestOrigin: string,
    fromCache: boolean = false,
  ): ExtractedVideoResult {
    const isHls =
      payload.video.format === "m3u8" ||
      payload.video.url.toLowerCase().includes(".m3u8") ||
      Boolean(payload.video.body?.trim().startsWith("#EXTM3U"));

    // Subtitle tracks from the upstream master's own renditions plus the
    // vidnest-family caption cache and Wyzie. Only raw subtitle files (VTT/SRT) are
    // injected into the synthesized playlist — their /proxy-sub URIs return
    // WebVTT. Rendition playlists stay out (hls.js consumes the upstream
    // declaration directly via the absolute-ized EXT-X-MEDIA passthrough),
    // but all tracks are exposed through the JSON API.
    const subtitles = isHls
      ? filterTracksByLanguages(
          this.normalizeCandidates(payload.subCandidates || [], requestOrigin, url),
          CONFIG.SUBTITLE_LANGUAGES,
        )
      : [];
    // Only raw subtitle files go into the synthesized playlist (their
    // /proxy-sub URIs return WebVTT). Wyzie links declare their format via
    // the query string instead of a file extension, or use translation
    // endpoints (sub.wyzie.io/translate) — accept all raw subtitle tracks.
    // Upstream rendition playlists (.m3u8) stay out (hls.js consumes the
    // upstream declaration directly via the absolute-ized EXT-X-MEDIA passthrough),
    // but all tracks are exposed through the JSON API.
    const playlistSubs = subtitles.filter(
      (t) =>
        !t.isRendition &&
        t.format !== "m3u8" &&
        !/\.m3u8($|[?&])/i.test(t.url) &&
        (/\.(vtt|srt)($|[?&])|format=(vtt|srt)($|&)/i.test(t.url) ||
          isWyzieSubtitleUrl(t.url) ||
          t.format === "vtt" ||
          t.format === "srt"),
    );

    // Variant playlists on these CDNs hang or 404 when a browser fetches
    // them directly (anti-hotlink Referer checks, no CORS headers), so the
    // master always points its variants at strix's /playlist route, which
    // fetches upstream and rewrites every segment through /proxy-chunk.
    const forwardable = this.pickForwardableHeaders(payload.video.headers);
    const cdnReferer = forwardable.referer || url;
    // Some CDNs (cinejoy's lightspeed.st) require the site Origin on variant
    // fetches too, so the /playlist re-entry URLs carry it alongside referer.
    const cdnOriginParam = forwardable.origin
      ? `&origin=${encodeURIComponent(forwardable.origin)}`
      : "";

    // Flatten nested master chains (master → variant master → media playlist)
    // into a single-level master. VLC's adaptive demuxer cannot re-parse a
    // representation that is itself a master playlist — it finds no segments
    // and stalls forever — so players must never be handed an inner master.
    // The harvest cache already holds the inner bodies, so this is free.
    let effectiveBody = payload.video.body || "";
    if (isHls && !effectiveBody.includes("#EXT-X-STREAM-INF")) {
      // Body-less capture (direct-media classification): the harvest cached
      // the stream URL's real body — use it when it's a master.
      const topCached = this.variantBodies.get(payload.video.url);
      if (topCached && topCached.includes("#EXT-X-STREAM-INF")) {
        effectiveBody = topCached;
      }
    }
    if (isHls && effectiveBody.includes("#EXT-X-STREAM-INF")) {
      const flat = flattenMasterChain(
        effectiveBody,
        payload.video.url,
        (u) => this.variantBodies.get(u),
      );
      if (flat) {
        effectiveBody = flat;
        logger.info(
          `Flattened nested master chain (${effectiveBody.split("#EXT-X-STREAM-INF").length - 1} variant(s)) for: ${payload.video.url.slice(0, 100)}`,
          "VideoScraperService",
        );
      }
    }

    // Real movie duration: sum of EXTINF in video media playlists
    // (its body is already in the harvest cache). Passed to the subtitle
    // wrapper playlist so players derive a correct timeline instead of the
    // legacy 86400s (24h) stub.
    if (isHls && playlistSubs.length > 0) {
      let durationSec = payload.duration || 0;
      if (durationSec <= 0) {
        durationSec = extractPlaylistDuration(
          effectiveBody,
          payload.video.url,
          (u) => this.variantBodies.get(u),
        );
      }
      if (durationSec <= 0) {
        // Fallback: check any cached variant body in variantBodies
        for (const variantUrl of payload.variantUrls || []) {
          const b = this.variantBodies.get(variantUrl);
          if (b && b.includes("#EXTINF")) {
            const dur = extractDurationFromMediaPlaylist(b);
            if (dur > 0) {
              durationSec = dur;
              break;
            }
          }
        }
      }
      if (durationSec > 0) {
        const rounded = Math.round(durationSec);
        payload.duration = rounded;
        for (const t of playlistSubs) {
          t.proxyUrl += `&duration=${rounded}`;
        }
      }
      // Cosmetic .m3u8 on the rendition URL: ffmpeg/mpv hls demuxers reject
      // subtitle renditions whose URI lacks a media extension ("Can't support
      // the subtitle"), which makes the whole track invisible in IINA/iSTB.
      // The filename is ignored by the /proxy-sub/:filename handler. ffmpeg
      // reads the extension from the LAST dot of the URL, so dots in the
      // query (wyzie token, hostnames) are percent-encoded to %2E — decoded
      // back transparently server-side — to keep .m3u8 the last one.
      for (const t of playlistSubs) {
        const q = t.proxyUrl.indexOf("?");
        const query = t.proxyUrl
          .slice(q + 1)
          .replace(/\./g, "%2E");
        t.proxyUrl = `${t.proxyUrl
          .slice(0, q)
          .replace("/proxy-sub", "/proxy-sub/subs.m3u8")}?${query}`;
      }
    }

    const masterPlaylist = isHls
      ? buildMasterPlaylistWithSubtitles(
          payload.video.url,
          playlistSubs,
          {
            videoBody: effectiveBody,
            proxySegmentUrl: (targetUrl: string) =>
              `${requestOrigin}/playlist?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(cdnReferer)}${cdnOriginParam}`,
            excludedVariantUrls: payload.unplayableVariantUrls,
          },
        )
      : undefined;

    return {
      video: payload.video,
      duration: payload.duration,
      subtitles,
      masterPlaylist,
      extractedAt: payload.extractedAt,
      fromCache,
    };
  }

  /**
   * One calibration attempt per 5 minutes per payload on the cache-hit path.
   * A transient failure at scrape time (network blip, reference 403) would
   * otherwise pin misaligned Wyzie tracks for the payload's whole 6h TTL,
   * even though a re-run is nearly free — subCache and vdrkProbeCache are
   * warm and the targets filter skips URLs that already have a transform.
   */
  private calibrationRetryGate = new TtlCache<boolean>(5 * 60 * 1000);

  private maybeRetryCalibration(
    cacheKey: string,
    embedUrl: string,
    payload: CachedVideoPayload,
  ): void {
    if (!CONFIG.SUBTITLE_AUTO_SYNC) return;
    if (this.calibrationRetryGate.get(cacheKey)) return;
    const candidates = payload.subCandidates || [];
    const hasPending = candidates.some(
      (c) =>
        isWyzieSubtitleUrl(c.url) &&
        this.subtitleSyncCache.get(c.url) === undefined,
    );
    if (!hasPending) return;
    this.calibrationRetryGate.set(cacheKey, true);
    void this.runSubtitleCalibration(candidates, embedUrl).catch(() => {});
  }

  async extractVideo(
    url: string,
    requestOrigin: string,
    isEmbed: boolean = false,
    signal?: AbortSignal,
    forceFresh: boolean = false,
    server?: string,
  ): Promise<ExtractedVideoResult> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const cacheKey = `vod:${url}${isEmbed ? ":embed:true" : ""}${server ? `:server:${server}` : ""}`;

    if (!forceFresh) {
      const cached = this.videoCache.get(cacheKey);
      if (cached) {
        if (cached.isNotFound) {
          throw new Error("No playable video source found on page");
        }
        if (await this.isPayloadAlive(cached)) {
          this.maybeRetryCalibration(cacheKey, url, cached);
          return this.formatResult(cached, url, requestOrigin, true);
        }
        // Signed tokens died while cached — drop the entry and re-scrape
        // fresh below rather than handing a dead playlist to the player.
        // The harvested variants share the token's fate; purge them too.
        for (const variantUrl of cached.variantUrls || []) {
          this.variantBodies.delete(variantUrl);
        }
        this.videoCache.delete(cacheKey);
        logger.info(
          `Cached stream for ${url} has dead tokens; re-scraping fresh`,
          "VideoScraperService",
        );
      }
    }

    const payload = await runCoalesced(
      this.inFlightScrapes,
      cacheKey,
      (scrapeSignal) =>
        this.doExtractVideo(url, cacheKey, isEmbed, scrapeSignal, server),
      signal,
      () =>
        logger.info(
          `Coalescing concurrent VOD request for: ${url}`,
          "VideoScraperService",
        ),
    );
    return this.formatResult(payload, url, requestOrigin, false);
  }

  private async doExtractVideo(
    url: string,
    cacheKey: string,
    isEmbed: boolean,
    signal?: AbortSignal,
    server?: string,
  ): Promise<CachedVideoPayload> {
    logger.info(`Scraping VOD for: ${url}${server ? " (server: " + server + ")" : ""}`, "VideoScraperService");

    // L1 caption-cache probe starts NOW, not after the browser scrape: it
    // only needs the embed URL, and cache.vdrk.site is slow (0.6-8s observed
    // per file). Racing it across the multi-second browser scrape hides that
    // latency; the subtitle block below just joins the already-running
    // promise. Direct-video sources whose URL happens to parse as a TMDB
    // identity waste up to 8s of *background* fetches — accepted, they're
    // rare and the result is simply discarded.
    const identity = parseEmbedVideoIdentity(url);
    const vdrkProbe = identity
      ? this.probeVdrkSubtitleCache(
          url,
          signal,
          CONFIG.SUBTITLE_LANGUAGES,
        ).catch(() => [] as RawSubtitleCandidate[])
      : null;

    // cinejoy: its extractor runs the whole browser flow itself (including
    // the TMDB stub interception) and returns the master + body directly.
    // The generic engine would just re-open the same page with vidnest
    // selectors and find nothing.
    let videoReq: RequestData | null = null;
    if (CinejoyExtractor.canHandle(url)) {
      try {
        const extracted = await CinejoyExtractor.extract(url, signal);
        videoReq = {
          url: extracted.url,
          method: "GET",
          headers: extracted.headers ?? {},
          resource_type: "media",
          post_data: null,
          body: extracted.body,
        };
      } catch (e) {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        logger.warn(
          `Cinejoy extractor failed for ${url}: ${(e as Error).message}`,
          "VideoScraperService",
        );
      }
    } else {
      videoReq = await scraperEngine.collectVideo(
        url,
        CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
        isEmbed,
        signal,
        server,
      );
    }

    if (!videoReq) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      // Negative cache for 30 seconds to protect against crawler spam
      this.videoCache.set(
        cacheKey,
        {
          video: { url: "", format: "m3u8", headers: {} },
          extractedAt: Date.now(),
          isNotFound: true,
        },
        30000,
      );
      throw new Error("No playable video source found on page");
    }

    let format: "m3u8" | "mp4" | "mkv" | "webm" | "mpd" = "m3u8";
    const vLower = videoReq.url.toLowerCase();
    if (vLower.includes(".mkv") || vLower.includes("video/x-matroska")) {
      format = "mkv";
    } else if (vLower.includes(".mpd") || vLower.includes("dash+xml")) {
      format = "mpd";
    } else if (vLower.includes(".mp4") || vLower.includes("video/mp4")) {
      format = "mp4";
    } else if (vLower.includes(".webm") || vLower.includes("video/webm")) {
      format = "webm";
    }

    let payload: CachedVideoPayload = {
      video: {
        url: videoReq.url,
        format,
        headers: videoReq.headers,
        body: videoReq.body,
      },
      extractedAt: Date.now(),
    };

    // Harvest subtitle renditions declared in the captured master playlist.
    // Free — the body is already in memory, no extra page time.
    if (format === "m3u8" && videoReq.body?.includes("#EXT-X-MEDIA")) {
      try {
        const renditions = parseHlsSubtitleRenditions(videoReq.body, videoReq.url);
        if (renditions.length > 0) {
          payload.subCandidates = renditions;
          logger.info(
            `Parsed ${renditions.length} subtitle rendition(s) from HLS master for: ${url}`,
            "VideoScraperService",
          );
        }
      } catch (_) {}
    }

    // Subtitle resolution, L1 → L2:
    // L1 — the vidnest-family static caption cache (cache.vdrk.site), keyed
    // by TMDB id. Same ecosystem as the stream, so its captions are in sync
    // with the video — probed before Wyzie so synced tracks win, and the
    // GET doubles as prefetch for the player's first caption request.
    // L2 — Wyzie Subtitles API is called directly by TMDB identity for
    // whatever languages L1 lacks. It returns direct SRT links via a single
    // fast JSON call (100-200ms) without pre-downloading full subtitle files
    // during the scrape, maximizing speed.
    if (format === "m3u8") {
      // Join the probe started at the top of this method (see the comment
      // there). The join is capped: if the probe outlives the browser scrape
      // (cache.vdrk.site can hang towards its 8s timeout), waiting for it
      // would put its whole tail latency on the response. A cap alone would
      // silently drop the vdrk tracks from the payload for its whole 6h
      // cache lifetime — so when the cap wins, the late result is merged
      // into the (cached) payload the moment it lands: payload is the same
      // object reference videoCache stores below.
      if (vdrkProbe) {
        try {
          let capped = false;
          const vdrkCandidates = await Promise.race([
            vdrkProbe,
            Bun.sleep(3000).then(() => {
              capped = true;
              return [] as RawSubtitleCandidate[];
            }),
          ]);
          if (vdrkCandidates.length > 0) {
            payload.subCandidates = [
              ...vdrkCandidates,
              ...(payload.subCandidates || []),
            ];
            logger.info(
              `vdrk caption cache: ${vdrkCandidates.length} track(s) (${vdrkCandidates.map((c) => c.language).join(",")}) for: ${url}`,
              "VideoScraperService",
            );
          }
          if (capped) {
            void vdrkProbe.then((late) => {
              if (late.length === 0) return;
              payload.subCandidates = [...late, ...(payload.subCandidates || [])];
              logger.info(
                `vdrk caption cache (late): +${late.length} track(s) merged into cached payload for: ${url}`,
                "VideoScraperService",
              );
            });
          }
        } catch (_) {}
      }
      if (CONFIG.WYZIE_API_KEY && identity) {
        const missing = missingLanguages(
          CONFIG.SUBTITLE_LANGUAGES,
          payload.subCandidates || [],
        );
        if (missing.length > 0) {
          try {
            const wyzieCandidates = await this.probeWyzieSubtitles(
              identity,
              missing,
              signal,
            );
            if (wyzieCandidates.length > 0) {
              payload.subCandidates = [
                ...(payload.subCandidates || []),
                ...wyzieCandidates,
              ];
              logger.info(
                `Wyzie subtitles: +${wyzieCandidates.length} track(s) (missing: ${missing.join(",")}) for: ${url}`,
                "VideoScraperService",
              );
            }
          } catch (_) {}
        }
      }

      if (payload.subCandidates && payload.subCandidates.length > 0) {
        this.prefetchDefaultSubtitles(payload.subCandidates);
        // Fire-and-forget — must never delay the scrape or fail it.
        this.calibrateWyzieSubtitles(payload.subCandidates, url);
      }
    }

    // Variant playlists must be cached before the payload is stored — see
    // harvestVariantPlaylists for why this happens at scrape time. Deliberately
    // NOT tied to the client signal: a player that times out mid-scrape must
    // not skip the harvest, and must never trip the honest-404 path below —
    // that would negative-cache a perfectly healthy source for 30s and 404
    // the very next viewer. The 45s budget bounds the extra work.
    if (format === "m3u8") {
      let harvested = await this.harvestVariantPlaylists(payload);
      if (harvested === 0 && !server) {
        // In auto-mode, if the first preferred server (e.g. Beta/Zeta) has dead/rate-limited variants (429),
        // try alternative preferred servers (Alfa, Beta, Prime, Lamda) before declaring failure.
        const fallbackServers = ["alfa", "beta", "prime", "lamda"];
        for (const altServer of fallbackServers) {
          if (signal?.aborted) break;
          logger.warn(
            `Primary server stream variants failed harvest (unplayable); attempting fallback server "${altServer}" for: ${url}`,
            "VideoScraperService",
          );
          try {
            const altVideoReq = await scraperEngine.collectVideo(
              url,
              CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
              isEmbed,
              signal,
              altServer,
            );
            if (altVideoReq && altVideoReq.url !== payload.video.url) {
              const altPayload: CachedVideoPayload = {
                video: {
                  url: altVideoReq.url,
                  format: "m3u8",
                  headers: altVideoReq.headers,
                  body: altVideoReq.body,
                },
                extractedAt: Date.now(),
                subCandidates: payload.subCandidates,
              };
              const altHarvested = await this.harvestVariantPlaylists(altPayload);
              if (altHarvested > 0) {
                payload = altPayload;
                harvested = altHarvested;
                logger.info(
                  `Successfully recovered with fallback server "${altServer}" (${altHarvested} playlist(s) harvested) for: ${url}`,
                  "VideoScraperService",
                );
                break;
              }
            }
          } catch (_) {}
        }
      }

      if (harvested === 0) {
        // The synthesized master routes every variant through /playlist, so
        // a payload whose playlists are all server-side unfetchable is
        // guaranteed-dead playback ("loads, never plays"). Fail honestly so
        // the caller's fallback page gets its turn; negative-cache briefly
        // to avoid hammering re-scrape loops.
        this.videoCache.set(
          cacheKey,
          {
            video: { url: "", format: "m3u8", headers: {} },
            extractedAt: Date.now(),
            isNotFound: true,
          },
          30000,
        );
        throw new Error("No playable video source found on page");
      }
    }

    this.videoCache.set(cacheKey, payload, CONFIG.VOD_CACHE_TTL_MS);
    return payload;
  }

  /**
   * Applies the calibrated linear time transform for `url`, if one exists.
   * subCache holds RAW (uncalibrated) text only — the transform is a read-time
   * concern (see the subtitleSyncCache field doc for why).
   */
  private applySyncTransform(url: string, vtt: string): string {
    const t = this.subtitleSyncCache.get(url);
    return t ? applyVttTimeTransform(vtt, t.scale, t.offset) : vtt;
  }

  /** Whether a calibrated time transform exists for this subtitle URL.
   * /proxy-sub uses it to keep pre-calibration responses out of long-lived
   * downstream HTTP caches (they are about to become stale). */
  hasSubtitleSync(url: string): boolean {
    return this.subtitleSyncCache.get(url) !== undefined;
  }

  async getSubtitle(
    url: string,
    referer?: string,
    userAgent?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = this.subCache.get(url);
    if (cached) {
      return this.applySyncTransform(url, cached);
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

    // Subtitle sources come in three shapes: raw VTT, SRT, and HLS WebVTT
    // rendition playlists. The latter must be merged into a single document —
    // passing it through srtToVtt would corrupt the playlist. Double-encoded
    // text is repaired inside both paths (per cue document / per segment).
    const toVtt = (raw: string) =>
      raw.trimStart().startsWith("#EXTM3U")
        ? this.mergeRenditionToVtt(raw, url, headers, signal)
        : srtToVtt(maybeFixMojibake(raw));

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
          const vttText = await toVtt(rawText);
          this.subCache.set(url, vttText, CONFIG.SUBTITLE_CACHE_TTL_MS);
          return this.applySyncTransform(url, vttText);
        }
      }
      throw new Error(`Failed to fetch subtitle: HTTP ${res.status}`);
    }

    const rawText = await res.text();
    const vttText = await toVtt(rawText);
    this.subCache.set(url, vttText, CONFIG.SUBTITLE_CACHE_TTL_MS);
    return this.applySyncTransform(url, vttText);
  }

  /**
   * Downloads every segment of a WebVTT rendition playlist with bounded
   * concurrency and merges them into one WebVTT document (stripping repeated
   * WEBVTT headers and applying each segment's X-TIMESTAMP-MAP offset). Lets
   * /proxy-sub serve rendition playlists instead of corrupting them.
   */
  private async mergeRenditionToVtt(
    playlistText: string,
    playlistUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const segmentUrls: string[] = [];
    for (const line of playlistText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        segmentUrls.push(resolveUrlWithBaseParams(trimmed, playlistUrl));
      } catch {}
    }
    if (segmentUrls.length === 0) return "WEBVTT\n\n";

    const loader = new Semaphore(Math.max(4, CONFIG.SCRAPER.MAX_CONCURRENT * 3));
    const texts = await Promise.all(
      segmentUrls.map((segUrl) =>
        loader.run(async () => {
          try {
            const timeoutSignal = AbortSignal.timeout(10000);
            const combined = signal
              ? AbortSignal.any([signal, timeoutSignal])
              : timeoutSignal;
            const res = await smartFetch(segUrl, { headers, signal: combined });
            return res.ok ? await res.text() : "";
          } catch {
            return "";
          }
        }),
      ),
    );
    return mergeHlsVttSegments(texts);
  }

  /**
   * Warms the subtitle cache for the default languages (Vietnamese, English)
   * right after a fresh scrape, so the player's first caption request hits
   * the cache instead of paying the upstream download mid-playback.
   * Fire-and-forget: never blocks or fails the scrape.
   */
  private prefetchDefaultSubtitles(candidates: RawSubtitleCandidate[]): void {
    const preferred = candidates.filter((c) => {
      const tag = candidateLangTag(c);
      return /vietnamese|\bvi\b/.test(tag) || /english|\ben\b/.test(tag);
    });
    const targets = (preferred.length > 0 ? preferred : candidates).slice(0, 2);
    for (const candidate of targets) {
      void this.getSubtitle(candidate.url).catch(() => {});
    }
  }

  /**
   * Fires calibration for every Wyzie track against one reference track that
   * is known in sync with the video, in priority order:
   * 1. an embedded rendition (muxed with the video, in sync by construction),
   * 2. a vdrk caption-cache track (same vidnest ecosystem as the stream).
   * The Wyzie track's language is by definition absent from both (Wyzie only
   * fills missingLanguages), so alignment runs on cue onset times only, which
   * are language-independent. Results land in subtitleSyncCache; the served
   * text is transformed inside getSubtitle. Fire-and-forget: never blocks or
   * fails the scrape.
   */
  private calibrateWyzieSubtitles(
    candidates: RawSubtitleCandidate[],
    embedUrl: string,
  ): void {
    if (!CONFIG.SUBTITLE_AUTO_SYNC) return;
    void this.runSubtitleCalibration(candidates, embedUrl).catch(() => {});
  }

  private async runSubtitleCalibration(
    candidates: RawSubtitleCandidate[],
    embedUrl: string,
  ): Promise<void> {
    const targets = candidates
      .filter(
        (c) =>
          !c.isRendition &&
          (c.format === "srt" || c.format === "vtt") &&
          isWyzieSubtitleUrl(c.url) &&
          this.subtitleSyncCache.get(c.url) === undefined,
      )
      .slice(0, 3); // mirrors the Wyzie candidate cap
    if (targets.length === 0) return;

    // Reference candidates in confidence order: an embedded rendition is
    // muxed with the video, the vdrk caption cache is the same ecosystem.
    // These CDNs frequently reject server-side fetches and masters do ship
    // forced-only renditions — a broken or sparse first reference must fall
    // through to the next one, not kill calibration for every Wyzie track.
    const refs: RawSubtitleCandidate[] = [];
    const renditionRef = this.pickRenditionReference(
      candidates.filter((c) => c.isRendition),
    );
    if (renditionRef) refs.push(renditionRef);
    const vdrkRef = await this.findVdrkSyncReference(embedUrl, targets);
    if (vdrkRef && !refs.some((r) => r.url === vdrkRef.url)) refs.push(vdrkRef);
    if (refs.length === 0) return;

    // prefetchDefaultSubtitles started fetching the first target's URL a
    // moment ago with no in-flight dedup on subCache; a short stagger turns
    // that lookup into a cache hit instead of a duplicate download.
    await Bun.sleep(1500);

    for (const ref of refs) {
      let anyCalibrated = false;
      for (const target of targets) {
        if (this.subtitleSyncCache.get(target.url) !== undefined) continue;
        // Sequential on purpose: each target's reference fetch is a subCache
        // hit off the previous iteration, and parallel getSubtitle calls have
        // no in-flight dedup (they would re-download the reference per target).
        const ok = await this.calibrateSubtitleTrack(target, ref).catch(
          () => false,
        );
        anyCalibrated = anyCalibrated || ok;
      }
      if (anyCalibrated) return;
    }
  }

  /**
   * English renditions are the densest dialogue tracks in practice. Forced/
   * CC/SDH-labeled tracks carry only a handful of cues, so they are excluded
   * from BOTH the preferred pick and the fallback — otherwise a forced-only
   * rendition set would silently starve every alignment (not_enough_cues for
   * all targets) when a dense sibling track was sitting right there.
   */
  private pickRenditionReference(
    renditions: RawSubtitleCandidate[],
  ): RawSubtitleCandidate | undefined {
    const pool = renditions.filter((c) => !/forc|\bcc\b|sdh/i.test(candidateLangTag(c)));
    const candidates = pool.length > 0 ? pool : renditions;
    return (
      candidates.find((c) => /english|\ben\b/i.test(candidateLangTag(c))) ??
      candidates[0]
    );
  }

  /**
   * Probes the vdrk caption cache for a same-ecosystem sync reference. Only
   * dense dialogue languages are worth the requests, and a language that a
   * Wyzie target covers can't serve as its reference (the target exists
   * precisely because that language was missing). Sequential-probe order
   * keeps the common path at one or two requests — English nearly always
   * exists when anything does.
   */
  private async findVdrkSyncReference(
    embedUrl: string,
    targets: RawSubtitleCandidate[],
  ): Promise<RawSubtitleCandidate | null> {
    const excludeLangs = new Set(
      targets.map((t) => (t.language || "").toLowerCase()),
    );
    const preferred = ["en", "es", "fr", "pt", "de", "it", "ru"].filter(
      (code) => !excludeLangs.has(code),
    );
    const candidates = buildVdrkSubtitleCandidates(embedUrl, preferred);
    for (const candidate of candidates) {
      // The L1 probe (probeVdrkSubtitleCache) may have already cached this
      // track during the scrape — reuse it instead of refetching.
      const cached = this.subCache.get(candidate.url);
      if (cached && cached.includes("-->")) return candidate;
      // Sequential on purpose (not probeVdrkSubtitleCache's parallel-all):
      // cache.vdrk.site is slow, English — almost always present when
      // anything is — usually ends this loop at the first request, and
      // vdrkMissCache makes learned 404s free. A transport error just moves
      // on to the next language.
      try {
        if (await this.fetchVdrkVtt(candidate)) return candidate;
      } catch {}
    }
    return null;
  }

  /**
   * Aligns one Wyzie track against the reference and stores the linear
   * transform. Returns true when a transform was stored, false when the
   * fetch failed or the gates rejected — callers use that to fall through
   * to the next reference candidate. subCache keeps its RAW text — serving
   * picks the transform up at read time (applySyncTransform).
   */
  private async calibrateSubtitleTrack(
    target: RawSubtitleCandidate,
    ref: RawSubtitleCandidate,
  ): Promise<boolean> {
    const [targetVtt, refVtt] = await Promise.all([
      this.getSubtitle(target.url).catch(() => null),
      this.getSubtitle(ref.url).catch(() => null),
    ]);
    if (!targetVtt || !refVtt) return false;

    const result = alignSubtitleCues(refVtt, targetVtt, {
      windowSec: CONFIG.SUBTITLE_SYNC_WINDOW_S,
    });
    const shortUrl = target.url.slice(0, 90);
    if (!result.ok) {
      const unchanged =
        result.reason === "low_confidence" ||
        result.reason === "not_better_than_identity" ||
        result.reason === "already_synced";
      logger.info(
        `Subtitle sync: no transform for ${shortUrl} (${result.reason})${unchanged ? " — serving unchanged" : ""}`,
        "SubtitleSync",
      );
      return false;
    }

    const t = result.transform;
    this.subtitleSyncCache.set(target.url, t, CONFIG.SUBTITLE_CACHE_TTL_MS);
    logger.info(
      `Subtitle sync: calibrated ${shortUrl} scale=${t.scale.toFixed(6)} offset=${t.offset.toFixed(2)}s score=${(t.score * 100).toFixed(0)}% (identity ${(t.identityScore * 100).toFixed(0)}%, ${t.matched}/${t.total} cues)`,
      "SubtitleSync",
    );
    return true;
  }

  /**
   * Wyzie fallback: one search call by TMDB id returning direct SRT links.
   * Candidates are registered as-is (no download here) — /proxy-sub fetches
   * and converts lazily when a player actually selects the track, and the
   * result rides the 6h subtitle cache afterwards.
   */
  private async probeWyzieSubtitles(
    identity: { tmdbId: string; season?: number; episode?: number },
    missing: string[],
    signal?: AbortSignal,
  ): Promise<RawSubtitleCandidate[]> {
    const apiKey = CONFIG.WYZIE_API_KEY;
    if (!apiKey) return [];

    const missKey = `wyzie:${identity.tmdbId}:${identity.season ?? 0}:${identity.episode ?? 0}:${missing.slice().sort().join(",")}`;
    if (this.wyzieMissCache.get(missKey)) return [];

    const subtitles = await fetchWyzieSubtitles(apiKey, {
      tmdbId: identity.tmdbId,
      season: identity.season,
      episode: identity.episode,
      languages: missing,
      signal,
    });
    const candidates = wyzieToCandidates(subtitles).slice(0, 3);
    if (candidates.length === 0) {
      this.wyzieMissCache.set(missKey, true);
      return [];
    }

    logger.info(
      `Wyzie fallback: ${candidates.length} direct link(s) (${subtitles.map((s) => s.language).join(",")})`,
      "VideoScraperService",
    );
    return candidates;
  }

  /**
   * Fetches one vdrk caption file and caches the converted text into
   * subCache. Returns null for a DEFINITIVE miss (404 / junk body) — that
   * outcome is recorded in vdrkMissCache so the same URL is never re-fetched
   * within the TTL. THROWS on transport failures (timeout, network, abort):
   * callers must not treat those as misses, and the probe skips its result
   * cache when any occur — a transient cache.vdrk.site outage must not
   * freeze a 15-minute subtitle blackout into vdrkProbeCache.
   */
  private async fetchVdrkVtt(
    candidate: RawSubtitleCandidate,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (this.vdrkMissCache.get(candidate.url)) return null;
    const timeoutSignal = AbortSignal.timeout(8000);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const res = await fetch(candidate.url, { signal: combined });
    if (!res.ok) {
      this.vdrkMissCache.set(candidate.url, true);
      return null;
    }
    const vtt = srtToVtt(maybeFixMojibake(await res.text()));
    if (!vtt.includes("-->")) {
      this.vdrkMissCache.set(candidate.url, true);
      return null;
    }
    this.subCache.set(candidate.url, vtt, CONFIG.SUBTITLE_CACHE_TTL_MS);
    return vtt;
  }

  /**
   * Probes the static vidnest-family subtitle cache (cache.vdrk.site) for
   * tracks matching the embed's TMDB identity; non-existent languages 404
   * and are silently dropped.
   */
  private async probeVdrkSubtitleCache(
    embedUrl: string,
    signal?: AbortSignal,
    allowedCodes?: string[] | "*",
  ): Promise<RawSubtitleCandidate[]> {
    const identity = parseEmbedVideoIdentity(embedUrl);
    if (!identity) return [];

    // Keyed by TMDB identity, not the raw embed URL: the primary-then-
    // fallback scrape flow tries different embed providers for the same id,
    // and the fallback's probe should reuse the primary's outcome instead of
    // re-issuing the same slow GETs against cache.vdrk.site.
    const probeKey = `vdrk:${identity.kind}:${identity.tmdbId}:${identity.season ?? 0}:${identity.episode ?? 0}|${
      Array.isArray(allowedCodes) ? allowedCodes.join(",") : allowedCodes ?? "*"
    }`;
    const cachedProbe = this.vdrkProbeCache.get(probeKey);
    if (cachedProbe) return cachedProbe;

    const candidates = buildVdrkSubtitleCandidates(embedUrl, allowedCodes);
    if (candidates.length === 0) return [];

    // Probe = GET + convert + cache in one pass. Cancelling the response
    // body of parallel requests to the same host proved flaky under Bun's
    // connection pool (one cancel reset the other request), and downloading
    // anyway doubles as prefetch: the player's first subtitle request then
    // hits the cache instead of the network.
    let transportFailed = false;
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return (await this.fetchVdrkVtt(candidate, signal)) ? candidate : null;
        } catch {
          transportFailed = true;
          return null;
        }
      }),
    );

    const found = results.filter((c): c is RawSubtitleCandidate => c !== null);
    // Don't persist an outcome tainted by transport errors or an aborted
    // scrape — either would freeze a (partially) empty probe into the cache,
    // a 15-minute subtitle blackout that no request path retries sooner.
    if (!signal?.aborted && !transportFailed) {
      this.vdrkProbeCache.set(probeKey, found);
    }
    return found;
  }
}

export const videoScraperService = new VideoScraperService();
