import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { CONFIG } from "./src/config";
import { logger } from "./src/logger";
import { isM3u8StreamUrl } from "./src/scraper/ScraperEngine";
import {
  NoSourceFoundError,
  scraperService,
} from "./src/services/scraper.service";
import {
  DEFAULT_USER_AGENT,
  getHeader,
  getRequestOrigin,
  smartFetch,
} from "./src/utils/http";
import { rewriteM3u8Playlist } from "./src/utils/m3u8";

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
    // If upstream returns an error (404/403/502) on a cached stream URL older than 30s,
    // the signed token has likely expired. We invalidate the cache, re-scrape once,
    // and retry exactly one time to seamlessly recover without stalling the player.
    const proxyOnce = async (): Promise<{
      response: Response;
      fromCache: boolean;
      extractedAt: number;
    }> => {
      const extracted = await scraperService.extractStream(
        url,
        wantSub,
        wantEmbed,
        request.signal,
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
        const isOffline =
          upstream.status === 404 ||
          upstream.status === 502 ||
          upstream.status === 503 ||
          upstream.status === 504;
        let snippet = "";
        try {
          const bodyText = await upstream.text();
          snippet = bodyText.slice(0, 300);
        } catch (_) {}
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
      const isMpegUrlType = contentTypeLower.includes("mpegurl");
      const isBinaryVideoType =
        contentTypeLower.startsWith("video/") ||
        contentTypeLower.startsWith("audio/") ||
        /\.(mp4|mkv|webm|ts|m4s)($|\?)/i.test(streamUrl);

      // Determine if content is HLS playlist (#EXTM3U) even if URL has no .m3u8
      let isM3u8 = isKnownM3u8 || isMpegUrlType;
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
              return `${requestOrigin}/proxy-chunk?${params.toString()}`;
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
      // If the failed upstream request was using a cached stream URL older than 30s,
      // it is very likely a signed rolling token that expired (e.g. 404 or 403 on tims-001.sytes.net).
      // We invalidate the cache and perform exactly ONE fresh scrape to recover the stream seamlessly.
      const isStaleEligible = fromCache && Date.now() - extractedAt >= 30_000;
      if (isStaleEligible) {
        logger.warn(
          `Proxy got upstream error (HTTP ${response.status}) on cached stream for ${url} (age: ${Math.round((Date.now() - extractedAt) / 1000)}s); invalidating cache and retrying once with fresh scrape`,
          "App",
        );
        // Conditionally invalidate: only delete if the cached entry was extracted at or before this failed attempt.
        // If a concurrent request already finished re-scraping, the new cache entry remains intact.
        scraperService.invalidateCache(url, extractedAt);
        const retry = await proxyOnce();
        response = retry.response;
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
  .get("/proxy-chunk", async ({ query, request }) => {
    const chunkUrl = query.url;
    if (!chunkUrl) {
      return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = new Headers();
    if (query.referer) {
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
      const upstream = await smartFetch(chunkUrl, {
        signal: chunkSignal,
        headers,
        range,
      });

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

      return new Response(upstream.body, {
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
  .listen(CONFIG.PORT);

logger.info(`strix listening on http://localhost:${CONFIG.PORT}`, "App");

// Eager warmup: launch the browser context and load auth state now so the
// first scrape request doesn't pay the multi-second Chromium startup cost.
// Fire-and-forget; concurrent first requests await the same singleton promise.
scraperService
  .warmup()
  .then(() => logger.info("Browser context ready (warmup complete)", "App"))
  .catch((e) => logger.error("Browser warmup failed", "App", e));
