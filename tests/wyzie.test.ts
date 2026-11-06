import { describe, expect, it, mock } from "bun:test";
import { missingLanguages, srtToVtt, isSubtitleAd } from "../src/utils/subtitles";
import { fetchWyzieSubtitles, wyzieToCandidates } from "../src/utils/wyzie";

describe("missingLanguages", () => {
  it("returns only the configured languages not yet present", () => {
    const existing = [{ language: "en" }, { language: "zh" }];
    expect(missingLanguages(["vi", "en"], existing)).toEqual(["vi"]);
    expect(missingLanguages(["vi", "en"], [])).toEqual(["vi", "en"]);
    expect(missingLanguages(["vi", "en"], [{ language: "vi" }, { language: "en" }])).toEqual([]);
  });

  it("is case-insensitive on found codes and disables fill for '*'", () => {
    expect(missingLanguages(["vi", "en"], [{ language: "EN" }])).toEqual(["vi"]);
    expect(missingLanguages("*", [{ language: "en" }])).toEqual([]);
  });
});

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
    expect(candidates[0]!.format).toBe("srt");
    expect(candidates[0]!.url).toContain("format=srt");
  });

  it("retains format for Wyzie translation endpoints without file extension", () => {
    const candidates = wyzieToCandidates([
      {
        url: "https://sub.wyzie.io/translate?id=1657630&tk=token&target=Vietnamese",
        language: "vi",
        format: "srt",
        release: "",
      },
    ]);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.language).toBe("vi");
    expect(candidates[0]!.format).toBe("srt");
  });
});

describe("srtToVtt ad filtering", () => {
  it("drops Wyzie free plan watermark and renumbers remaining cues", () => {
    const raw = [
      "1",
      "00:00:00,000 --> 00:00:06,000",
      "You're on the free plan. Unlock every source, AI translation & ad-free subs → sub.wyzie.io",
      "",
      "2",
      "00:01:07,520 --> 00:01:09.120",
      "Anh yêu em bằng hơi thở,",
      "",
      "3",
      "00:01:10,080 --> 00:01:12,860",
      "nụ cười, nước mắt, của cả cuộc đời anh.",
    ].join("\n");

    const vtt = srtToVtt(raw);
    expect(vtt).toContain("WEBVTT");
    expect(vtt).not.toContain("sub.wyzie.io");
    expect(vtt).not.toContain("You're on the free plan");
    // Cue 2 was renumbered to cue 1
    expect(vtt).toContain("1\n00:01:07.520 --> 00:01:09.120\nAnh yêu em bằng hơi thở,");
    // Cue 3 was renumbered to cue 2
    expect(vtt).toContain("2\n00:01:10.080 --> 00:01:12.860\nnụ cười, nước mắt, của cả cuộc đời anh.");
  });

  it("drops OpenSubtitles VIP / site promo cues", () => {
    const raw = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:05.000",
      "Support us and become VIP member at opensubtitles.org",
      "",
      "2",
      "00:00:10.000 --> 00:00:15.000",
      "Hello world!",
    ].join("\n");

    const vtt = srtToVtt(raw);
    expect(vtt).not.toContain("opensubtitles.org");
    expect(vtt).toContain("1\n00:00:10.000 --> 00:00:15.000\nHello world!");
  });

  it("preserves dialogue mentioning free words without false positives", () => {
    const raw = [
      "1",
      "00:00:10,000 --> 00:00:12,000",
      "Are you free tomorrow?",
    ].join("\n");

    const vtt = srtToVtt(raw);
    expect(vtt).toContain("Are you free tomorrow?");
  });
});
