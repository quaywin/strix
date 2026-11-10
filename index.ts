import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { CONFIG } from "./src/config";
import { logger } from "./src/logger";
import { isM3u8StreamUrl } from "./src/scraper/ScraperEngine";
import {
  NoSourceFoundError,
  scraperService,
} from "./src/services/scraper.service";
import { videoScraperService } from "./src/services/videoScraper.service";
import { isWyzieSubtitleUrl } from "./src/utils/subtitles";
import {
  DEFAULT_USER_AGENT,
  getHeader,
  getRequestOrigin,
  smartFetch,
  unwrapProxyUrl,
} from "./src/utils/http";
import { proxyChunkUrl, rewriteM3u8Playlist } from "./src/utils/m3u8";
import { needsUnwrap, unwrapChunk } from "./src/utils/cvUnwrap";

export const handleScrapeStream = async (
  query: {
    url?: string;
    proxy?: string;
    sub?: string;
    format?: string;
    json?: string;
    proxy_segments?: string;
    proxy_all?: string;
    embed?: string;
    is_embed?: string;
    unwrap?: string;
  },
  request: Request,
): Promise<Response> => {
  const {
    url,
    proxy,
    sub,
    format,
    json,
    proxy_segments,
    proxy_all,
    embed,
    is_embed,
    unwrap,
  } = query;
  if (!url) {
    return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const wantProxy = proxy === "1" || proxy === "true";
  const wantSub =
    sub === "1" ||
    sub === "true" ||
    (wantProxy && sub !== "0" && sub !== "false");
  const wantJson = format === "json" || json === "1" || json === "true";
  const wantProxySegments =
    proxy_segments === "1" ||
    proxy_segments === "true" ||
    proxy_all === "1" ||
    proxy_all === "true";
  const wantEmbed =
    embed === "1" ||
    embed === "true" ||
    is_embed === "1" ||
    is_embed === "true";

  // Forward the client Range header in proxy mode so mp4/mkv clients can
  // seek; ignored for non-proxy mode (we just 302 to the stream URL).
  const range = request.headers.get("range");
  try {
    if (wantJson) {
      const extracted = await scraperService.extractStream(
        url,
        wantSub,
        wantEmbed,
        request.signal,
      );
      return new Response(JSON.stringify(extracted), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!wantProxy) {
      const { url: streamUrl } = await scraperService.extractStream(
        url,
        wantSub,
        wantEmbed,
        request.signal,
      );
      return Response.redirect(streamUrl, 302);
    }

    // Proxy mode: fetch upstream and stream the body back to the client.
    // If upstream returns an error (404/403/502) on a cached stream URL older than 15s,
    // the channel may have rotated or signed token expired. We perform a fresh scrape
    // and retry to seamlessly recover without stalling the player.
    const proxyOnce = async (
      forceFresh: boolean = false,
    ): Promise<{
      response: Response;
      fromCache: boolean;
      extractedAt: number;
    }> => {
      const extracted = await scraperService.extractStream(
        url,
        wantSub,
        wantEmbed,
        request.signal,
        forceFresh,
      );
      const {
        url: streamUrl,
        headers: upstreamHeaders,
        body: cachedBody,
        fromCache = false,
        extractedAt = Date.now(),
      } = extracted;

      const requestHeaders = new Headers();
      if (upstreamHeaders) {
        for (const [key, value] of Object.entries(upstreamHeaders)) {
          requestHeaders.set(key, value);
        }
      }

      const isM3u8Url = isM3u8StreamUrl(streamUrl);
      const hasExtM3uBody = Boolean(cachedBody?.trim().startsWith("#EXTM3U"));
      const isKnownM3u8 = isM3u8Url || hasExtM3uBody;

      if (isKnownM3u8) {
        // Strip Range for m3u8 playlist manifests and force uncompressed delivery.
        // Forwarding Range: bytes=0- on playlists causes upstream CDNs to reply
        // with HTTP 206 Partial Content in gzip encoding, triggering Bun's ZlibError.
        requestHeaders.set("accept-encoding", "identity");
      } else if (range) {
        requestHeaders.set("range", range);
      }

      const timeoutSignal = AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS);
      const upstreamSignal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;

      let upstream = await smartFetch(streamUrl, {
        signal: upstreamSignal,
        headers: requestHeaders,
        range: isKnownM3u8 ? null : range,
      });
      if (!upstream.ok) {
        let snippet = "";
        try {
          const bodyText = await upstream.text();
          snippet = bodyText.slice(0, 300);
        } catch (_) {}

        // Handle edge transcoder warming phase (e.g. Pecufa/Matchora returns HTTP 404 with "warming" for 1-5s)
        let isWarming =
          (upstream.status === 404 || upstream.status === 503) &&
          snippet.toLowerCase().includes("warming");

        let warmingRetries = 0;
        const MAX_WARMING_RETRIES = 2; // Up to 2 retries with 1.5s delay (total 3 attempts)
        while (
          isWarming &&
          warmingRetries < MAX_WARMING_RETRIES &&
          !request.signal.aborted
        ) {
          warmingRetries++;
          logger.info(
            `Upstream edge transcoder is warming (${streamUrl}), retrying in 1.5s (${warmingRetries}/${MAX_WARMING_RETRIES})...`,
            "App",
          );
          await Bun.sleep(1500);
          if (request.signal.aborted) break;

          const retryTimeoutSignal = AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS);
          const retrySignal = request.signal
            ? AbortSignal.any([request.signal, retryTimeoutSignal])
            : retryTimeoutSignal;
          const retryUpstream = await smartFetch(streamUrl, {
            signal: retrySignal,
            headers: requestHeaders,
            range: isKnownM3u8 ? null : range,
          });
          if (retryUpstream.ok) {
            upstream = retryUpstream;
            snippet = "";
            isWarming = false;
            break;
          } else {
            try {
              snippet = (await retryUpstream.text()).slice(0, 300);
            } catch (_) {
              snippet = "";
            }
            upstream = retryUpstream;
            isWarming =
              (upstream.status === 404 || upstream.status === 503) &&
              snippet.toLowerCase().includes("warming");
          }
        }

        if (!upstream.ok) {
          const isOffline =
            upstream.status === 404 ||
            upstream.status === 502 ||
            upstream.status === 503 ||
            upstream.status === 504;
          logger.warn(
            `Upstream fetch failed: HTTP ${upstream.status} for ${streamUrl}${snippet ? `. Response: ${snippet}` : ""}`,
            "App",
          );
          return {
            response: new Response(
              JSON.stringify({
                error: isOffline
                  ? `Upstream stream is offline or unavailable (HTTP ${upstream.status})`
                  : `Upstream returned ${upstream.status}`,
                upstreamStatus: upstream.status,
                upstreamSnippet: snippet || undefined,
              }),
              {
                status: isOffline ? 404 : 502,
                headers: { "Content-Type": "application/json" },
              },
            ),
            fromCache,
            extractedAt,
          };
        }
      }
      const headers = new Headers();
      const contentType = upstream.headers.get("Content-Type");
      if (contentType) headers.set("Content-Type", contentType);
      // Forward Range-related headers so HTTP-byterange seeking works for
      // mp4/mkv. Harmless for HLS (.m3u8) responses.
      const contentRange = upstream.headers.get("Content-Range");
      if (contentRange) headers.set("Content-Range", contentRange);
      const acceptRanges = upstream.headers.get("Accept-Ranges");
      if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);
      const contentLength = upstream.headers.get("Content-Length");
      if (contentLength) headers.set("Content-Length", contentLength);

      const contentTypeLower = contentType?.toLowerCase() || "";
      const isMpegUrlType =
        contentTypeLower.includes("mpegurl") ||
        contentTypeLower.includes("m3u8");
      const isBinaryVideoType =
        !isMpegUrlType &&
        (contentTypeLower.startsWith("video/") ||
          contentTypeLower.startsWith("audio/") ||
          /\.(mp4|mkv|webm|ts|m4s)($|\?)/i.test(streamUrl));

      // Determine if content is HLS playlist (#EXTM3U) even if URL has no .m3u8
      let isM3u8 = (isKnownM3u8 || isMpegUrlType) && !isBinaryVideoType;
      let text: string | null = null;

      if (isM3u8 || !isBinaryVideoType) {
        try {
          text = await upstream.text();
          if (text.trim().startsWith("#EXTM3U")) {
            isM3u8 = true;
          }
        } catch (decompError) {
          logger.warn(
            `Decompression error on stream (${(decompError as Error).message}), retrying with identity encoding...`,
            "App",
          );
          requestHeaders.set("accept-encoding", "identity");
          requestHeaders.delete("range");
          const retryTimeoutSignal = AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS);
          const retrySignal = request.signal
            ? AbortSignal.any([request.signal, retryTimeoutSignal])
            : retryTimeoutSignal;
          upstream = await smartFetch(streamUrl, {
            signal: retrySignal,
            headers: requestHeaders,
            range: null,
          });
          text = await upstream.text();
          if (text.trim().startsWith("#EXTM3U")) {
            isM3u8 = true;
          }
        }
      }

      if (text !== null) {
        const trimmed = text.trim();
        if (trimmed.startsWith("#EXTM3U")) {
          isM3u8 = true;
        } else {
          isM3u8 = false;
        }
      }

      // Safeguard: Never attempt to rewrite an HTML error/embed page as an M3U8 playlist
      if (
        !isM3u8 &&
        text !== null &&
        (text.trim().startsWith("<!DOCTYPE") ||
          text.trim().startsWith("<html") ||
          text.trim().startsWith("<meta"))
      ) {
        logger.warn(
          `Upstream returned HTML document instead of M3U8 stream for ${streamUrl}`,
          "App",
        );
        return {
          response: new Response(
            JSON.stringify({
              error: "Upstream returned HTML document instead of M3U8 stream",
              upstreamSnippet: text.slice(0, 300),
            }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          ),
          fromCache,
          extractedAt,
        };
      }

      if (isM3u8 && text !== null) {
        const requestOrigin = getRequestOrigin(request);
        const upstreamReferer = getHeader(upstreamHeaders, "referer");
        const upstreamUserAgent = getHeader(upstreamHeaders, "user-agent");

        const proxySegmentUrl = wantProxySegments
          ? (absUrl: string) => {
              const params = new URLSearchParams();
              params.set("url", absUrl);
              params.set("source", url);
              if (upstreamReferer) {
                params.set("referer", upstreamReferer);
              }
              if (upstreamUserAgent) {
                params.set("ua", upstreamUserAgent);
              }
              if (unwrap === "1" || unwrap === "true") {
                params.set("unwrap", "1");
              }
              return proxyChunkUrl(requestOrigin, absUrl, params.toString());
            }
          : undefined;

        const rewrittenBody = rewriteM3u8Playlist(text, streamUrl, {
          proxySegmentUrl,
        });

        headers.set("Content-Type", "application/vnd.apple.mpegurl");
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        headers.set("Pragma", "no-cache");
        headers.set("Expires", "0");
        headers.delete("Content-Length"); // Length changed due to URL rewriting
        headers.delete("Content-Range");
        headers.delete("Content-Encoding");

        return {
          response: new Response(rewrittenBody, {
            status: 200,
            headers,
          }),
          fromCache,
          extractedAt,
        };
      }

      // For binary video (mp4/mkv), stream directly with Range support
      return {
        response: new Response(text !== null ? text : upstream.body, {
          status: upstream.status,
          headers,
        }),
        fromCache,
        extractedAt,
      };
    };

    let { response, fromCache, extractedAt } = await proxyOnce();

    if (!response.ok) {
      // If the failed upstream request was using a cached stream URL older than 15s,
      // the channel may have rotated (e.g. Pecufa/Matchora) or signed token expired (e.g. 404/403/502).
      // We re-scrape once reactively to seamlessly recover the new stream without stalling the player.
      const isStaleEligible = fromCache && Date.now() - extractedAt >= 15_000;
      if (isStaleEligible) {
        logger.warn(
          `Proxy got upstream error (HTTP ${response.status}) on cached stream for ${url} (age: ${Math.round((Date.now() - extractedAt) / 1000)}s); retrying once with fresh scrape`,
          "App",
        );
        try {
          const retry = await proxyOnce(true);
          if (retry.response.ok) {
            scraperService.invalidateCache(url, extractedAt);
          }
          response = retry.response;
        } catch (e) {
          logger.warn(
            `Fresh scrape recovery attempt failed for ${url}: ${(e as Error).message}`,
            "App",
          );
        }
      }
    }
    return response;
  } catch (e) {
    const error = e as Error;
    // Client disconnected / switched channel -> 499 (Client Closed Request).
    // No playable source on the page -> 404 (client-side problem).
    // Upstream fetch timeout -> 504 (gateway timeout).
    // Anything else -> 500 (genuine server-side failure).
    const isAborted = request.signal.aborted || error.name === "AbortError";
    const status = isAborted
      ? 499
      : e instanceof NoSourceFoundError
        ? 404
        : error.name === "TimeoutError"
          ? 504
          : 500;
    return new Response(
      JSON.stringify({
        error: isAborted ? "Client cancelled request" : error.message,
      }),
      {
        status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

export const handleScrapeVideo = async (
  query: {
    url?: string;
    fallback?: string;
    proxy?: string;
    format?: string;
    json?: string;
    embed?: string;
    is_embed?: string;
    server?: string;
  },
  request: Request,
): Promise<Response> => {
  const { url, fallback, proxy, format, json, embed, is_embed, server } = query;
  if (!url) {
    return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const wantJson = format === "json" || json === "1" || json === "true";
  const wantProxy = proxy === "1" || proxy === "true";
  const wantEmbed =
    embed === "1" || embed === "true" || is_embed === "1" || is_embed === "true";
  const requestOrigin = getRequestOrigin(request);

  try {
    // Primary scrape; on failure fall back to the backup page URL (e.g.
    // videasy.ws) before giving up. Client aborts are never retried.
    let effectiveUrl = url;
    let extracted;
    try {
      extracted = await videoScraperService.extractVideo(
        url,
        requestOrigin,
        wantEmbed,
        request.signal,
        false,
        server,
      );
    } catch (primaryErr: any) {
      if (
        !fallback ||
        request.signal?.aborted ||
        primaryErr?.name === "AbortError"
      ) {
        throw primaryErr;
      }
      logger.warn(
        `Primary VOD scrape failed for ${url} (${primaryErr?.message}); trying fallback ${fallback}`,
        "ScrapeVideo",
      );
      effectiveUrl = fallback;
      extracted = await videoScraperService.extractVideo(
        fallback,
        requestOrigin,
        wantEmbed,
        request.signal,
        false,
        server,
      );
    }

    const isM3u8 =
      extracted.video.format === "m3u8" ||
      extracted.video.url.toLowerCase().includes(".m3u8") ||
      Boolean(extracted.video.body?.trim().startsWith("#EXTM3U"));

    // DASH manifests are returned as-is: segments inside an .mpd are resolved
    // relative to the manifest URL and carry their own signed query params,
    // so wrapping only the manifest in the proxy would break playback.
    const isMpd = extracted.video.format === "mpd";
    const directStreamUrl =
      wantProxy && !isMpd
        ? proxyChunkUrl(
            requestOrigin,
            extracted.video.url,
            `url=${encodeURIComponent(extracted.video.url)}&referer=${encodeURIComponent(effectiveUrl)}`,
          )
        : extracted.video.url;

    if (wantJson) {
      // Wrapper URLs point at whichever page actually yielded the stream, and
      // carry the fallback along so wrapper routes keep failing over too.
      const fallbackParam = fallback
        ? `&fallback=${encodeURIComponent(fallback)}`
        : "";
      const serverParam = server ? `&server=${encodeURIComponent(server)}` : "";
      const masterUrl = isM3u8
        ? `${requestOrigin}/scrape-video/master.m3u8?url=${encodeURIComponent(effectiveUrl)}${fallbackParam}${wantEmbed ? "&embed=true" : ""}${serverParam}`
        : undefined;

      return new Response(
        JSON.stringify({
          format: isM3u8 ? "m3u8" : extracted.video.format,
          video: extracted.video,
          duration: extracted.duration,
          subtitles: extracted.subtitles,
          streamUrl: directStreamUrl,
          masterPlaylistUrl: masterUrl,
          extractedAt: extracted.extractedAt,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Direct video formats (MKV, MP4, WebM):
    if (!isM3u8) {
      // Default mode for direct video: redirect to direct playable stream
      return Response.redirect(directStreamUrl, 302);
    }

    // HLS Stream (M3U8): Return synthesized HLS Master Playlist combining video variants + subtitles.
    // no-store: the master embeds short-lived upstream tokens (routed via
    // /playlist), so a browser-cached copy would go stale within minutes.
    const playlistContent = extracted.masterPlaylist || "";
    return new Response(playlistContent, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    if (request.signal?.aborted || err.name === "AbortError") {
      return new Response(JSON.stringify({ error: "Client aborted request" }), {
        status: 499,
        headers: { "Content-Type": "application/json" },
      });
    }
    const isNotFound = err.message?.includes("No playable video source");
    return new Response(
      JSON.stringify({ error: err.message || "Failed to scrape video" }),
      {
        status: isNotFound ? 404 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// In-memory cache of CDN hostnames that enforce anti-hotlinking by rejecting third-party Referers.
// Once a host succeeds without Referer after an initial 403, we skip sending Referer for all future chunks on that host.
export const stripRefererHosts = new Set<string>();

const proxySubHandler = async (
  query: {
    url?: string;
    referer?: string;
    ua?: string;
    duration?: string;
    playlist?: string;
  },
  request: Request,
): Promise<Response> => {
  const subUrl = query.url;
  if (!subUrl) {
    return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const referer = query.referer;
  const userAgent =
    query.ua || request.headers.get("user-agent") || DEFAULT_USER_AGENT;
  const wantPlaylist = query.playlist === "1";

  try {
    // HLS renditions must point at a media *playlist*, not a raw WebVTT
    // document. The single-segment wrapper's content doesn't depend on the
    // VTT payload, so it returns instantly — the caption itself is only
    // fetched when the player requests the segment below.
    if (wantPlaylist) {
      const origin = getRequestOrigin(request);
      const inner = new URLSearchParams({ url: subUrl });
      if (referer) inner.set("referer", referer);
      // .vtt cosmetic path: ffmpeg/libmpv hls demuxers only accept segments
      // whose URL carries an allowlisted media extension. ffmpeg derives the
      // extension from the LAST dot of the whole URL string, so every dot in
      // the query (sub.wyzie.io, tok=3.…, vidnest.fun) must be percent-encoded
      // (%2E is semantically identical) or it would override the cosmetic one.
      const segmentUrl = `${origin}/proxy-sub/caption.vtt?${inner
        .toString()
        .replace(/\./g, "%2E")}`;
      let duration = Number(query.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        // Fallback 1: Lookup cached duration by page URL (referer)
        const videoDur = videoScraperService.getDuration(referer);
        if (videoDur && videoDur > 0) {
          duration = videoDur;
        } else {
          // Fallback 2: Lookup duration from cached subtitle cues
          const subDur = videoScraperService.getSubtitleDuration(subUrl);
          if (subDur && subDur > 0) {
            duration = subDur;
          }
        }
      }
      const extInf =
        Number.isFinite(duration) && duration > 0 ? duration : 86400;
      const playlist = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        `#EXT-X-TARGETDURATION:${Math.ceil(extInf)}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        `#EXTINF:${extInf.toFixed(3)},`,
        segmentUrl,
        "#EXT-X-ENDLIST",
      ].join("\n");
      return new Response(playlist, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "public, max-age=21600",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
    }

    const vtt = await videoScraperService.getSubtitle(
      subUrl,
      referer,
      userAgent,
      request.signal,
    );

    // Apple's HLS authoring spec requires every WebVTT segment to declare an
    // X-TIMESTAMP-MAP so AVPlayer can position cues (tvOS/airOS players are
    // strict about this — the same file plays fine in ffmpeg/VLC without it).
    // LOCAL:0 ↔ MPEGTS:0 keeps cue times as-is for a single from-zero segment;
    // ffmpeg/VLC ignore the map at offset 0, so nothing else changes.
    const vttOut =
      vtt.startsWith("WEBVTT") && !vtt.includes("X-TIMESTAMP-MAP")
        ? vtt.replace(/^WEBVTT/, "WEBVTT\nX-TIMESTAMP-MAP:LOCAL:0,MPEGTS:0")
        : vtt;

    // A response served BEFORE calibration landed must not be pinned by
    // downstream HTTP caches for the full 6h — that would freeze the
    // misaligned body for exactly the viewer whose request triggered the
    // calibration. Non-Wyzie URLs never calibrate, so they keep the long
    // TTL; a Wyzie URL only earns it once its transform exists.
    const cacheMaxAge =
      videoScraperService.hasSubtitleSync(subUrl) || !isWyzieSubtitleUrl(subUrl)
        ? 21600
        : 120;

    return new Response(vttOut, {
      status: 200,
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": `public, max-age=${cacheMaxAge}`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      },
    });
  } catch (e: any) {
    if (request.signal?.aborted || e.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return new Response(
      JSON.stringify({ error: e.message || "Failed to load subtitle" }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

export const app = new Elysia()
  .use(cors({ origin: "*" }))
  .onError(({ code, error, request }) => {
    logger.error(`${code} on ${request.method} ${request.url}`, "App", error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: code === "NOT_FOUND" ? 404 : 500,
      headers: { "Content-Type": "application/json" },
    });
  })
  .get("/", () => "strix")
  .get("/scrape-stream", async ({ query, request }) => {
    return handleScrapeStream(query, request);
  })
  .get("/scrape-stream/:filename", async ({ query, request }) => {
    return handleScrapeStream(query, request);
  })
  .get("/scrape-video", async ({ query, request }) => {
    return handleScrapeVideo(query, request);
  })
  .get("/scrape-video/:filename", async ({ query, request }) => {
    // Friendly aliases like /master.m3u8 — the filename itself is cosmetic;
    // responses follow the same content negotiation as plain /scrape-video.
    return handleScrapeVideo(query, request);
  })
  .get("/playlist", async ({ query, request }) => {
    const playlistUrl = query.url;
    if (!playlistUrl) {
      return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const referer = query.referer;

    try {
      const rewritten = await videoScraperService.getProxiedPlaylist(
        playlistUrl,
        referer,
        getRequestOrigin(request),
        request.signal,
      );
      return new Response(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
    } catch (e: any) {
      if (request.signal?.aborted || e.name === "AbortError") {
        return new Response(null, { status: 499 });
      }
      return new Response(
        JSON.stringify({ error: e.message || "Failed to load playlist" }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  })
  // Subtitle routes: static cosmetic paths + param + plain, all sharing
  // proxySubHandler directly (no redirect — ffmpeg's hls demuxer re-checks
  // the allowed extension on the FINAL post-redirect URL, and the bare
  // /proxy-sub target has no dot at all, which drops the whole track).
  .get("/proxy-sub/subs.m3u8", async ({ query, request }) => {
    return proxySubHandler(query, request);
  })
  .get("/proxy-sub/caption.vtt", async ({ query, request }) => {
    return proxySubHandler(query, request);
  })
  .get("/proxy-sub/:filename", async ({ query, request }) => {
    return proxySubHandler(query, request);
  })
  .get("/proxy-sub", async ({ query, request }) => {
    return proxySubHandler(query, request);
  })
  // The :filename segment is cosmetic — strict HLS clients (ffmpeg/libmpv
  // allowed_extensions) refuse segment URLs that don't end in a media
  // extension, while upstreams disguise segments as .xml/.js/.txt. The 307
  // keeps method, query and Range headers on the internal hop. Location is
  // rebuilt through getRequestOrigin so it matches the origin used in the
  // playlists even behind a reverse proxy (PUBLIC_URL / forwarded headers) —
  // request.url alone would leak the internal host.
  .get("/proxy-chunk/:filename", ({ request }) => {
    const search = new URL(request.url).search;
    const location = `${getRequestOrigin(request)}/proxy-chunk${search}`;
    return new Response(null, {
      status: 307,
      headers: { Location: location },
    });
  })
  .get("/proxy-chunk", async ({ query, request }) => {
    const chunkUrl = query.url;
    if (!chunkUrl) {
      return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let chunkHostname = "";
    try {
      chunkHostname = new URL(chunkUrl).hostname.toLowerCase();
    } catch (_) {}

    const headers = new Headers();
    if (query.referer && (!chunkHostname || !stripRefererHosts.has(chunkHostname))) {
      headers.set("referer", query.referer);
    }
    const userAgent =
      query.ua ||
      request.headers.get("user-agent") ||
      DEFAULT_USER_AGENT;
    headers.set("user-agent", userAgent);

    const range = request.headers.get("range");
    if (range) {
      headers.set("range", range);
    }

    const chunkTimeout = AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS);
    const chunkSignal = request.signal
      ? AbortSignal.any([request.signal, chunkTimeout])
      : chunkTimeout;

    try {
      const isKey =
        chunkUrl.includes(".key") ||
        chunkUrl.includes("/key") ||
        chunkUrl.includes("encryption.key");

      const unwrapped = unwrapProxyUrl(chunkUrl);
      let fetchUrl = chunkUrl;
      let fetchHeaders = new Headers(headers);

      // ts-proxy endpoints (e.g. Cloudflare workers / megacloud) are designed strictly
      // for transport stream video segments; upstream workers return 404 for encryption keys.
      // If a key request is wrapped in a ts-proxy, bypass the wrapper and fetch target directly.
      if (
        isKey &&
        unwrapped &&
        (chunkUrl.includes("ts-proxy") || chunkUrl.includes("workers.dev"))
      ) {
        fetchUrl = unwrapped.targetUrl;
        if (unwrapped.headers) {
          for (const [k, v] of Object.entries(unwrapped.headers)) {
            fetchHeaders.set(k, v);
          }
        }
      }

      let upstream = await smartFetch(fetchUrl, {
        signal: chunkSignal,
        headers: fetchHeaders,
        range,
      });

      // Adaptive Anti-Hotlink Fallback:
      // If upstream rejected with HTTP 403 and a Referer was present, retry once without Referer.
      // Many CDNs permit direct requests but reject third-party referers.
      // When successful, remember this hostname so subsequent chunks skip the referer immediately.
      if (upstream.status === 403 && fetchHeaders.has("referer")) {
        const fallbackHeaders = new Headers(fetchHeaders);
        fallbackHeaders.delete("referer");
        const retryUpstream = await smartFetch(fetchUrl, {
          signal: chunkSignal,
          headers: fallbackHeaders,
          range,
        });
        if (retryUpstream.ok) {
          upstream = retryUpstream;
          const host = new URL(fetchUrl).hostname.toLowerCase();
          if (host) {
            stripRefererHosts.add(host);
          }
        }
      }

      // Proxy Wrapper Fallback:
      // If a wrapper proxy (e.g. workers.dev, megacloud) returned an error (404/403/500+),
      // attempt fetching directly from the unwrapped target using its embedded headers.
      if (!upstream.ok && fetchUrl !== unwrapped?.targetUrl && unwrapped) {
        const directHeaders = new Headers(headers);
        if (unwrapped.headers) {
          for (const [k, v] of Object.entries(unwrapped.headers)) {
            directHeaders.set(k, v);
          }
        }
        const retryDirect = await smartFetch(unwrapped.targetUrl, {
          signal: chunkSignal,
          headers: directHeaders,
          range,
        });
        if (retryDirect.ok) {
          upstream = retryDirect;
          logger.info(
            `Recovered via direct unwrap fetch (HTTP 200) for: ${unwrapped.targetUrl.slice(0, 100)}`,
            "ProxyChunk",
          );
        }
      }

      if (!upstream.ok) {
        logger.warn(
          `Proxy-chunk upstream returned HTTP ${upstream.status} for ${chunkUrl}`,
          "ProxyChunk",
        );
        // If chunk fails with 401 Unauthorized, 403 Forbidden, or 404 Not Found, session/signed token has expired.
        // Invalidate the source stream cache so the next playlist fetch re-extracts a fresh token.
        // We only invalidate entries extracted at or before (now - 15s) so delayed segment failures don't wipe out
        // a freshly refreshed stream.
        if (
          query.source &&
          (upstream.status === 401 ||
            upstream.status === 403 ||
            upstream.status === 404)
        ) {
          const invalidated = scraperService.invalidateCache(
            query.source,
            Date.now() - 15_000,
          );
          if (invalidated) {
            logger.warn(
              `Chunk authentication failed (HTTP ${upstream.status}). Invalidating stale cache for source: ${query.source}`,
              "ProxyChunk",
            );
          }
        }
      }

      const resHeaders = new Headers();
      let contentType = upstream.headers.get("Content-Type");
      const upstreamContentType = (
        upstream.headers.get("Content-Type") || ""
      ).toLowerCase();
      const isKnownMediaExt = /\.(ts|m4s|mp4|webm|mkv)($|\?)/i.test(chunkUrl);
      const isKnownMediaMime =
        upstreamContentType.startsWith("video/") ||
        upstreamContentType.startsWith("audio/");
      const isStandardMedia = isKnownMediaExt || isKnownMediaMime;

      let bodyData: BodyInit | null = upstream.body;

      const isPlaylistCandidate =
        chunkUrl.includes(".m3u8") ||
        upstreamContentType.includes("mpegurl") ||
        upstreamContentType.includes("application/x-mpegurl");

      // If upstream is an M3U8 playlist, rewrite child segments through proxy-chunk
      // so disguised media chunks (.image/PNG/WebP) and hotlink-protected segments get unwrapped and proxied.
      if (
        isPlaylistCandidate &&
        upstream.status >= 200 &&
        upstream.status < 300
      ) {
        const rawBuffer = await upstream.arrayBuffer();
        const rawBytes = new Uint8Array(rawBuffer);
        const isExtm3u =
          rawBytes.length >= 7 &&
          rawBytes[0] === 0x23 && // '#'
          rawBytes[1] === 0x45 && // 'E'
          rawBytes[2] === 0x58 && // 'X'
          rawBytes[3] === 0x54 && // 'T'
          rawBytes[4] === 0x4d && // 'M'
          rawBytes[5] === 0x33 && // '3'
          rawBytes[6] === 0x55; // 'U'

        if (isExtm3u) {
          const text = new TextDecoder().decode(rawBytes);
          const requestOrigin = getRequestOrigin(request);
          const rewritten = rewriteM3u8Playlist(text, chunkUrl, {
            proxySegmentUrl: (targetUrl) => {
              const params = new URLSearchParams({ url: targetUrl });
              if (query.referer) {
                params.set("referer", query.referer);
              }
              if (query.ua) {
                params.set("ua", query.ua);
              }
              if (query.source) {
                params.set("source", query.source);
              }
              return proxyChunkUrl(requestOrigin, targetUrl, params.toString());
            },
          });

          resHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
          resHeaders.delete("Content-Length");
          const cacheControl = upstream.headers.get("Cache-Control");
          if (cacheControl) resHeaders.set("Cache-Control", cacheControl);
          return new Response(rewritten, {
            status: 200,
            headers: resHeaders,
          });
        }

        // If it was named .m3u8 but contains binary data, pass buffer down to unwrap logic
        bodyData = rawBytes as BodyInit;
      }

      const isKeyOrPlaylist =
        chunkUrl.includes(".key") ||
        chunkUrl.includes("/key") ||
        chunkUrl.includes(".m3u8");

      const wantExplicitUnwrap =
        query.unwrap === "1" || query.unwrap === "true";

      // If already standard media (.ts/.m4s/video/*) and unwrap was not explicitly requested,
      // bypass buffering and stream upstream.body directly for zero RAM overhead.
      const shouldInspectForUnwrap =
        !isKeyOrPlaylist &&
        upstream.status >= 200 &&
        upstream.status < 300 &&
        (wantExplicitUnwrap || !isStandardMedia);

      if (shouldInspectForUnwrap) {
        const rawBytes =
          bodyData instanceof Uint8Array
            ? bodyData
            : new Uint8Array(await upstream.arrayBuffer());
        const shouldUnwrap = wantExplicitUnwrap || needsUnwrap(rawBytes);

        if (shouldUnwrap) {
          const finalBytes = unwrapChunk(rawBytes);
          if (finalBytes !== rawBytes && finalBytes[0] === 0x47) {
            contentType = "video/mp2t";
            resHeaders.set("Content-Type", contentType);
            resHeaders.set("Content-Length", finalBytes.byteLength.toString());
            const cacheControl = upstream.headers.get("Cache-Control");
            if (cacheControl) resHeaders.set("Cache-Control", cacheControl);
            return new Response(finalBytes as BodyInit, {
              status: 200,
              headers: resHeaders,
            });
          }
        }
        bodyData = rawBytes as BodyInit;
      }

      if (!contentType) {
        if (chunkUrl.includes(".key") || chunkUrl.includes("/key")) {
          contentType = "application/octet-stream";
        } else {
          contentType = "video/mp2t";
        }
      }
      resHeaders.set("Content-Type", contentType);

      const contentRange = upstream.headers.get("Content-Range");
      if (contentRange) resHeaders.set("Content-Range", contentRange);
      const acceptRanges = upstream.headers.get("Accept-Ranges");
      if (acceptRanges) resHeaders.set("Accept-Ranges", acceptRanges);
      const contentLength = upstream.headers.get("Content-Length");
      if (contentLength) resHeaders.set("Content-Length", contentLength);
      const cacheControl = upstream.headers.get("Cache-Control");
      if (cacheControl) resHeaders.set("Cache-Control", cacheControl);

      return new Response(bodyData, {
        status: upstream.status,
        headers: resHeaders,
      });
    } catch (e) {
      const error = e as Error;
      if (request.signal.aborted || error.name === "AbortError") {
        return new Response(JSON.stringify({ error: "Client cancelled request" }), {
          status: 499,
          headers: { "Content-Type": "application/json" },
        });
      }
      logger.error(`Proxy-chunk failed for ${chunkUrl}: ${error.message}`, "ProxyChunk");
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  })
  // idleTimeout: Elysia's Bun adapter defaults to 30s of socket inactivity,
  // which silently kills the client connection while a slow scrape is still
  // running (cold vidfast scrapes take 25-30s+). Raise it so long scrapes can
  // deliver their response (Bun's hard cap is 255s).
  .listen({
    port: CONFIG.PORT,
    idleTimeout: 120,
  });

logger.info(`strix listening on http://localhost:${CONFIG.PORT}`, "App");

// Eager warmup: launch the browser context and load auth state now so the
// first scrape request doesn't pay the multi-second Chromium startup cost.
// Fire-and-forget; concurrent first requests await the same singleton promise.
scraperService
  .warmup()
  .then(() => logger.info("Browser context ready (warmup complete)", "App"))
  .catch((e) => logger.error("Browser warmup failed", "App", e));
