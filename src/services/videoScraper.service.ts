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
import { TtlCache } from "../utils/ttlCache";
import { runCoalesced, type InFlightEntry } from "../utils/inFlight";

export interface VideoStreamInfo {
  url: string;
  format: "m3u8" | "mp4" | "mkv" | "webm" | "mpd";
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

export class VideoScraperService {
  private videoCache = new TtlCache<CachedVideoPayload>(CONFIG.VOD_CACHE_TTL_MS);
  private subCache = new TtlCache<string>(CONFIG.SUBTITLE_CACHE_TTL_MS);
  private inFlightScrapes = new Map<string, InFlightEntry<CachedVideoPayload>>();

  invalidateCache(url: string): boolean {
    return this.videoCache.deletePrefix(`vod:${url}`);
  }

  private formatResult(
    payload: CachedVideoPayload,
    url: string,
    requestOrigin: string,
    fromCache: boolean = false,
    wantProxy: boolean = false,
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

    // Default: resolve segment URIs to their direct absolute upstream URLs.
    // Only wrap them in /proxy-chunk when the caller explicitly asks for it.
    const masterPlaylist = isHls
      ? buildMasterPlaylistWithSubtitles(
          payload.video.url,
          subtitles,
          {
            videoBody: payload.video.body,
            ...(wantProxy
              ? {
                  proxySegmentUrl: (targetUrl: string) => {
                    return `${requestOrigin}/proxy-chunk?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(url)}`;
                  },
                }
              : {}),
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
    wantProxy: boolean = false,
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
        return this.formatResult(cached, url, requestOrigin, true, wantProxy);
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
    return this.formatResult(payload, url, requestOrigin, false, wantProxy);
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

  /**
   * Spawns an FFmpeg remuxing process to stream an MKV container with all
   * extracted subtitles integrated as native subtitle tracks.
   */
  async streamRemuxedMkv(
    videoUrl: string,
    subtitles: SubtitleTrack[],
    options: {
      seekSeconds?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    // Prioritize default track, Vietnamese and English first, capped at 15 tracks
    const sortedSubs = [...subtitles].sort((a, b) => {
      if (a.default && !b.default) return -1;
      if (!a.default && b.default) return 1;
      if (a.language === "vi" && b.language !== "vi") return -1;
      if (a.language !== "vi" && b.language === "vi") return 1;
      if (a.language === "en" && b.language !== "en") return -1;
      if (a.language !== "en" && b.language === "en") return 1;
      return 0;
    });
    const activeSubs = sortedSubs.slice(0, 15);

    // Step 1: Pre-fetch all subtitle tracks concurrently into local memory/temp
    // (Bypasses slow sequential TCP handshakes inside FFmpeg)
    const downloadedSubs: Array<{ sub: SubtitleTrack; filePath: string }> = [];
    const tmpDir = `/tmp/strix-remux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();

    try {
      await Promise.all(
        activeSubs.map(async (sub, idx) => {
          try {
            const timeoutSignal = AbortSignal.timeout(3000);
            const combinedSignal = options.signal
              ? AbortSignal.any([options.signal, timeoutSignal])
              : timeoutSignal;
            const vttText = await this.getSubtitle(sub.url, undefined, undefined, combinedSignal);
            const subFilePath = `${tmpDir}/sub_${idx}.vtt`;
            await Bun.write(subFilePath, vttText);
            downloadedSubs.push({ sub, filePath: subFilePath });
          } catch (_) {}
        }),
      );

      const args: string[] = [CONFIG.FFMPEG_PATH, "-loglevel", "error"];

      // Fast seek prior to input if seek timestamp provided
      if (options.seekSeconds && options.seekSeconds > 0) {
        args.push("-ss", String(options.seekSeconds));
      }

      // Input 0: Video stream
      args.push("-i", videoUrl);

      // Inputs 1..N: Pre-downloaded local subtitle files (Zero network delay!)
      for (const item of downloadedSubs) {
        if (options.seekSeconds && options.seekSeconds > 0) {
          args.push("-ss", String(options.seekSeconds));
        }
        args.push("-i", item.filePath);
      }

      // Map video and audio from input 0
      args.push("-map", "0:v", "-map", "0:a");

      // Map each subtitle stream and assign language/title metadata
      downloadedSubs.forEach((item, idx) => {
        args.push("-map", `${idx + 1}:s`);
        args.push(`-metadata:s:s:${idx}`, `language=${item.sub.language}`);
        args.push(`-metadata:s:s:${idx}`, `title=${item.sub.label}`);
        if (item.sub.default) {
          args.push(`-disposition:s:${idx}`, "default");
        }
      });

      // Zero-encoding: copy all video, audio, and subtitle bitstreams directly into Matroska container
      args.push("-c", "copy", "-f", "matroska", "pipe:1");

      logger.info(
        `Launching FFmpeg remux for ${videoUrl} with ${downloadedSubs.length} local subtitles (seek: ${options.seekSeconds || 0}s)`,
        "VideoScraperService",
      );

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (proc.stderr) {
        (async () => {
          try {
            const errText = await new Response(proc.stderr).text();
            if (errText.trim()) {
              logger.error(`FFmpeg stderr: ${errText.slice(0, 1000)}`, "VideoScraperService");
            }
          } catch (_) {}
        })();
      }

      const stream = new ReadableStream({
        async start(controller) {
          const reader = proc.stdout.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          } finally {
            try {
              proc.kill();
            } catch (_) {}
            await Bun.$`rm -rf ${tmpDir}`.quiet().catch(() => {});
          }
        },
        cancel() {
          try {
            proc.kill();
          } catch (_) {}
          Bun.$`rm -rf ${tmpDir}`.quiet().catch(() => {});
        },
      });

      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            try {
              proc.kill();
            } catch (_) {}
            Bun.$`rm -rf ${tmpDir}`.quiet().catch(() => {});
          },
          { once: true },
        );
      }

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "video/x-matroska",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
    } catch (err) {
      await Bun.$`rm -rf ${tmpDir}`.quiet().catch(() => {});
      throw err;
    }
  }
}

export const videoScraperService = new VideoScraperService();
