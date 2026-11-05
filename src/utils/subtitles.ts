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
