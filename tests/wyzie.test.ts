import { describe, expect, it, mock } from "bun:test";
import { fetchWyzieSubtitles, wyzieToCandidates } from "../src/utils/wyzie";

const sampleJson = [
  {
    url: "https://sub.wyzie.io/c/abc/id/1?format=srt&tok=x",
    language: "en",
    format: "srt",
    release: "Movie.2026.1080p",
  },
  {
    url: "https://sub.wyzie.io/c/abc/id/2?format=srt&tok=y",
    language: "en-US",
    format: "srt",
    release: "Movie.2026.en-US",
  },
  {
    url: "https://sub.wyzie.io/c/abc/id/3?format=srt&tok=z",
    language: "vi",
    format: "srt",
    release: "Movie.2026.vi",
  },
  { url: "https://sub.wyzie.io/c/abc/id/4?format=srt&tok=w", language: "fr", format: "srt" },
];

describe("fetchWyzieSubtitles", () => {
  it("keeps exact language matches, first per language", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(sampleJson), { status: 200 })),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;
    try {
      const subs = await fetchWyzieSubtitles("key", {
        tmdbId: "1792170",
        languages: ["vi", "en"],
      });
      // "en-US" is a variant, not an exact "en" match — dropped
      expect(subs.map((s) => s.language)).toEqual(["en", "vi"]);
      expect(subs[0]!.url).toContain("id/1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns empty on 401/non-JSON responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"code":401,"message":"API key required"}', { status: 401 }),
      ),
    ) as any;
    try {
      const subs = await fetchWyzieSubtitles("bad-key", {
        tmdbId: "1",
        languages: ["vi"],
      });
      expect(subs).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("wyzieToCandidates", () => {
  it("passes direct links through as candidates, dropping non-text formats", () => {
    const candidates = wyzieToCandidates([
      { url: "https://sub.wyzie.io/c/abc?format=srt&tok=x", language: "vi", format: "srt", release: "r" },
      { url: "https://sub.wyzie.io/c/abc?format=ass&tok=y", language: "en", format: "ass", release: "r" },
    ]);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.language).toBe("vi");
    expect(candidates[0]!.url).toContain("format=srt");
  });
});
