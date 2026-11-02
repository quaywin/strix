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
    const { chromium } = await import("playwright");
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
    const result = await page.evaluate(() => {
      const w = window.open("https://ad-site.com");
      return w ? w.closed : true;
    });

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
