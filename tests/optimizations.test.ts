import { describe, expect, it } from "bun:test";
import { Semaphore } from "../src/utils/semaphore";

describe("Semaphore", () => {
  it("limits concurrency correctly", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxObservedActive = 0;

    const task = async () => {
      await sem.run(async () => {
        active++;
        maxObservedActive = Math.max(maxObservedActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxObservedActive).toBe(2);
    expect(sem.activeCount).toBe(0);
    expect(sem.queuedCount).toBe(0);
  });

  it("drains queue in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const p1 = sem.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    const p2 = sem.run(async () => {
      order.push(2);
    });
    const p3 = sem.run(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("smartFetch curl redirect parsing", () => {
  it("resolves the final response after redirects", async () => {
    // httpbin redirects /redirect/2 twice and lands on /get
    const { smartFetch } = await import("../src/utils/http");
    const res = await smartFetch("https://httpbin.org/redirect/2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("httpbin.org/get");
  });
});

describe("rewriteM3u8Playlist", () => {
  it("rewrites relative segments and key URIs to absolute CDN URLs", async () => {
    const { rewriteM3u8Playlist } = await import("../src/utils/m3u8");
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"enc.key\"",
      "#EXTINF:5.0,",
      "segment1.ts",
      "#EXTINF:5.0,",
      "../chunks/segment2.ts",
      "#EXTINF:5.0,",
      "https://cdn.other.com/seg3.ts",
    ].join("\n");

    const baseUrl = "https://cdn.example.com/live/stream/playlist.m3u8?token=123";
    const rewritten = rewriteM3u8Playlist(playlist, baseUrl);

    expect(rewritten).toContain('URI="https://cdn.example.com/live/stream/enc.key?token=123"');
    expect(rewritten).toContain("https://cdn.example.com/live/stream/segment1.ts?token=123");
    expect(rewritten).toContain("https://cdn.example.com/live/chunks/segment2.ts?token=123");
    expect(rewritten).toContain("https://cdn.other.com/seg3.ts");
  });

  it("rewrites relative numeric .js segments (like strmfree) to absolute URLs", async () => {
    const { rewriteM3u8Playlist } = await import("../src/utils/m3u8");
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXTINF:4.004,",
      "543728.js",
      "#EXTINF:4.004,",
      "543729.js",
    ].join("\n");

    const baseUrl =
      "https://strmfree.st/live/willow1080p/index.m3u8?_t=5M_jPHrgTz0vPBuJpp46GA";
    const rewritten = rewriteM3u8Playlist(playlist, baseUrl);

    expect(rewritten).toContain(
      "https://strmfree.st/live/willow1080p/543728.js?_t=5M_jPHrgTz0vPBuJpp46GA",
    );
    expect(rewritten).toContain(
      "https://strmfree.st/live/willow1080p/543729.js?_t=5M_jPHrgTz0vPBuJpp46GA",
    );
    expect(rewritten).not.toContain("\n543728.js\n");
  });

  it("proxies chunks correctly with requestOrigin from reverse proxy and forwards referer/ua", async () => {
    const { rewriteM3u8Playlist } = await import("../src/utils/m3u8");
    const playlist = [
      "#EXTM3U",
      "#EXTINF:4.0,",
      "chunk-1.ts",
    ].join("\n");

    const baseUrl = "https://cdn.example.com/hls/live/index.m3u8?token=xyz";
    const proxySegmentUrl = (absUrl: string) => {
      const p = new URLSearchParams();
      p.set("url", absUrl);
      p.set("referer", "https://example.com/page");
      p.set("ua", "Mozilla/5.0 Custom");
      return `https://proxy.quaywin.com/proxy-chunk?${p.toString()}`;
    };

    const rewritten = rewriteM3u8Playlist(playlist, baseUrl, { proxySegmentUrl });
    expect(rewritten).toContain("https://proxy.quaywin.com/proxy-chunk?url=https%3A%2F%2Fcdn.example.com%2Fhls%2Flive%2Fchunk-1.ts%3Ftoken%3Dxyz&referer=https%3A%2F%2Fexample.com%2Fpage&ua=Mozilla%2F5.0+Custom");
  });
});

describe("Browser popup neutralization", () => {
  it("prevents window.open from spawning rogue background pages", async () => {
    const { chromium } = await import("patchright");
    const ctx = await chromium.launchPersistentContext("", {
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });

    await ctx.addInitScript(`
      try {
        window.open = () => ({ closed: true, focus: () => {}, close: () => {} });
      } catch (e) {}
    `);

    const page = await ctx.newPage();
    await page.goto("data:text/html,<html><body></body></html>");
    const result = await page.evaluate(
      () => {
        const w = window.open("https://ad-site.com");
        return w ? w.closed : true;
      },
      null,
      {},
      false,
    );

    expect(result).toBe(true);
    await page.close();
    await ctx.close();
  });
});

describe("smartFetch m3u8 header guard", () => {
  it("forces accept-encoding: identity and strips Range for m3u8 URLs to prevent ZlibError", async () => {
    // Start a tiny local HTTP server that echoes headers back
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(
          JSON.stringify({
            acceptEncoding: req.headers.get("accept-encoding"),
            range: req.headers.get("range"),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    try {
      const { smartFetch } = await import("../src/utils/http");
      const res = await smartFetch(
        `http://localhost:${server.port}/stream/playlist.m3u8`,
        {
          headers: { "accept-encoding": "gzip, deflate" },
          range: "bytes=0-100",
        },
      );

      const data = await res.json();
      expect(data.acceptEncoding).toBe("identity");
      expect(data.range).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("forces cache-control: no-cache and pragma: no-cache for m3u8 requests to prevent live stalling", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(
          JSON.stringify({
            cacheControl: req.headers.get("cache-control"),
            pragma: req.headers.get("pragma"),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    try {
      const { smartFetch } = await import("../src/utils/http");
      const res = await smartFetch(
        `http://localhost:${server.port}/stream/live.m3u8`,
      );

      const data = await res.json();
      expect(data.cacheControl).toContain("no-cache");
      expect(data.pragma).toBe("no-cache");
    } finally {
      server.stop(true);
    }
  });

  it("injects DEFAULT_USER_AGENT when user-agent header is omitted", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(
          JSON.stringify({
            userAgent: req.headers.get("user-agent"),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    try {
      const { smartFetch, DEFAULT_USER_AGENT } = await import("../src/utils/http");
      const res = await smartFetch(`http://localhost:${server.port}/test`);
      const data = await res.json();
      expect(data.userAgent).toBe(DEFAULT_USER_AGENT);
    } finally {
      server.stop(true);
    }
  });
});

describe("getRequestOrigin and getHeader", () => {
  it("extracts public origin from x-forwarded-proto and x-forwarded-host", async () => {
    const { getRequestOrigin } = await import("../src/utils/http");

    const req = new Request("http://127.0.0.1:5005/scrape-stream", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "proxy.quaywin.com, 10.0.0.1",
        host: "localhost:5005",
      },
    });

    expect(getRequestOrigin(req)).toBe("https://proxy.quaywin.com");
  });

  it("falls back to host header or request url", async () => {
    const { getRequestOrigin } = await import("../src/utils/http");

    const reqWithHost = new Request("http://127.0.0.1:5005/scrape-stream", {
      headers: { host: "myproxy.org" },
    });
    expect(getRequestOrigin(reqWithHost)).toBe("https://myproxy.org");

    const reqLocal = new Request("http://localhost:5005/scrape-stream");
    expect(getRequestOrigin(reqLocal)).toBe("http://localhost:5005");
  });

  it("getHeader performs case-insensitive lookup", async () => {
    const { getHeader } = await import("../src/utils/http");
    const headers = { Referer: "https://example.com/embed", "User-Agent": "Browser 1.0" };

    expect(getHeader(headers, "referer")).toBe("https://example.com/embed");
    expect(getHeader(headers, "REFERER")).toBe("https://example.com/embed");
    expect(getHeader(headers, "user-agent")).toBe("Browser 1.0");
    expect(getHeader(headers, "missing")).toBeUndefined();
  });
});

describe("Content-based #EXTM3U stream detection and proxying", () => {
  it("rewrites extensionless playlist URLs (like /cv/channel-name) correctly", async () => {
    const { rewriteM3u8Playlist } = await import("../src/utils/m3u8");
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.0,",
      "chunk-001.ts",
      "#EXTINF:6.0,",
      "/hls/chunk-002.ts",
    ].join("\n");

    const baseUrl = "https://sportsbite.org/cv/acc-network-usa";
    const proxySegmentUrl = (absUrl: string) => {
      const p = new URLSearchParams();
      p.set("url", absUrl);
      p.set("referer", "https://sportsbite.org/watch/channel/acc-network");
      return `https://proxy.quaywin.com/proxy-chunk?${p.toString()}`;
    };

    const rewritten = rewriteM3u8Playlist(playlist, baseUrl, { proxySegmentUrl });
    expect(rewritten).toContain(
      "https://proxy.quaywin.com/proxy-chunk?url=https%3A%2F%2Fsportsbite.org%2Fcv%2Fchunk-001.ts&referer=https%3A%2F%2Fsportsbite.org%2Fwatch%2Fchannel%2Facc-network",
    );
    expect(rewritten).toContain(
      "https://proxy.quaywin.com/proxy-chunk?url=https%3A%2F%2Fsportsbite.org%2Fhls%2Fchunk-002.ts&referer=https%3A%2F%2Fsportsbite.org%2Fwatch%2Fchannel%2Facc-network",
    );
  });
});

describe("isEmbedPlayerUrl and stealth anti-embed bypass", () => {
  it("correctly classifies embed vs non-embed URLs", async () => {
    const { isEmbedPlayerUrl } = await import("../src/scraper/ScraperEngine");

    expect(isEmbedPlayerUrl("https://domain.com/embed/stream-1")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/cv-embed/embed/channel")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/live-embed/id")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/player.php?id=123")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/player.html?id=123")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/embed.html")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/iframe/stream")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/e/abc123")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/play/stream")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/v/xyz")).toBe(true);
    expect(isEmbedPlayerUrl("https://ehgembxe.cfd/5evzdk49-4997")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/watch?id=123&embed=1")).toBe(true);
    expect(isEmbedPlayerUrl("https://domain.com/live?is_embed=true")).toBe(true);

    expect(isEmbedPlayerUrl("https://domain.com/watch/channel/acc-network")).toBe(false);
    expect(isEmbedPlayerUrl("https://domain.com/matches/today")).toBe(false);
    expect(isEmbedPlayerUrl("https://domain.com/channels")).toBe(false);
  });

  it("maintains standard top-level window context to avoid frame-busting side effects", async () => {
    const { PlaywrightBrowserProvider } = await import(
      "../src/scraper/BrowserProvider"
    );
    const provider = new PlaywrightBrowserProvider();
    const context = await provider.acquireContext();
    const page = await context.newPage();

    const evaluation = await page.evaluate(() => {
      return {
        isSelfEqualTop: window.self === window.top,
        isParentEqualSelf: window.parent === window.self,
        selfType: typeof window.self,
        hasDocument: Boolean(window.self.document),
      };
    });

    expect(evaluation.isSelfEqualTop).toBe(true);
    expect(evaluation.isParentEqualSelf).toBe(true);
    expect(evaluation.selfType).toBe("object");
    expect(evaluation.hasDocument).toBe(true);

    await page.close();
    await provider.releaseContext();
  });

  it("loads embed URLs via virtual origin-matched iframe loader and satisfies frame-ancestors CSP", async () => {
    let embedRequestedAsIframe = false;
    let streamCaptured = false;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/embed/test-stream") {
          const secFetchDest = req.headers.get("sec-fetch-dest");
          if (secFetchDest === "iframe") {
            embedRequestedAsIframe = true;
          }
          return new Response(
            `<!DOCTYPE html><html><body><script>if (window.self !== window.top) { fetch('/api/manifest').then(r => r.text()); }</script></body></html>`,
            {
              headers: {
                "Content-Type": "text/html",
                "Content-Security-Policy": "frame-ancestors 'self'",
              },
            },
          );
        }
        if (url.pathname === "/api/manifest") {
          streamCaptured = true;
          return new Response(
            `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg1.ts\n`,
            {
              headers: {
                "Content-Type": "application/vnd.apple.mpegurl",
              },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const { scraperEngine } = await import("../src/scraper/ScraperEngine");
      const targetUrl = `http://localhost:${server.port}/embed/test-stream`;
      const requests = await scraperEngine.collectRequests(targetUrl, 5, true, true);

      expect(embedRequestedAsIframe).toBe(true);
      expect(streamCaptured).toBe(true);
      expect(requests.some((r) => r.body?.includes("#EXTM3U"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("Upstream offline error handling", () => {
  it("maps upstream 502/503/504 Bad Gateway to explicit 404 offline response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/live/offline.m3u8") {
          return new Response("Cloudflare error 502", { status: 502 });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const { handleScrapeStream } = await import("../index");
      const { scraperService } = await import("../src/services/scraper.service");

      // Mock extractStream to return the test stream URL
      const origExtract = scraperService.extractStream.bind(scraperService);
      scraperService.extractStream = async () => ({
        url: `http://localhost:${server.port}/live/offline.m3u8`,
        headers: {},
      });

      try {
        const req = new Request("http://localhost:5005/scrape-stream");
        const res = await handleScrapeStream(
          {
            url: "https://example.com/channel",
            proxy: "1",
          },
          req,
        );

        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toContain("offline or unavailable (HTTP 502)");
        expect(data.upstreamStatus).toBe(502);
      } finally {
        scraperService.extractStream = origExtract;
      }
    } finally {
      server.stop(true);
    }
  });

  it("sets no-cache headers on rewritten m3u8 playlist responses", async () => {
    const playlistText = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg1.ts\n";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(playlistText, {
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        });
      },
    });

    try {
      const { handleScrapeStream } = await import("../index");
      const { scraperService } = await import("../src/services/scraper.service");

      const origExtract = scraperService.extractStream.bind(scraperService);
      scraperService.extractStream = async () => ({
        url: `http://localhost:${server.port}/live/test.m3u8`,
        headers: {},
      });

      try {
        const req = new Request("http://localhost:5005/scrape-stream");
        const res = await handleScrapeStream(
          {
            url: "https://example.com/channel",
            proxy: "1",
          },
          req,
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toContain("no-cache");
        expect(res.headers.get("pragma")).toBe("no-cache");
      } finally {
        scraperService.extractStream = origExtract;
      }
    } finally {
      server.stop(true);
    }
  });

  it("recovers expired signed token streams by invalidating stale cache and re-scraping", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/live/expired.m3u8") {
          return new Response("Not Found", { status: 404 });
        }
        if (url.pathname === "/live/fresh.m3u8") {
          return new Response("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg2.ts\n", {
            headers: { "Content-Type": "application/vnd.apple.mpegurl" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const { handleScrapeStream } = await import("../index");
      const { scraperService } = await import("../src/services/scraper.service");

      const origExtract = scraperService.extractStream.bind(scraperService);
      const origInvalidate = scraperService.invalidateCache.bind(scraperService);
      let invalidated = false;

      scraperService.invalidateCache = (u: string, t?: number) => {
        invalidated = true;
        return origInvalidate(u, t);
      };

      scraperService.extractStream = async () => {
        callCount++;
        if (callCount === 1) {
          // First attempt: simulate cached stream URL with expired token (>30s old)
          return {
            url: `http://localhost:${server.port}/live/expired.m3u8`,
            headers: {},
            fromCache: true,
            extractedAt: Date.now() - 60_000,
          };
        }
        // Second attempt: fresh scrape returns new valid token URL
        return {
          url: `http://localhost:${server.port}/live/fresh.m3u8`,
          headers: {},
          fromCache: false,
          extractedAt: Date.now(),
        };
      };

      try {
        const req = new Request("http://localhost:5005/scrape-stream");
        const res = await handleScrapeStream(
          {
            url: "https://example.com/live-match",
            proxy: "1",
          },
          req,
        );

        expect(res.status).toBe(200);
        expect(callCount).toBe(2);
        expect(invalidated).toBe(true);
        const body = await res.text();
        expect(body).toContain("#EXTM3U");
        expect(body).toContain("seg2.ts");
      } finally {
        scraperService.extractStream = origExtract;
        scraperService.invalidateCache = origInvalidate;
      }
    } finally {
      server.stop(true);
    }
  });

  it("does not re-scrape freshly extracted offline streams, preventing infinite retry loops", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Bad Gateway", { status: 502 });
      },
    });

    try {
      const { handleScrapeStream } = await import("../index");
      const { scraperService } = await import("../src/services/scraper.service");

      const origExtract = scraperService.extractStream.bind(scraperService);
      scraperService.extractStream = async () => {
        callCount++;
        return {
          url: `http://localhost:${server.port}/live/offline.m3u8`,
          headers: {},
          fromCache: true,
          extractedAt: Date.now() - 5_000, // Extracted only 5s ago (<30s threshold)
        };
      };

      try {
        const req = new Request("http://localhost:5005/scrape-stream");
        const res = await handleScrapeStream(
          {
            url: "https://play.blossomz.store/?ch=164",
            proxy: "1",
          },
          req,
        );

        // Expect immediate 404 without re-scraping
        expect(res.status).toBe(404);
        expect(callCount).toBe(1);
      } finally {
        scraperService.extractStream = origExtract;
      }
    } finally {
      server.stop(true);
    }
  });

  it("conditional invalidateCache protects newly created entries against stale evictions", async () => {
    const { scraperService } = await import("../src/services/scraper.service");
    const { scraperEngine } = await import("../src/scraper/ScraperEngine");

    const targetUrl = "https://example.com/race-condition-test";
    scraperService.invalidateCache(targetUrl);

    const origCollect = scraperEngine.collectRequests.bind(scraperEngine);
    let collectCount = 0;
    scraperEngine.collectRequests = async () => {
      collectCount++;
      return [
        {
          url: "https://cdn.example.com/live.m3u8",
          method: "GET",
          headers: {},
          resource_type: "media",
          post_data: null,
          body: "#EXTM3U\n#EXTINF:4.0,\nseg.ts\n",
        },
      ];
    };

    try {
      const first = await scraperService.extractStream(targetUrl);
      expect(collectCount).toBe(1);
      expect(first.fromCache).toBe(false);
      const firstExtractedAt = first.extractedAt!;

      // Attempt stale invalidation: trying to invalidate an entry older than firstExtractedAt - 1000
      const wasInvalidated = scraperService.invalidateCache(
        targetUrl,
        firstExtractedAt - 1000,
      );
      expect(wasInvalidated).toBe(false);

      // Verify entry is still in cache
      const cached = await scraperService.extractStream(targetUrl);
      expect(cached.fromCache).toBe(true);
      expect(collectCount).toBe(1); // No new scrape performed

      // Valid invalidation: invalidate with timestamp >= firstExtractedAt
      const nowInvalidated = scraperService.invalidateCache(
        targetUrl,
        firstExtractedAt,
      );
      expect(nowInvalidated).toBe(true);

      // Next call should scrape again
      const refreshed = await scraperService.extractStream(targetUrl);
      expect(collectCount).toBe(2);
      expect(refreshed.fromCache).toBe(false);
    } finally {
      scraperEngine.collectRequests = origCollect;
      scraperService.invalidateCache(targetUrl);
    }
  });

  it("negative caching prevents spamming browser launches on channels with no playable streams", async () => {
    const { scraperService, NoSourceFoundError } = await import(
      "../src/services/scraper.service"
    );
    const { scraperEngine } = await import("../src/scraper/ScraperEngine");

    const deadUrl = "https://example.com/dead-channel";
    scraperService.invalidateCache(deadUrl);

    let engineCollectCalls = 0;
    const origCollect = scraperEngine.collectRequests.bind(scraperEngine);
    scraperEngine.collectRequests = async () => {
      engineCollectCalls++;
      return []; // Return no media requests
    };

    try {
      // First attempt: triggers collectRequests and throws NoSourceFoundError
      await expect(scraperService.extractStream(deadUrl)).rejects.toThrow(
        NoSourceFoundError,
      );
      expect(engineCollectCalls).toBe(1);

      // Second attempt within 30s: hits negative cache immediately without calling engine
      await expect(scraperService.extractStream(deadUrl)).rejects.toThrow(
        NoSourceFoundError,
      );
      expect(engineCollectCalls).toBe(1); // Still 1, browser was not launched again!
    } finally {
      scraperEngine.collectRequests = origCollect;
      scraperService.invalidateCache(deadUrl);
    }
  });

  describe("Rapid channel surfing & client cancellation handling", () => {
    it("semaphore cancels queued wait immediately when AbortSignal fires", async () => {
      const sem = new Semaphore(1);
      const controller = new AbortController();

      // Acquire the single available slot
      await sem.acquire();
      expect(sem.activeCount).toBe(1);
      expect(sem.queuedCount).toBe(0);

      // Second task tries to acquire and waits in queue
      const waitingPromise = sem.acquire(controller.signal);
      expect(sem.queuedCount).toBe(1);

      // Abort second task while in queue
      controller.abort();

      await expect(waitingPromise).rejects.toThrow("aborted");
      // Queue should immediately evict the aborted task
      expect(sem.queuedCount).toBe(0);

      // Release first task, slot should be freed
      sem.release();
      expect(sem.activeCount).toBe(0);
    });

    it("in-flight scrape subscriber reference counting handles channel switching safely", async () => {
      const { scraperService } = await import("../src/services/scraper.service");
      const { scraperEngine } = await import("../src/scraper/ScraperEngine");

      const surfUrl = "https://example.com/channel-surfing-test";
      scraperService.invalidateCache(surfUrl);

      let abortedOnEngine = false;
      let engineStarted = false;
      const origCollect = scraperEngine.collectRequests.bind(scraperEngine);

      scraperEngine.collectRequests = async (_u, _t, _s, _e, signal) => {
        engineStarted = true;
        if (signal) {
          signal.addEventListener("abort", () => {
            abortedOnEngine = true;
          });
        }
        // Simulate scrape in progress
        await new Promise((r) => setTimeout(r, 80));
        return [
          {
            url: "https://cdn.example.com/surf.m3u8",
            method: "GET",
            headers: {},
            resource_type: "media",
            post_data: null,
            body: "#EXTM3U\n#EXTINF:4.0,\nseg.ts\n",
          },
        ];
      };

      try {
        const client1 = new AbortController();
        const client2 = new AbortController();

        // Client 1 starts scrape
        const p1 = scraperService.extractStream(surfUrl, false, false, client1.signal);
        // Client 2 joins the same in-flight scrape
        const p2 = scraperService.extractStream(surfUrl, false, false, client2.signal);

        // Client 1 switches channel (cancels client 1)
        client1.abort();
        await expect(p1).rejects.toThrow("aborted");

        // Client 2 is still watching, so engine scrape must NOT be aborted
        const res2 = await p2;
        expect(res2.url).toBe("https://cdn.example.com/surf.m3u8");
        expect(abortedOnEngine).toBe(false);

        // When all clients cancel on a fresh request:
        scraperService.invalidateCache(surfUrl);
        const client3 = new AbortController();
        const p3 = scraperService.extractStream(surfUrl, false, false, client3.signal);
        client3.abort();

        await p3.catch(() => {});
        expect(abortedOnEngine).toBe(true);
      } finally {
        scraperEngine.collectRequests = origCollect;
        scraperService.invalidateCache(surfUrl);
      }
    });

    it("handleScrapeStream returns HTTP 499 when client disconnects or aborts", async () => {
      const { handleScrapeStream } = await import("../index");
      const { scraperService } = await import("../src/services/scraper.service");

      const origExtract = scraperService.extractStream.bind(scraperService);
      scraperService.extractStream = async (_u, _s, _e, signal) => {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        throw new DOMException("The operation was aborted", "AbortError");
      };

      try {
        const controller = new AbortController();
        controller.abort(); // Client already disconnected

        const req = new Request("http://localhost:5005/scrape-stream", {
          signal: controller.signal,
        });

        const res = await handleScrapeStream(
          {
            url: "https://example.com/rapid-channel-flip",
            proxy: "1",
          },
          req,
        );

        expect(res.status).toBe(499);
        const data = await res.json();
        expect(data.error).toBe("Client cancelled request");
      } finally {
        scraperService.extractStream = origExtract;
      }
    });
  });
});

describe("isM3u8StreamUrl and HTML proxy safeguard", () => {
  it("does not classify embed player container URLs containing .m3u8 in query as raw m3u8 streams", async () => {
    const { isM3u8StreamUrl } = await import("../src/scraper/ScraperEngine");

    // Player embed containers with .m3u8 in search params should NOT be treated as m3u8 streams
    const embedUrl =
      "https://damitv.st/player/hls/?v=540&url=%2Fc%2F32.m3u8&name=TNT%20Sports%202%20UK";
    expect(isM3u8StreamUrl(embedUrl)).toBe(false);

    // Genuine stream targets with .m3u8 in pathname
    expect(
      isM3u8StreamUrl(
        "https://damitv.st/c/32.m3u8?tk=gS5CrEQrX-ABCqekVU2_oQ&e=1793764190",
      ),
    ).toBe(true);
    expect(isM3u8StreamUrl("https://example.com/live/playlist.m3u8")).toBe(true);
    expect(isM3u8StreamUrl("https://example.com/hls/channel/32.m3u8")).toBe(true);
  });

  it("safeguard returns HTTP 502 when upstream returns HTML document instead of M3U8 playlist", async () => {
    const htmlBody =
      "<!DOCTYPE html><html><head><title>Player</title></head><body><h1>Not stream</h1></body></html>";
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(htmlBody, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    try {
      const { handleScrapeStream } = await import("../index");
      const { scraperService } = await import("../src/services/scraper.service");

      const origExtract = scraperService.extractStream.bind(scraperService);
      scraperService.extractStream = async () => ({
        url: `http://localhost:${server.port}/fake-stream.m3u8`,
        headers: {},
      });

      try {
        const req = new Request("http://localhost:5005/scrape-stream");
        const res = await handleScrapeStream(
          {
            url: "https://example.com/test-stream",
            proxy: "1",
          },
          req,
        );

        expect(res.status).toBe(502);
        const data = await res.json();
        expect(data.error).toContain("HTML document instead of M3U8");
      } finally {
        scraperService.extractStream = origExtract;
      }
    } finally {
      server.stop(true);
    }
  });
});




