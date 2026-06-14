import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { CONFIG } from "./src/config";
import { logger } from "./src/logger";
import {
  NoSourceFoundError,
  scraperService,
} from "./src/services/scraper.service";

const handleScrapeStream = async (
  query: { url?: string; proxy?: string },
  request: Request,
): Promise<Response> => {
  const { url, proxy } = query;
  if (!url) {
    return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const wantProxy = proxy === "1" || proxy === "true";
  // Forward the client Range header in proxy mode so mp4/mkv clients can
  // seek; ignored for non-proxy mode (we just 302 to the stream URL).
  const range = request.headers.get("range");
  try {
    if (!wantProxy) {
      const streamUrl = await scraperService.extractStreamUrl(url);
      return Response.redirect(streamUrl, 302);
    }

    // Proxy mode: fetch upstream and stream the body back to the client.
    // If upstream returns 403 the cached URL is likely stale (signed token
    // expired); we invalidate the cache, re-scrape once, and retry exactly
    // one time. Further failures surface as a 502 to the client.
    const proxyOnce = async (): Promise<Response> => {
      const streamUrl = await scraperService.extractStreamUrl(url);
      const upstream = await fetch(streamUrl, {
        signal: AbortSignal.timeout(CONFIG.PROXY_UPSTREAM_TIMEOUT_MS),
        headers: range ? { range } : undefined,
      });
      if (!upstream.ok) {
        return new Response(
          JSON.stringify({
            error: `Upstream returned ${upstream.status}`,
            upstreamStatus: upstream.status,
          }),
          {
            status: 502,
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
  .get("/", () => "scrape-stream-api")
  .get("/scrape-stream", async ({ query, request }) => {
    return handleScrapeStream(
      query as { url?: string; proxy?: string },
      request,
    );
  })
  .get("/scrape-stream/:filename", async ({ query, request }) => {
    return handleScrapeStream(
      query as { url?: string; proxy?: string },
      request,
    );
  })
  .listen(CONFIG.PORT);

logger.info(
  `scrape-stream-api listening on http://localhost:${CONFIG.PORT}`,
  "App",
);
