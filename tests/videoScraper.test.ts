import { describe, expect, it } from "bun:test";
import { app } from "../index";
import {
  buildMasterPlaylistWithSubtitles,
  extractDurationFromMediaPlaylist,
  extractPlaylistDuration,
} from "../src/utils/m3u8";
import {
  inferSubtitleMetadata,
  normalizeSubtitleTracks,
  srtToVtt,
  extractDurationFromVtt,
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

  it("normalizes Wyzie translation endpoints and includes them in master playlist", () => {
    const candidates: RawSubtitleCandidate[] = [
      { url: "https://cache.vdrk.site/v2/movie/1657630/English.vtt", language: "en", format: "vtt" },
      { url: "https://sub.wyzie.io/translate?id=1657630&tk=token&target=Vietnamese", language: "vi", format: "srt" },
    ];
    const normalized = normalizeSubtitleTracks(
      candidates,
      "http://localhost:5005",
    );
    expect(normalized.length).toBe(2);
    const vi = normalized.find((t) => t.language === "vi");
    expect(vi).toBeDefined();
    expect(vi!.label).toBe("Vietnamese");
    expect(vi!.format).toBe("srt");
    expect(vi!.default).toBe(true);

    const payload = {
      video: {
        url: "https://stream.example.com/master.m3u8",
        format: "m3u8" as const,
        headers: {},
        body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8",
      },
      extractedAt: Date.now(),
      subCandidates: candidates,
    };
    // @ts-ignore
    const result = videoScraperService["formatResult"](
      payload,
      "https://vidnest.fun/movie/1657630",
      "http://localhost:5005",
    );
    expect(result.subtitles.length).toBe(2);
    expect(result.masterPlaylist).toContain('NAME="Vietnamese",DEFAULT=YES');
    expect(result.masterPlaylist).toContain('NAME="English",DEFAULT=NO');
    expect(result.masterPlaylist).toContain("sub%2Ewyzie%2Eio%2Ftranslate");
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
    // Verify variants are sorted descending: 720p appears before 360p
    expect(result.indexOf("1280x720")).toBeLessThan(result.indexOf("640x360"));
  });

  it("sorts variants descending from 4K/1080p down to 720p/480p", () => {
    const masterBody = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160
4k.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p.m3u8`;

    const result = buildMasterPlaylistWithSubtitles(
      "https://stream.example.com/master.m3u8",
      [],
      { videoBody: masterBody },
    );

    const idx4k = result.indexOf("3840x2160");
    const idx1080 = result.indexOf("1920x1080");
    const idx720 = result.indexOf("1280x720");
    const idx480 = result.indexOf("854x480");

    expect(idx4k).toBeLessThan(idx1080);
    expect(idx1080).toBeLessThan(idx720);
    expect(idx720).toBeLessThan(idx480);
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
      expect(text.startsWith("WEBVTT")).toBe(true);
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

  it("returns single-segment VOD media playlist with 24h target duration when playlist=1", async () => {
    const res = await app.handle(
      new Request(
        "http://localhost/proxy-sub?url=https%3A%2F%2Fexample.com%2Fsub.vtt&playlist=1",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain(
      "application/vnd.apple.mpegurl",
    );
    const text = await res.text();
    expect(text).toContain("#EXT-X-TARGETDURATION:86400");
    expect(text).toContain("#EXTINF:86400.000,");
    expect(text).toContain("#EXT-X-ENDLIST");
  });

  it("returns single-segment VOD media playlist with exact duration when duration query is provided", async () => {
    const res = await app.handle(
      new Request(
        "http://localhost/proxy-sub?url=https%3A%2F%2Fexample.com%2Fsub.vtt&playlist=1&duration=7140",
      ),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#EXT-X-TARGETDURATION:7140");
    expect(text).toContain("#EXTINF:7140.000,");
  });

  it("resolves exact duration from single-rendition media playlist (fixing 24h bug)", () => {
    const mediaBody = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-VERSION:3
#EXTINF:9.500,
seg1.ts
#EXTINF:10.000,
seg2.ts
#EXTINF:8.500,
seg3.ts
#EXT-X-ENDLIST`;

    const dur = extractDurationFromMediaPlaylist(mediaBody);
    expect(dur).toBe(28);

    const playlistDur = extractPlaylistDuration(mediaBody, "https://stream.example.com/media.m3u8");
    expect(playlistDur).toBe(28);
  });

  it("resolves exact duration from master playlist and nested master chains", () => {
    const masterBody = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
v1.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
v2.m3u8`;

    const variantMediaBody = `#EXTM3U
#EXTINF:6.000,
chunk1.ts
#EXTINF:6.000,
chunk2.ts
#EXTINF:4.500,
chunk3.ts
#EXT-X-ENDLIST`;

    const bodies = new Map<string, string>();
    bodies.set("https://stream.example.com/v1.m3u8", variantMediaBody);

    const dur = extractPlaylistDuration(
      masterBody,
      "https://stream.example.com/master.m3u8",
      (u) => bodies.get(u),
    );
    expect(dur).toBe(16.5);
  });

  it("extracts duration from WebVTT and SRT cue timestamps", () => {
    const vtt = `WEBVTT

1
00:01:00.000 --> 00:01:05.000
Start

2
01:45:20.500 --> 01:45:25.000
End dialogue`;

    // 1h 45m 25s = 6325s. + 15s buffer = 6340s.
    const durVtt = extractDurationFromVtt(vtt);
    expect(durVtt).toBe(6340);

    const srt = `1
00:00:10,000 --> 00:00:15,000
Hello

2
02:10:00,000 --> 02:10:05,000
Goodbye`;

    // 2h 10m 5s = 7805s. + 15s buffer = 7820s.
    const durSrt = extractDurationFromVtt(srt);
    expect(durSrt).toBe(7820);
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
      // Cosmetic media extension: strict HLS/ffmpeg clients refuse segment
      // URLs without one; the filename itself is ignored by the handler.
      expect(location).toContain("/proxy-chunk/segment.mp4?url=");
      expect(location).toContain("movie.mkv");
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });

  it("falls back to the fallback URL when the primary scrape fails", async () => {
    const origExtract = videoScraperService.extractVideo.bind(videoScraperService);
    const calledUrls: string[] = [];
    videoScraperService.extractVideo = (async (url: string) => {
      calledUrls.push(url);
      if (url === "https://vidnest.fun/movie/157336") {
        throw new Error("No playable video source found on page");
      }
      return {
        video: {
          url: "https://s3.example.com/backup/movie.mkv",
          format: "mkv",
          headers: {},
        },
        subtitles: [],
        extractedAt: Date.now(),
      };
    }) as typeof videoScraperService.extractVideo;

    try {
      const res = await app.handle(
        new Request(
          "http://localhost/scrape-video?url=https%3A%2F%2Fvidnest.fun%2Fmovie%2F157336&fallback=https%3A%2F%2Fplayer.videasy.ws%2Fembed%2Fmovie%2F157336&json=1",
        ),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.video.url).toBe("https://s3.example.com/backup/movie.mkv");
      expect(data.streamUrl).toBe("https://s3.example.com/backup/movie.mkv");
      expect(calledUrls).toEqual([
        "https://vidnest.fun/movie/157336",
        "https://player.videasy.ws/embed/movie/157336",
      ]);
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });

  it("points wrapper URLs at the fallback page and keeps the fallback param for m3u8", async () => {
    const origExtract = videoScraperService.extractVideo.bind(videoScraperService);
    videoScraperService.extractVideo = (async (url: string) => {
      if (url === "https://vidnest.fun/movie/157336") {
        throw new Error("No playable video source found on page");
      }
      return {
        video: {
          url: "https://s3.example.com/backup/master.m3u8",
          format: "m3u8",
          headers: {},
        },
        subtitles: [],
        masterPlaylist:
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nhttps://s3.example.com/backup/stream.m3u8',
        extractedAt: Date.now(),
      };
    }) as typeof videoScraperService.extractVideo;

    try {
      const res = await app.handle(
        new Request(
          "http://localhost/scrape-video?url=https%3A%2F%2Fvidnest.fun%2Fmovie%2F157336&fallback=https%3A%2F%2Fplayer.videasy.ws%2Fembed%2Fmovie%2F157336&json=1",
        ),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.masterPlaylistUrl).toContain(
        "url=" + encodeURIComponent("https://player.videasy.ws/embed/movie/157336"),
      );
      expect(data.masterPlaylistUrl).toContain("fallback=");
    } finally {
      videoScraperService.extractVideo = origExtract;
    }
  });
});
