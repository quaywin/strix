import { describe, expect, it, mock } from "bun:test";
import zlib from "node:zlib";
import {
  fetchSubdlSubtitles,
  subdlToCandidates,
  isSubdlSubtitleUrl,
  extractSubtitleFromZip,
} from "../src/utils/subdl";

describe("isSubdlSubtitleUrl", () => {
  it("identifies Subdl download links correctly", () => {
    expect(
      isSubdlSubtitleUrl("https://dl.subdl.com/subtitle/123-456.zip?api_key=subdl_test"),
    ).toBe(true);
    expect(
      isSubdlSubtitleUrl("https://example.com/sub.zip?api_key=subdl_123"),
    ).toBe(true);
    expect(
      isSubdlSubtitleUrl("https://sub.wyzie.io/c/123/id/456"),
    ).toBe(false);
  });
});

const sampleSubdlJson = {
  status: true,
  subtitles: [
    {
      release_name: "Show.S03E04.1080p.x265",
      lang: "English",
      language: "EN",
      url: "/subtitle/1-ep4.zip?api_key=key",
      season: 3,
      episode: 4,
      full_season: false,
    },
    {
      release_name: "Show.S03.Pack",
      lang: "English",
      language: "EN",
      url: "/subtitle/2-pack.zip?api_key=key",
      season: 3,
      episode: null,
      full_season: true,
    },
    {
      release_name: "Show.S03E04.Vi",
      lang: "Vietnamese",
      language: "VI",
      url: "/subtitle/3-vi.zip?api_key=key",
      season: 3,
      episode: 4,
      full_season: false,
    },
  ],
};

describe("fetchSubdlSubtitles", () => {
  it("queries Subdl API and prioritizes exact episode match", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(sampleSubdlJson), { status: 200 })),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;
    try {
      const res = await fetchSubdlSubtitles("subdl_test_key", {
        tmdbId: "94997",
        season: 3,
        episode: 4,
        languages: ["vi", "en"],
      });

      expect(res.ok).toBe(true);
      expect(res.subtitles.length).toBe(2);
      const en = res.subtitles.find((s) => s.language === "en");
      const vi = res.subtitles.find((s) => s.language === "vi");
      expect(en).toBeDefined();
      expect(vi).toBeDefined();
      expect(en!.url).toContain("1-ep4.zip");
      expect(en!.url).toContain("target_ep=4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles empty key and errors safely", async () => {
    const res = await fetchSubdlSubtitles("", {
      tmdbId: "123",
      languages: ["en"],
    });
    expect(res.ok).toBe(false);
    expect(res.subtitles).toEqual([]);
  });
});

describe("subdlToCandidates", () => {
  it("converts Subdl subtitles to RawSubtitleCandidate", () => {
    const subs = [
      {
        url: "https://dl.subdl.com/subtitle/1.zip?target_ep=4",
        language: "vi",
        format: "zip",
        release: "Rel.1",
        episode: 4,
      },
    ];
    const candidates = subdlToCandidates(subs);
    expect(candidates).toEqual([
      {
        url: "https://dl.subdl.com/subtitle/1.zip?target_ep=4",
        language: "vi",
        format: "srt",
        isDefault: false,
      },
    ]);
  });
});

function createZipBuffer(files: { name: string; content: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const compressed = zlib.deflateRawSync(Buffer.from(f.content, "utf8"));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    header.writeUInt16LE(20, 4); // version
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // mtime
    header.writeUInt16LE(0, 12); // mdate
    header.writeUInt32LE(0, 14); // crc32
    header.writeUInt32LE(compressed.length, 18); // compSize
    header.writeUInt32LE(Buffer.byteLength(f.content), 22); // uncompSize
    header.writeUInt16LE(nameBuf.length, 26); // nameLen
    header.writeUInt16LE(0, 28); // extraLen
    parts.push(header, nameBuf, compressed);
  }
  return Buffer.concat(parts);
}

describe("extractSubtitleFromZip", () => {
  it("extracts and matches the correct episode from multi-file zip pack", () => {
    const zip = createZipBuffer([
      { name: "01 First Episode.srt", content: "Ep 1 Subtitle Text" },
      { name: "04 Tumbleton.srt", content: "Ep 4 Subtitle Text" },
      { name: "08 Final Episode.srt", content: "Ep 8 Subtitle Text" },
    ]);

    const extractedEp4 = extractSubtitleFromZip(zip, 4);
    expect(extractedEp4).toBe("Ep 4 Subtitle Text");

    const extractedEp1 = extractSubtitleFromZip(zip, 1);
    expect(extractedEp1).toBe("Ep 1 Subtitle Text");
  });

  it("extracts single movie subtitle without episode specified", () => {
    const zip = createZipBuffer([
      { name: "Movie.2024.1080p.srt", content: "Movie Subtitle Text" },
    ]);

    const extracted = extractSubtitleFromZip(zip);
    expect(extracted).toBe("Movie Subtitle Text");
  });
});
