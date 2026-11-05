import { describe, expect, it } from "bun:test";
import { app } from "../index";
import { buildMasterPlaylistWithSubtitles } from "../src/utils/m3u8";
import {
  inferSubtitleMetadata,
  normalizeSubtitleTracks,
  srtToVtt,
  type RawSubtitleCandidate,
} from "../src/utils/subtitles";
import { videoScraperService } from "../src/services/videoScraper.service";

describe("Subtitles Utilities (srtToVtt)", () => {
  it("converts standard SRT format to WebVTT", () => {
    const srt = `1
00:00:01,234 --> 00:00:04,567
Hello, welcome to Strix!

2
00:00:05,000 --> 00:00:08,100
Enjoy your movie with subtitles.`;

    const vtt = srtToVtt(srt);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.234 --> 00:00:04.567");
    expect(vtt).toContain("00:00:05.000 --> 00:00:08.100");
    expect(vtt).toContain("Hello, welcome to Strix!");
  });

  it("strips UTF-8 BOM and normalizes line endings", () => {
    const srtWithBom = `﻿1\r\n00:01:00,000 --> 00:01:05,000\r\nText with BOM\r\n`;
    const vtt = srtToVtt(srtWithBom);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).not.toContain("﻿");
    expect(vtt).toContain("00:01:00.000 --> 00:01:05.000");
    expect(vtt).toContain("Text with BOM");
  });

  it("passes through existing WebVTT content safely", () => {
    const originalVtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlready VTT`;
    const result = srtToVtt(originalVtt);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
    expect(result).toContain("Already VTT");
  });

  it("strips font color tags but preserves italic and bold tags", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
<font color="#ffff00"><i>Yellow italic</i></font> and <b>bold</b>.`;

    const vtt = srtToVtt(srt);
    expect(vtt).not.toContain("<font");
    expect(vtt).not.toContain("</font>");
    expect(vtt).toContain("<i>Yellow italic</i> and <b>bold</b>.");
  });
});

describe("Subtitle Metadata Inference & Normalization", () => {
  it("infers language and labels from codes and URLs", () => {
    const candidate: RawSubtitleCandidate = {
      url: "https://example.com/subtitles/English.vtt",
    };
    const track = inferSubtitleMetadata(
      candidate,
      0,
      "http://localhost:5005",
      "https://movie.site/watch/123",
    );
    expect(track.language).toBe("en");
    expect(track.label).toBe("English");
    expect(track.format).toBe("vtt");
    expect(track.proxyUrl).toContain("http://localhost:5005/proxy-sub?");
  });

  it("deduplicates tracks and selects one default", () => {
    const candidates: RawSubtitleCandidate[] = [
      { url: "https://example.com/subs/en.vtt", language: "en" },
      { url: "https://example.com/subs/en.vtt" }, // duplicate URL
      { url: "https://example.com/subs/vi.vtt", language: "vi" },
    ];
    const normalized = normalizeSubtitleTracks(
      candidates,
      "http://localhost:5005",
    );
    expect(normalized.length).toBe(2);
    // Vietnamese or English should be default
    const defaults = normalized.filter((t) => t.default);
    expect(defaults.length).toBe(1);
  });
});

describe("buildMasterPlaylistWithSubtitles", () => {
  it("augments an existing HLS Master Playlist with subtitles", () => {
    const masterBody = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720p.m3u8`;

    const subs = [
      {
        url: "https://cdn.example.com/en.vtt",
        proxyUrl: "http://localhost:5005/proxy-sub?url=en",
        label: "English",
        language: "en",
        format: "vtt" as const,
        default: true,
      },
      {
        url: "https://cdn.example.com/vi.vtt",
        proxyUrl: "http://localhost:5005/proxy-sub?url=vi",
        label: "Vietnamese",
        language: "vi",
        format: "vtt" as const,
        default: false,
      },
    ];

    const result = buildMasterPlaylistWithSubtitles(
      "https://stream.example.com/master.m3u8",
      subs,
      { videoBody: masterBody },
    );

    expect(result).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
    expect(result).toContain('NAME="English",DEFAULT=YES');
    expect(result).toContain('NAME="Vietnamese",DEFAULT=NO');
    expect(result).toContain('SUBTITLES="subs"');
    expect(result).toContain("https://stream.example.com/360p.m3u8");
  });

  it("synthesizes an HLS Master Playlist for a media playlist without existing master tags", () => {
    const subs = [
      {
        url: "https://cdn.example.com/en.vtt",
        proxyUrl: "http://localhost:5005/proxy-sub?url=en",
        label: "English",
        language: "en",
        format: "vtt" as const,
        default: true,
      },
    ];

    const result = buildMasterPlaylistWithSubtitles(
      "https://cdn.example.com/movies/media.m3u8",
      subs,
    );

    expect(result.startsWith("#EXTM3U")).toBe(true);
    expect(result).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
    expect(result).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="subs"',
    );
    expect(result).toContain("https://cdn.example.com/movies/media.m3u8");
  });
});

describe("/proxy-sub Endpoint", () => {
  it("converts upstream SRT subtitle to WebVTT with CORS headers", async () => {
    const srtFixture = `1
00:00:01,000 --> 00:00:03,000
Test Subtitle`;

    const mockSubServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response(srtFixture, {
          status: 200,
          headers: { "Content-Type": "application/x-subrip" },
        });
      },
    });

    const subUrl = `http://localhost:${mockSubServer.port}/sample.srt`;

    try {
      const res = await app.handle(
        new Request(
          `http://localhost/proxy-sub?url=${encodeURIComponent(subUrl)}`,
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/vtt");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const text = await res.text();
      expect(text.startsWith("WEBVTT\n\n")).toBe(true);
      expect(text).toContain("00:00:01.000 --> 00:00:03.000");
      expect(text).toContain("Test Subtitle");
    } finally {
      mockSubServer.stop(true);
    }
  });

  it("returns 400 when url parameter is missing", async () => {
    const res = await app.handle(new Request("http://localhost/proxy-sub"));
    expect(res.status).toBe(400);
  });
});

describe("/scrape-video Endpoint", () => {
  it("returns 400 when url parameter is missing", async () => {
    const res = await app.handle(new Request("http://localhost/scrape-video"));
    expect(res.status).toBe(400);
  });

  it("returns structured JSON when json=1 is requested", async () => {
    const origExtract = videoScraperService.extractVideo.bind(videoScraperService);
    videoScraperService.extractVideo = async () => ({
      video: {
        url: "https://s3.example.com/movies/movie.mkv",
        format: "mkv",
        headers: {},
      },
      subtitles: [
        {
          url: "https://s3.example.com/subs/en.vtt",
          proxyUrl: "http://localhost:5005/proxy-sub?url=en",
          label: "English",
          language: "en",
          format: "vtt",
          default: true,
        },
      ],
      masterPlaylist: "#EXTM3U\n#EXT-X-VERSION:6\n...",
      extractedAt: Date.now(),
    });

    try {
      const res = await app.handle(
        new Request(
          "http://localhost/scrape-video?url=https%3A%2F%2Fmovie.site%2F123&json=1",
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");

      const data = await res.json();
      expect(data.video.url).toBe("https://s3.example.com/movies/movie.mkv");
      expect(data.video.format).toBe("mkv");
      expect(data.format).toBe("mkv");
      expect(data.streamUrl).toBe("https://s3.example.com/movies/movie.mkv");
      expect(data.subtitles.length).toBe(1);
      expect(data.subtitles[0].label).toBe("English");
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });

  it("returns HLS Master Playlist for M3U8 video streams", async () => {
    const origExtract = videoScraperService.extractVideo.bind(videoScraperService);
    videoScraperService.extractVideo = async () => ({
      video: {
        url: "https://s3.example.com/movies/master.m3u8",
        format: "m3u8",
        headers: {},
      },
      subtitles: [
        {
          url: "https://s3.example.com/subs/en.vtt",
          proxyUrl: "http://localhost:5005/proxy-sub?url=en",
          label: "English",
          language: "en",
          format: "vtt",
          default: true,
        },
      ],
      masterPlaylist:
        '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="http://localhost:5005/proxy-sub?url=en"\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES="subs"\nhttps://s3.example.com/movies/stream.m3u8',
      extractedAt: Date.now(),
    });

    try {
      const res = await app.handle(
        new Request(
          "http://localhost/scrape-video?url=https%3A%2F%2Fmovie.site%2F123",
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain(
        "application/vnd.apple.mpegurl",
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const playlist = await res.text();
      expect(playlist.startsWith("#EXTM3U")).toBe(true);
      expect(playlist).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
      expect(playlist).toContain('SUBTITLES="subs"');
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });

  it("redirects directly (302) for MKV and MP4 videos", async () => {
    const origExtract = videoScraperService.extractVideo.bind(videoScraperService);
    videoScraperService.extractVideo = async () => ({
      video: {
        url: "https://s3.example.com/movies/movie.mkv",
        format: "mkv",
        headers: {},
      },
      subtitles: [],
      extractedAt: Date.now(),
    });

    try {
      const res = await app.handle(
        new Request(
          "http://localhost/scrape-video?url=https%3A%2F%2Fmovie.site%2F123",
        ),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://s3.example.com/movies/movie.mkv",
      );
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });

  it("redirects to proxy-chunk when proxy=true is requested for MKV", async () => {
    const origExtract = videoScraperService.extractVideo.bind(videoScraperService);
    videoScraperService.extractVideo = async () => ({
      video: {
        url: "https://s3.example.com/movies/movie.mkv",
        format: "mkv",
        headers: {},
      },
      subtitles: [],
      extractedAt: Date.now(),
    });

    try {
      const res = await app.handle(
        new Request(
          "http://localhost/scrape-video?url=https%3A%2F%2Fmovie.site%2F123&proxy=true",
        ),
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") || "";
      expect(location).toContain("/proxy-chunk?url=");
      expect(location).toContain("movie.mkv");
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });
});
