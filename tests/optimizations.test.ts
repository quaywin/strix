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

    expect(rewritten).toContain('URI="https://cdn.example.com/live/stream/enc.key"');
    expect(rewritten).toContain("https://cdn.example.com/live/stream/segment1.ts");
    expect(rewritten).toContain("https://cdn.example.com/live/chunks/segment2.ts");
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
      "https://strmfree.st/live/willow1080p/543728.js",
    );
    expect(rewritten).toContain(
      "https://strmfree.st/live/willow1080p/543729.js",
    );
    expect(rewritten).not.toContain("\n543728.js\n");
  });
});




