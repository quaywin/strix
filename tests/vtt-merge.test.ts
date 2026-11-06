import { describe, expect, it } from "bun:test";
import {
  buildMasterPlaylistWithSubtitles,
  parseHlsSubtitleRenditions,
} from "../src/utils/m3u8";
import {
  buildVdrkSubtitleCandidates,
  parseEmbedVideoIdentity,
} from "../src/utils/embedSubtitles";
import {
  maybeFixMojibake,
  mergeHlsVttSegments,
  filterTracksByLanguages,
  secondsToVttTimestamp,
  vttTimestampToSeconds,
  type SubtitleTrack,
} from "../src/utils/subtitles";

describe("filterTracksByLanguages", () => {
  const track = (lang: string): SubtitleTrack => ({
    url: `https://x/${lang}.vtt`,
    proxyUrl: `https://p/${lang}`,
    label: lang.toUpperCase(),
    language: lang,
    format: "vtt",
    default: false,
  });

  it("keeps only configured languages, case-insensitively", () => {
    const filtered = filterTracksByLanguages(
      [track("vi"), track("EN"), track("zh"), track("und")],
      ["vi", "en"],
    );
    expect(filtered.map((t) => t.language)).toEqual(["vi", "EN"]);
  });

  it("treats '*' and empty lists as keep-all", () => {
    const tracks = [track("vi"), track("zh")];
    expect(filterTracksByLanguages(tracks, "*").length).toBe(2);
    expect(filterTracksByLanguages(tracks, []).length).toBe(2);
  });
});

describe("buildMasterPlaylistWithSubtitles passthrough", () => {
  it("routes variants, audio/subtitle renditions and I-frame playlists through the proxy", () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio-en.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs-en.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,CODECS="avc1",URI="iframes-v1.txt"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES="subs"',
      "v1.m3u8",
    ].join("\n");

    const out = buildMasterPlaylistWithSubtitles(
      "https://cdn.example.com/hls/master.m3u8",
      [],
      {
        videoBody: body,
        proxySegmentUrl: (u) => `https://strix.test/playlist?url=${encodeURIComponent(u)}`,
      },
    );

    const wrap = (rel: string) =>
      `https://strix.test/playlist?url=${encodeURIComponent(`https://cdn.example.com/hls/${rel}`)}`;
    expect(out).toContain(`URI="${wrap("audio-en.m3u8")}"`);
    expect(out).toContain(`URI="${wrap("subs-en.m3u8")}"`);
    expect(out).toContain(`URI="${wrap("iframes-v1.txt")}"`);
    expect(out).toContain(wrap("v1.m3u8"));
    // No upstream URI is left relative (would resolve against strix's origin)
    expect(out).not.toContain('URI="audio-en.m3u8"');
    expect(out).not.toContain('URI="iframes-v1.txt"');
  });
});

describe("maybeFixMojibake", () => {
  it("reverses Windows-1256 double-encoded Vietnamese captions", () => {
    const bad =
      "ؤگئ°ل»£c rل»“i, tل»« tل»« nhأ©. ؤگل»«ng bل؛¯n vل»™i.";
    expect(maybeFixMojibake(bad)).toBe(
      "Được rồi, từ từ nhé. Đừng bắn vội.",
    );
  });

  it("passes through clean Vietnamese and legit Arabic text untouched", () => {
    const cleanVtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nXin chào Việt Nam.";
    expect(maybeFixMojibake(cleanVtt)).toBe(cleanVtt);
    const arabic = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nمرحبا بالعالم";
    expect(maybeFixMojibake(arabic)).toBe(arabic);
  });
});

describe("parseEmbedVideoIdentity / buildVdrkSubtitleCandidates", () => {
  it("parses movie and tv identities from embed URLs", () => {
    expect(parseEmbedVideoIdentity("https://vidnest.fun/movie/299534")).toEqual({
      kind: "movie",
      tmdbId: "299534",
    });
    expect(
      parseEmbedVideoIdentity("https://vidnest.fun/tv/119051/1/1"),
    ).toEqual({ kind: "tv", tmdbId: "119051", season: 1, episode: 1 });
    expect(parseEmbedVideoIdentity("https://not-an-embed.example.com/foo")).toBeNull();
  });

  it("builds probe candidates against the static caption cache", () => {
    const movieSubs = buildVdrkSubtitleCandidates(
      "https://vidnest.fun/movie/299534",
    );
    expect(movieSubs.length).toBeGreaterThan(0);
    expect(movieSubs[0]!.url).toBe(
      "https://cache.vdrk.site/v2/movie/299534/Vietnamese.vtt",
    );
    expect(movieSubs[0]!.language).toBe("vi");

    const tvSubs = buildVdrkSubtitleCandidates(
      "https://vidnest.fun/tv/119051/2/3",
    );
    expect(tvSubs[0]!.url).toBe(
      "https://cache.vdrk.site/v2/tv/119051/2/3/Vietnamese.vtt",
    );
  });

  it("restricts probe candidates to configured language codes", () => {
    const subs = buildVdrkSubtitleCandidates(
      "https://vidnest.fun/movie/299534",
      ["vi", "en"],
    );
    expect(subs.length).toBe(2);
    expect(subs.map((s) => s.language)).toEqual(["vi", "en"]);
    expect(subs[0]!.url).toBe(
      "https://cache.vdrk.site/v2/movie/299534/Vietnamese.vtt",
    );
    expect(subs[1]!.url).toBe(
      "https://cache.vdrk.site/v2/movie/299534/English.vtt",
    );
  });
});

describe("parseHlsSubtitleRenditions", () => {
  const masterUrl = "https://cdn.example.com/hls/master.m3u8";

  it("extracts SUBTITLES renditions with metadata and resolved URIs", () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio-en.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="https://cdn.example.com/hls/subs/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Vietnamese",DEFAULT=NO,LANGUAGE="vi",URI="subs/vi.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES=\"subs\"",
      "v1.m3u8",
    ].join("\n");

    const tracks = parseHlsSubtitleRenditions(body, masterUrl);
    expect(tracks.length).toBe(2);
    const en = tracks[0]!;
    const vi = tracks[1]!;
    expect(en.url).toBe("https://cdn.example.com/hls/subs/en.m3u8");
    expect(en.language).toBe("en");
    expect(en.label).toBe("English");
    expect(en.isDefault).toBe(true);
    // Relative rendition URI resolves against the master URL
    expect(vi.url).toBe("https://cdn.example.com/hls/subs/vi.m3u8");
    expect(vi.language).toBe("vi");
    expect(vi.isDefault).toBe(false);
  });

  it("ignores closed-caption tags and playlists without renditions", () => {
    expect(parseHlsSubtitleRenditions("#EXTM3U\nv1.m3u8", masterUrl)).toEqual([]);
    const cc = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"',
    ].join("\n");
    expect(parseHlsSubtitleRenditions(cc, masterUrl)).toEqual([]);
  });
});

describe("mergeHlsVttSegments", () => {
  it("merges segments, strips repeated headers, applies MPEGTS offsets", () => {
    const seg0 = [
      "WEBVTT",
      "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000",
      "",
      "00:00:00.500 --> 00:00:02.000",
      "hello",
    ].join("\n");
    const seg1 = [
      "WEBVTT",
      "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "world",
    ].join("\n");

    const merged = mergeHlsVttSegments([seg0, seg1]);
    expect(merged.startsWith("WEBVTT\n\n")).toBe(true);
    // Only one WEBVTT header survives the merge
    expect(merged.match(/WEBVTT/g)?.length).toBe(1);
    expect(merged).not.toContain("X-TIMESTAMP-MAP");
    // MPEGTS:900000 = 10s at 90kHz — cue times shift by +10s
    expect(merged).toContain("00:00:10.500 --> 00:00:12.000");
    expect(merged).toContain("00:00:12.000 --> 00:00:14.000");
    expect(merged).toContain("hello");
    expect(merged).toContain("world");
  });

  it("deduplicates identical cues duplicated across segment boundaries", () => {
    const cue = "00:00:05.000 --> 00:00:06.000\ndup";
    const merged = mergeHlsVttSegments([`WEBVTT\n\n${cue}`, `WEBVTT\n\n${cue}`]);
    expect(merged.match(/dup/g)?.length).toBe(1);
  });
});

describe("timestamp helpers", () => {
  it("round-trips VTT timestamps", () => {
    expect(vttTimestampToSeconds("01:02:03.456")).toBeCloseTo(3723.456);
    expect(vttTimestampToSeconds("02:03.456")).toBeCloseTo(123.456);
    expect(vttTimestampToSeconds("bogus")).toBeNull();
    expect(secondsToVttTimestamp(3723.456)).toBe("01:02:03.456");
    expect(secondsToVttTimestamp(-5)).toBe("00:00:00.000");
  });
});
