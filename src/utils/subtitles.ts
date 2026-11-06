/**
 * Subtitle handling and conversion utilities for Strix VOD scraping.
 */

export interface RawSubtitleCandidate {
  url: string;
  label?: string;
  language?: string;
  kind?: string;
  isDefault?: boolean;
}

export interface SubtitleTrack {
  url: string;
  proxyUrl: string;
  label: string;
  language: string; // ISO 639-1 / BCP 47 (e.g. "en", "vi", "es")
  format: "vtt" | "srt";
  default: boolean;
}

const LANGUAGE_LOOKUP: Record<string, { code: string; label: string }> = {
  en: { code: "en", label: "English" },
  eng: { code: "en", label: "English" },
  vi: { code: "vi", label: "Vietnamese" },
  vie: { code: "vi", label: "Vietnamese" },
  vn: { code: "vi", label: "Vietnamese" },
  es: { code: "es", label: "Spanish" },
  spa: { code: "es", label: "Spanish" },
  fr: { code: "fr", label: "French" },
  fra: { code: "fr", label: "French" },
  fre: { code: "fr", label: "French" },
  de: { code: "de", label: "German" },
  ger: { code: "de", label: "German" },
  deu: { code: "de", label: "German" },
  ja: { code: "ja", label: "Japanese" },
  jpn: { code: "ja", label: "Japanese" },
  ko: { code: "ko", label: "Korean" },
  kor: { code: "ko", label: "Korean" },
  zh: { code: "zh", label: "Chinese" },
  chi: { code: "zh", label: "Chinese" },
  zho: { code: "zh", label: "Chinese" },
  ar: { code: "ar", label: "Arabic" },
  ara: { code: "ar", label: "Arabic" },
  ru: { code: "ru", label: "Russian" },
  rus: { code: "ru", label: "Russian" },
  pt: { code: "pt", label: "Portuguese" },
  por: { code: "pt", label: "Portuguese" },
  it: { code: "it", label: "Italian" },
  ita: { code: "it", label: "Italian" },
  id: { code: "id", label: "Indonesian" },
  ind: { code: "id", label: "Indonesian" },
  th: { code: "th", label: "Thai" },
  tha: { code: "th", label: "Thai" },
  hi: { code: "hi", label: "Hindi" },
  hin: { code: "hi", label: "Hindi" },
  tr: { code: "tr", label: "Turkish" },
  tur: { code: "tr", label: "Turkish" },
};

/** Lazily built char -> Windows-1256 byte map for mojibake reversal. */
let cp1256Encoder: Map<string, number> | null = null;

function getCp1256Encoder(): Map<string, number> {
  if (!cp1256Encoder) {
    cp1256Encoder = new Map<string, number>();
    const decoder = new TextDecoder("windows-1256");
    for (let byte = 0; byte < 256; byte++) {
      const ch = decoder.decode(new Uint8Array([byte]));
      if (!cp1256Encoder.has(ch)) cp1256Encoder.set(ch, byte);
    }
  }
  return cp1256Encoder;
}

/**
 * Repairs double-encoded captions. The vidnest-family caption cache stores
 * Vietnamese (and other Latin-extended) text whose UTF-8 bytes were decoded
 * as Windows-1256 — e.g. "Được" becomes "ؤگئ°ل»£c". Detected by the presence
 * of Arabic-block letters in text that, once reversed, reads as clean
 * Latin-extended content. Legit Arabic captions fail the reversal checks and
 * pass through untouched.
 */
export function maybeFixMojibake(text: string): string {
  if (!/[؀-ۿ]/.test(text)) return text;

  const map = getCp1256Encoder();
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const byte = map.get(text[i]!);
    if (byte === undefined) return text;
    bytes[i] = byte;
  }

  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const stillHasArabic = /[؀-ۿ]/.test(repaired);
    const hasLatinExtended = /[À-ǿḀ-ỿ]/.test(repaired);
    if (!stillHasArabic && hasLatinExtended) return repaired;
  } catch {}
  return text;
}

/**
 * Converts SubRip (SRT) format to WebVTT format.
 * - Strips UTF-8 BOM if present
 * - Normalizes line breaks to LF (\n)
 * - Converts comma millisecond separators to periods (00:00:00,000 -> 00:00:00.000)
 * - Normalizes mm:ss,ms to 00:mm:ss.ms
 * - Strips unsupported HTML tags (<font>, etc.) while preserving <i>, <b>, <u>
 * - Ensures output begins with WEBVTT header
 */
export function srtToVtt(content: string): string {
  if (!content) return "WEBVTT\n\n";

  // Remove UTF-8 BOM if present
  let normalized = content.replace(/^﻿/, "").replace(/\r\n|\r/g, "\n").trim();

  // If already WebVTT, return directly with normalized header
  if (normalized.startsWith("WEBVTT")) {
    return normalized + "\n";
  }

  // Remove <font> tags while preserving inner text
  normalized = normalized.replace(/<\/?font[^>]*>/gi, "");

  // Convert SRT timecodes: 00:01:23,456 --> 00:01:25,789
  // Also handle two-part: 01:23,456 --> 01:25,789
  const timecodeRegex =
    /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/g;

  normalized = normalized.replace(
    timecodeRegex,
    (_match, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
      const hh1 = (h1 !== undefined ? h1 : "00").padStart(2, "0");
      const hh2 = (h2 !== undefined ? h2 : "00").padStart(2, "0");
      return `${hh1}:${m1}:${s1}.${ms1} --> ${hh2}:${m2}:${s2}.${ms2}`;
    },
  );

  return `WEBVTT\n\n${normalized}\n`;
}

/**
 * Infers language code (ISO 639-1 / BCP 47) and human-readable label from candidate metadata or URL.
 */
export function inferSubtitleMetadata(
  candidate: RawSubtitleCandidate,
  index: number,
  requestOrigin: string,
  pageUrl?: string,
): SubtitleTrack {
  const url = candidate.url;
  const isSrt = /\.srt($|\?)/i.test(url);
  const format: "vtt" | "srt" = isSrt ? "srt" : "vtt";

  let detectedCode = "";
  let detectedLabel = "";

  // 1. Try provided language code
  if (candidate.language) {
    const cleanLang = candidate.language.toLowerCase().trim();
    if (LANGUAGE_LOOKUP[cleanLang]) {
      detectedCode = LANGUAGE_LOOKUP[cleanLang].code;
      detectedLabel = LANGUAGE_LOOKUP[cleanLang].label;
    } else {
      detectedCode = cleanLang.slice(0, 3);
    }
  }

  // 2. Try provided label
  if (candidate.label) {
    const cleanLabel = candidate.label.toLowerCase().trim();
    for (const [key, val] of Object.entries(LANGUAGE_LOOKUP)) {
      if (
        cleanLabel.includes(val.label.toLowerCase()) ||
        cleanLabel === key
      ) {
        if (!detectedCode) detectedCode = val.code;
        if (!detectedLabel) detectedLabel = val.label;
        break;
      }
    }
    if (!detectedLabel) {
      detectedLabel = candidate.label.trim();
    }
  }

  // 3. Fallback: Parse from URL filename or path segments
  if (!detectedCode || !detectedLabel) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      // Match common patterns like /en.vtt, _vi.vtt, -vietnamese.vtt, /English.vtt
      for (const [key, val] of Object.entries(LANGUAGE_LOOKUP)) {
        const regex = new RegExp(`(?:^|[._/-])${key}(?:[._/-]|$)`, "i");
        const labelRegex = new RegExp(`(?:^|[._/-])${val.label.toLowerCase()}(?:[._/-]|$)`, "i");
        if (regex.test(pathname) || labelRegex.test(pathname)) {
          if (!detectedCode) detectedCode = val.code;
          if (!detectedLabel) detectedLabel = val.label;
          break;
        }
      }
    } catch (_) {}
  }

  const finalCode = detectedCode || "und";
  const finalLabel = detectedLabel || (finalCode !== "und" ? finalCode.toUpperCase() : `Track ${index + 1}`);

  const proxyParams = new URLSearchParams({
    url: candidate.url,
  });
  if (pageUrl) {
    proxyParams.set("referer", pageUrl);
  }
  const proxyUrl = `${requestOrigin}/proxy-sub?${proxyParams.toString()}`;

  return {
    url: candidate.url,
    proxyUrl,
    label: finalLabel,
    language: finalCode,
    format,
    default: Boolean(candidate.isDefault),
  };
}

/**
 * Converts a WebVTT timestamp ("HH:MM:SS.mmm" or "MM:SS.mmm") to seconds.
 * Returns null when the string is malformed.
 */
export function vttTimestampToSeconds(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})$/);
  if (!m) return null;
  return (
    (m[1] ? parseInt(m[1], 10) * 3600 : 0) +
    parseInt(m[2] ?? "0", 10) * 60 +
    parseInt(m[3] ?? "0", 10) +
    parseInt(m[4] ?? "0", 10) / 1000
  );
}

/** Formats seconds as a WebVTT timestamp "HH:MM:SS.mmm". */
export function secondsToVttTimestamp(totalSec: number): string {
  const clamped = Math.max(0, totalSec);
  const hh = String(Math.floor(clamped / 3600)).padStart(2, "0");
  const mm = String(Math.floor((clamped % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(clamped % 60)).padStart(2, "0");
  const ms = String(Math.round((clamped - Math.floor(clamped)) * 1000)).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

const VTT_CUE_TIMING = /(\d{1,2}:)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})\.(\d{3})/;

/** Parses the LOCAL/MPEGTS offset mapping from an HLS WebVTT segment. */
function parseTimestampMap(lines: string[]): number {
  for (const line of lines) {
    const m = line.match(/X-TIMESTAMP-MAP[:=]\s*LOCAL:([\d:.]+),\s*MPEGTS:(\d+)/i);
    if (!m) continue;
    const localSec = vttTimestampToSeconds(m[1] ?? "0");
    const mpegtsSec = parseInt(m[2] ?? "0", 10) / 90000; // 90kHz MPEG clock
    if (localSec !== null) return mpegtsSec - localSec;
  }
  return 0;
}

/**
 * Merges HLS WebVTT segments (each with its own WEBVTT header and optional
 * X-TIMESTAMP-MAP offset) into one clean WebVTT document:
 * - Applies each segment's MPEGTS offset to its cue timestamps
 * - Drops repeated WEBVTT / NOTE / header lines from later segments
 * - Repairs double-encoded text per segment
 * - Deduplicates identical cues that overlap at segment boundaries
 */
export function mergeHlsVttSegments(segments: string[]): string {
  const outBlocks: string[] = [];
  const seen = new Set<string>();

  for (const raw of segments) {
    if (!raw) continue;
    const text = maybeFixMojibake(
      raw.replace(/^﻿/, "").replace(/\r\n|\r/g, "\n"),
    );
    const segOffset = parseTimestampMap(text.split("\n"));

    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) continue;

      // Skip segment headers and comment/style blocks
      const first = lines[0] ?? "";
      if (/^WEBVTT/i.test(first)) lines.shift();
      if (lines.length === 0) continue;
      const isTag = (l: string) => l.startsWith("NOTE") || /^(STYLE|REGION)/i.test(l);
      if (isTag(lines[0] ?? "")) continue;
      const filtered = lines.filter((l) => !/^X-TIMESTAMP-MAP:/i.test(l));
      if (filtered.length === 0) continue;

      const timingIdx = filtered.findIndex((l) => VTT_CUE_TIMING.test(l));
      if (timingIdx === -1) continue;

      const timingLine = filtered[timingIdx]!;
      const m = timingLine.match(VTT_CUE_TIMING)!;
      const startSec =
        vttTimestampToSeconds(`${m[1] ?? "00:"}${m[2] ?? ""}:${m[3] ?? ""}.${m[4] ?? "000"}`) ?? 0;
      const endSec =
        vttTimestampToSeconds(`${m[5] ?? "00:"}${m[6] ?? ""}:${m[7] ?? ""}.${m[8] ?? "000"}`) ?? 0;

      const newStart = startSec + segOffset;
      const newEnd = endSec + segOffset;
      if (newEnd <= newStart) continue;

      const body = filtered.slice(timingIdx + 1).join("\n");
      const key = `${newStart.toFixed(3)}|${newEnd.toFixed(3)}|${body}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const rest = timingLine.replace(VTT_CUE_TIMING, "");
      outBlocks.push(
        `${secondsToVttTimestamp(newStart)} --> ${secondsToVttTimestamp(newEnd)}${rest}\n${body}`,
      );
    }
  }

  return `WEBVTT\n\n${outBlocks.join("\n\n")}\n`;
}

/**
 * Computes which configured languages are still missing from a candidate
 * set ("*" allowed-list disables the fill — every language vdrk knows is
 * already welcome, there is no finite per-language list to fill from).
 */
export function missingLanguages(
  allowed: string[] | "*",
  existing: ReadonlyArray<{ language?: string }>,
): string[] {
  if (allowed === "*") return [];
  const found = new Set(
    existing.map((c) => (c.language || "").toLowerCase()),
  );
  return allowed.filter((l) => !found.has(l));
}

/**
 * Keeps only tracks in the configured language codes ("*" = keep all).
 * An empty list is treated as "*" so a typo in the config cannot silently
 * disable subtitles altogether.
 */
export function filterTracksByLanguages(
  tracks: SubtitleTrack[],
  allowed: string[] | "*",
): SubtitleTrack[] {
  if (allowed === "*" || allowed.length === 0) return tracks;
  const set = new Set(allowed);
  return tracks.filter((t) => set.has(t.language.toLowerCase()));
}

/**
 * Normalizes an array of raw subtitle candidates:
 * - Deduplicates identical URLs
 * - Infers metadata
 * - Ensures exactly one default track (prefers Vietnamese if present, else English, else first track)
 */
export function normalizeSubtitleTracks(
  candidates: RawSubtitleCandidate[],
  requestOrigin: string,
  pageUrl?: string,
): SubtitleTrack[] {
  const seenUrls = new Set<string>();
  const uniqueCandidates: RawSubtitleCandidate[] = [];

  for (const c of candidates) {
    if (!c.url || !c.url.startsWith("http")) continue;
    // Normalize URL key (ignore trailing query if same endpoint)
    const cleanUrl = c.url.trim();
    if (!seenUrls.has(cleanUrl)) {
      seenUrls.add(cleanUrl);
      uniqueCandidates.push(c);
    }
  }

  const tracks = uniqueCandidates.map((c, i) =>
    inferSubtitleMetadata(c, i, requestOrigin, pageUrl),
  );

  if (tracks.length === 0) return [];

  // Check if any track is marked default
  const hasDefault = tracks.some((t) => t.default);
  if (!hasDefault) {
    // Prefer Vietnamese or English as default
    const viTrack = tracks.find((t) => t.language === "vi");
    const enTrack = tracks.find((t) => t.language === "en");
    if (viTrack) {
      viTrack.default = true;
    } else if (enTrack) {
      enTrack.default = true;
    } else if (tracks[0]) {
      tracks[0].default = true;
    }
  } else {
    // Ensure only one track is marked default
    let firstDefault = false;
    for (const t of tracks) {
      if (t.default) {
        if (!firstDefault) {
          firstDefault = true;
        } else {
          t.default = false;
        }
      }
    }
  }

  return tracks;
}
