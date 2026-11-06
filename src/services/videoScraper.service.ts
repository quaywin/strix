import { CONFIG } from "../config";
import { logger } from "../logger";
import { scraperEngine } from "../scraper/ScraperEngine";
import {
  buildVdrkSubtitleCandidates,
  parseEmbedVideoIdentity,
} from "../utils/embedSubtitles";
import { fetchWyzieSubtitles, wyzieToCandidates } from "../utils/wyzie";
import { smartFetch } from "../utils/http";
import {
  buildMasterPlaylistWithSubtitles,
  parseHlsSubtitleRenditions,
  rewriteM3u8Playlist,
  resolveUrlWithBaseParams,
} from "../utils/m3u8";
import {
  maybeFixMojibake,
  mergeHlsVttSegments,
  filterTracksByLanguages,
  missingLanguages,
  srtToVtt,
  normalizeSubtitleTracks,
  type RawSubtitleCandidate,
  type SubtitleTrack,
} from "../utils/subtitles";
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
  extractedAt: number;
  isNotFound?: boolean;
  /** Raw candidates from the master body + caption cache; normalized per-request. */
  subCandidates?: RawSubtitleCandidate[];
}

/**
 * Megacloud-family /proxy endpoints never answer with a real HTTP error:
 * upstream failures come back as HTTP 200 + an HTML error page whose lines
 * are rewritten into fake /ts-proxy "segment" URLs, served even with an
 * application/vnd.apple.mpegurl content-type. The only reliable error signal
 * is the absence of HLS tags in the body.
 */
const HLS_MARKER_RE = /#EXTM3U|#EXTINF|#EXT-X-/;

export class VideoScraperService {
  private videoCache = new TtlCache<CachedVideoPayload>(CONFIG.VOD_CACHE_TTL_MS);
  private subCache = new TtlCache<string>(CONFIG.SUBTITLE_CACHE_TTL_MS);
  /** Titles Wyzie had no subs for — protects the API quota on re-scrapes. */
  private wyzieMissCache = new TtlCache<boolean>(24 * 60 * 60 * 1000);
  private inFlightScrapes = new Map<string, InFlightEntry<CachedVideoPayload>>();

  invalidateCache(url: string): boolean {
    return this.videoCache.deletePrefix(`vod:${url}`);
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
  ): Promise<string> {
    const headers: Record<string, string> = {};
    if (referer) headers["referer"] = referer;

    // Error pages can come back with 200/3xx statuses — never hand them to
    // the player disguised as a playlist. Some upstreams (megacloud /proxy)
    // omit the #EXTM3U header entirely while still being valid media
    // playlists (EXTINF lines + segment URLs), so require any HLS tag.
    const fetchAndValidate = async (): Promise<string> => {
      const res = await smartFetch(playlistUrl, {
        headers,
        signal: signal || AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        throw new Error(`Upstream playlist fetch failed: HTTP ${res.status}`);
      }
      const text = await res.text();
      if (!HLS_MARKER_RE.test(text)) {
        throw new Error("Upstream playlist response is not an m3u8 document");
      }
      return text.includes("#EXTM3U") ? text : `#EXTM3U\n${text}`;
    };

    // Megacloud-family proxies respond to short bursts with the disguised
    // error page above for a few seconds/minutes at a time. Retry with a
    // small backoff before giving the player a 502 — a bare failure here
    // kills playback outright, while the same token usually serves a valid
    // playlist moments later.
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1000, 2500];
    let normalized: string | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      try {
        normalized = await fetchAndValidate();
        break;
      } catch (e) {
        if (
          signal?.aborted ||
          (e as Error).name === "AbortError" ||
          attempt === MAX_ATTEMPTS - 1
        ) {
          throw e;
        }
        lastError = e;
        logger.warn(
          `Playlist fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed for ${playlistUrl.slice(0, 120)} (${(e as Error).message}); retrying in ${BACKOFF_MS[attempt]}ms`,
          "VideoScraperService",
        );
        await Bun.sleep(BACKOFF_MS[attempt] ?? 2500);
      }
    }
    if (normalized === undefined) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Upstream playlist fetch failed");
    }

    // Two playlist shapes with different child-URL routing:
    // - nested MASTER (#EXT-X-STREAM-INF): its children are playlists too
    //   (variants, audio renditions) — they must re-enter /playlist so their
    //   own segments get rewritten;
    // - MEDIA playlist: every URI line is a segment — straight to
    //   /proxy-chunk.
    const isNestedMaster = normalized.includes("#EXT-X-STREAM-INF");
    const refererParam = encodeURIComponent(referer || playlistUrl);
    return rewriteM3u8Playlist(normalized, playlistUrl, {
      proxySegmentUrl: (targetUrl) =>
        isNestedMaster
          ? `${requestOrigin}/playlist?url=${encodeURIComponent(targetUrl)}&referer=${refererParam}`
          : `${requestOrigin}/proxy-chunk?url=${encodeURIComponent(targetUrl)}&referer=${refererParam}`,
    });
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
          /sub\.wyzie\.io/i.test(t.url) ||
          t.format === "vtt" ||
          t.format === "srt"),
    );

    // Variant playlists on these CDNs hang or 404 when a browser fetches
    // them directly (anti-hotlink Referer checks, no CORS headers), so the
    // master always points its variants at strix's /playlist route, which
    // fetches upstream and rewrites every segment through /proxy-chunk.
    const cdnReferer =
      this.pickForwardableHeaders(payload.video.headers).referer || url;
    const masterPlaylist = isHls
      ? buildMasterPlaylistWithSubtitles(
          payload.video.url,
          playlistSubs,
          {
            videoBody: payload.video.body,
            proxySegmentUrl: (targetUrl: string) =>
              `${requestOrigin}/playlist?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(cdnReferer)}`,
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
        if (await this.isPayloadAlive(cached)) {
          return this.formatResult(cached, url, requestOrigin, true);
        }
        // Signed tokens died while cached — drop the entry and re-scrape
        // fresh below rather than handing a dead playlist to the player.
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
        this.doExtractVideo(url, cacheKey, isEmbed, scrapeSignal),
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
  ): Promise<CachedVideoPayload> {
    logger.info(`Scraping VOD for: ${url}`, "VideoScraperService");

    const videoReq = await scraperEngine.collectVideo(
      url,
      CONFIG.SCRAPER.DEFAULT_TIMEOUT / 1000,
      isEmbed,
      signal,
    );

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

    const payload: CachedVideoPayload = {
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

    // Subtitle resolution: Wyzie Subtitles API is called directly by TMDB identity.
    // It returns direct SRT links via a single fast JSON call (100-200ms) without pre-downloading
    // full subtitle files during the scrape, maximizing speed.
    if (format === "m3u8") {
      const identity = parseEmbedVideoIdentity(url);
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
      }
    }

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
          return vttText;
        }
      }
      throw new Error(`Failed to fetch subtitle: HTTP ${res.status}`);
    }

    const rawText = await res.text();
    const vttText = await toVtt(rawText);
    this.subCache.set(url, vttText, CONFIG.SUBTITLE_CACHE_TTL_MS);
    return vttText;
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
      const tag = `${c.label || ""} ${c.language || ""}`.toLowerCase();
      return /vietnamese|\bvi\b/.test(tag) || /english|\ben\b/.test(tag);
    });
    const targets = (preferred.length > 0 ? preferred : candidates).slice(0, 2);
    for (const candidate of targets) {
      void this.getSubtitle(candidate.url).catch(() => {});
    }
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
   * Probes the static vidnest-family subtitle cache (cache.vdrk.site) for
   * tracks matching the embed's TMDB identity. Cheap headers-only requests;
   * non-existent languages 404 and are silently dropped.
   */
  private async probeVdrkSubtitleCache(
    embedUrl: string,
    signal?: AbortSignal,
    allowedCodes?: string[] | "*",
  ): Promise<RawSubtitleCandidate[]> {
    const candidates = buildVdrkSubtitleCandidates(embedUrl, allowedCodes);
    if (candidates.length === 0) return [];

    // Probe = GET + convert + cache in one pass. Cancelling the response
    // body of parallel requests to the same host proved flaky under Bun's
    // connection pool (one cancel reset the other request), and downloading
    // anyway doubles as prefetch: the player's first subtitle request then
    // hits the cache instead of the network.
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const timeoutSignal = AbortSignal.timeout(8000);
          const combined = signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;
          const res = await fetch(candidate.url, { signal: combined });
          if (!res.ok) return null;
          const vtt = srtToVtt(maybeFixMojibake(await res.text()));
          if (!vtt.includes("-->")) return null;
          this.subCache.set(candidate.url, vtt, CONFIG.SUBTITLE_CACHE_TTL_MS);
          return candidate;
        } catch {
          return null;
        }
      }),
    );

    return results.filter((c): c is RawSubtitleCandidate => c !== null);
  }
}

export const videoScraperService = new VideoScraperService();
