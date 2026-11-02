import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { CONFIG } from "./src/config";
import { logger } from "./src/logger";
import {
  NoSourceFoundError,
  scraperService,
} from "./src/services/scraper.service";
import { smartFetch } from "./src/utils/http";
import { rewriteM3u8Playlist } from "./src/utils/m3u8";

const handleScrapeStream = async (
  query: {
    url?: string;
    proxy?: string;
    sub?: string;
    format?: string;
    json?: string;
    proxy_segments?: string;
    proxy_all?: string;
  },
  request: Request,
): Promise<Response> => {
  const { url, proxy, sub, format, json, proxy_segments, proxy_all } = query;
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

  // Forward the client Range header in proxy mode so mp4/mkv clients can
  // seek; ignored for non-proxy mode (we just 302 to the stream URL).
  const range = request.headers.get("range");
  try {
    if (wantJson) {
      const extracted = await scraperService.extractStream(url, wantSub);
      return new Response(JSON.stringify(extracted), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!wantProxy) {
      const { url: streamUrl } = await scraperService.extractStream(
        url,
        wantSub,
      );
      return Response.redirect(streamUrl, 302);
    }

    // Proxy mode: fetch upstream and stream the body back to the client.
    // If upstream returns 403 the cached URL is likely stale (signed token
    // expired); we invalidate the cache, re-scrape once, and retry exactly
    // one time. Further failures surface as a 502 to the client.
    const proxyOnce = async (): Promise<Response> => {
      const { url: streamUrl, headers: upstreamHeaders } =
        await scraperService.extractStream(url, wantSub);

      const requestHeaders = new Headers();
      if (upstreamHeaders) {
        for (const [key, value] of Object.entries(upstreamHeaders)) {
          requestHeaders.set(key, value);
        }
      }

      const isM3u8Url = streamUrl.toLowerCase().includes(".m3u8");
      if (isM3u8Url) {
        // Strip Range for m3u8 playlist manifests and force uncompressed delivery.
        // Forwarding Range: bytes=0- on playlists causes upstream CDNs to reply
        // with HTTP 206 Partial Content in gzip encoding, triggering Bun's ZlibError.
        requestHeaders.set("accept-encoding", "identity");
      } else if (range) {
        requestHeaders.set("range", range);
      }

      let upstream = await smartFetch(streamUrl, {
        signal: AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS),
        headers: requestHeaders,
        range: isM3u8Url ? null : range,
      });
      if (!upstream.ok) {
        const isOffline = upstream.status === 404;
        return new Response(
          JSON.stringify({
            error: isOffline
              ? "Upstream stream is offline or ended (404 Not Found)"
              : `Upstream returned ${upstream.status}`,
            upstreamStatus: upstream.status,
          }),
          {
            status: isOffline ? 404 : 502,
            headers: { "Content-Type": "application/json" },
          },
        );
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

      const isM3u8 =
        contentType?.toLowerCase().includes("mpegurl") ||
        streamUrl.toLowerCase().includes(".m3u8");

      if (isM3u8) {
        let text: string;
        try {
          text = await upstream.text();
        } catch (decompError) {
          logger.warn(
            `Decompression error on m3u8 playlist (${(decompError as Error).message}), retrying with identity encoding...`,
            "App",
          );
          requestHeaders.set("accept-encoding", "identity");
          requestHeaders.delete("range");
          upstream = await smartFetch(streamUrl, {
            signal: AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS),
            headers: requestHeaders,
            range: null,
          });
          text = await upstream.text();
        }

        const requestOrigin = new URL(request.url).origin;

        const proxySegmentUrl = wantProxySegments
          ? (absUrl: string) => {
              const params = new URLSearchParams();
              params.set("url", absUrl);
              if (upstreamHeaders?.["referer"]) {
                params.set("referer", upstreamHeaders["referer"]);
              }
              return `${requestOrigin}/proxy-chunk?${params.toString()}`;
            }
          : undefined;

        const rewrittenBody = rewriteM3u8Playlist(text, streamUrl, {
          proxySegmentUrl,
        });

        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/vnd.apple.mpegurl");
        }
        headers.delete("Content-Length"); // Length changed due to URL rewriting
        headers.delete("Content-Range");
        headers.delete("Content-Encoding");

        return new Response(rewrittenBody, {
          status: 200,
          headers,
        });
      }

      // For binary video (mp4/mkv), stream directly with Range support
      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    };

    let response = await proxyOnce();
    if (response.status === 502) {
      logger.warn(
        `Proxy got upstream error for ${url}; invalidating cache and retrying once`,
        "App",
      );
      scraperService.invalidateCache(url);
      response = await proxyOnce();
    }
    return response;
  } catch (e) {
    const error = e as Error;
    // No playable source on the page -> 404 (client-side problem).
    // Upstream fetch timeout -> 504 (gateway timeout).
    // Anything else -> 500 (genuine server-side failure).
    const status =
      e instanceof NoSourceFoundError
        ? 404
        : error.name === "TimeoutError"
          ? 504
          : 500;
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
};

const app = new Elysia()
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
    const range = request.headers.get("range");
    if (range) {
      headers.set("range", range);
    }

    try {
      const upstream = await smartFetch(chunkUrl, {
        signal: AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS),
        headers,
        range,
      });

      const resHeaders = new Headers();
      const contentType = upstream.headers.get("Content-Type") || "video/mp2t";
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
