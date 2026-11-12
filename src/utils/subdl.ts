import zlib from "node:zlib";
import type { RawSubtitleCandidate } from "./subtitles";

/**
 * Subdl Subtitles (api.subdl.com) fallback client.
 * Provides high-quality subtitles (especially for Vietnamese and English)
 * indexed by TMDB ID, season, and episode. Downloads are served as zip archives
 * and unpacked on-the-fly by Strix's /proxy-sub endpoint.
 */

const SUBDL_API_BASE = "https://api.subdl.com/api/v1";
const SUBDL_DL_BASE = "https://dl.subdl.com";

export interface SubdlSubtitle {
  url: string;
  language: string;
  format: string;
  release: string;
  episode?: number;
}

export interface SubdlApiRawEntry {
  release_name?: string;
  name?: string;
  lang?: string;
  language?: string;
  url?: string;
  season?: number | null;
  episode?: number | null;
  full_season?: boolean;
}

export interface SubdlApiResponse {
  status?: boolean;
  subtitles?: SubdlApiRawEntry[];
  error?: string;
}

/**
 * Checks if the given URL is a Subdl subtitle download link.
 */
export function isSubdlSubtitleUrl(url: string): boolean {
  return /subdl\.com/i.test(url) || /api_key=subdl_/i.test(url);
}

/**
 * Normalizes language codes from Subdl entries (e.g. "VI" -> "vi", "Vietnamese" -> "vi").
 */
function normalizeSubdlLang(entry: SubdlApiRawEntry): string {
  if (entry.language) return entry.language.trim().toLowerCase();
  const name = (entry.lang || "").toLowerCase();
  if (name.includes("vietnam")) return "vi";
  if (name.includes("english")) return "en";
  if (name.includes("spanish")) return "es";
  if (name.includes("french")) return "fr";
  if (name.includes("german")) return "de";
  return name.slice(0, 2);
}

/**
 * Extracts a WebVTT or SRT text from a Subdl zip archive buffer in memory.
 * If targetEpisode is provided and the zip contains multiple episodes (e.g. season pack),
 * picks the file matching the target episode.
 */
export function extractSubtitleFromZip(
  buffer: Buffer,
  targetEpisode?: number,
): string | null {
  let offset = 0;
  const entries: {
    name: string;
    method: number;
    compSize: number;
    dataOffset: number;
  }[] = [];

  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break; // PK\x03\x04
    const compMethod = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.toString(
      "utf8",
      offset + 30,
      offset + 30 + fileNameLen,
    );
    const dataOffset = offset + 30 + fileNameLen + extraLen;

    if (/\.(srt|vtt)$/i.test(fileName)) {
      entries.push({
        name: fileName,
        method: compMethod,
        compSize,
        dataOffset,
      });
    }
    offset = dataOffset + compSize;
  }

  if (entries.length === 0) return null;

  let picked = entries[0]!;
  if (targetEpisode !== undefined && entries.length > 1) {
    const ep = String(targetEpisode);
    const ep2 = ep.padStart(2, "0");
    const matched = entries.find((e) =>
      new RegExp(
        `(?:s\\d+e0*${ep}|e0*${ep}|\\b${ep2}\\b|episode\\s*0*${ep})`,
        "i",
      ).test(e.name),
    );
    if (matched) picked = matched;
  }

  const raw = buffer.subarray(
    picked.dataOffset,
    picked.dataOffset + picked.compSize,
  );
  if (picked.method === 8) {
    return zlib.inflateRawSync(raw).toString("utf8");
  } else if (picked.method === 0) {
    return raw.toString("utf8");
  }
  return null;
}

/**
 * Queries Subdl for subtitles of a TMDB title.
 * Prioritizes exact episode matches for TV series, and canonical language matches.
 */
export async function fetchSubdlSubtitles(
  apiKey: string,
  opts: {
    tmdbId: string;
    kind?: "movie" | "tv";
    season?: number;
    episode?: number;
    languages: string[];
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; status: number; subtitles: SubdlSubtitle[] }> {
  if (!apiKey) return { ok: false, status: 400, subtitles: [] };

  const isTv = opts.kind === "tv" || Boolean(opts.season || opts.episode);
  const type = isTv ? "tv" : "movie";

  const params = new URLSearchParams({
    api_key: apiKey,
    tmdb_id: opts.tmdbId,
    type,
  });
  if (opts.season) params.set("season_number", String(opts.season));
  if (opts.episode) params.set("episode_number", String(opts.episode));
  if (opts.languages.length > 0) {
    params.set("languages", opts.languages.join(","));
  }

  const timeoutSignal = AbortSignal.timeout(8000);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(`${SUBDL_API_BASE}/subtitles?${params}`, {
      headers: { accept: "application/json" },
      signal: combinedSignal,
    });
  } catch {
    return { ok: false, status: 0, subtitles: [] };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, subtitles: [] };
  }

  let body: SubdlApiResponse;
  try {
    body = (await res.json()) as SubdlApiResponse;
  } catch {
    return { ok: false, status: 502, subtitles: [] };
  }

  const entries = body.subtitles;
  if (!Array.isArray(entries)) {
    return { ok: true, status: 200, subtitles: [] };
  }

  const allowed = new Set(opts.languages.map((l) => l.toLowerCase()));
  const pickedByLang = new Map<string, SubdlSubtitle>();

  for (const entry of entries) {
    const rawPath = entry.url || "";
    if (!rawPath) continue;
    const langCode = normalizeSubdlLang(entry);
    if (allowed.size > 0 && !allowed.has(langCode)) continue;

    // Build absolute download URL with episode hint
    let fullUrl = rawPath.startsWith("http")
      ? rawPath
      : `${SUBDL_DL_BASE}${rawPath.startsWith("/") ? "" : "/"}${rawPath}`;

    if (opts.episode && !fullUrl.includes("target_ep=")) {
      fullUrl += `${fullUrl.includes("?") ? "&" : "?"}target_ep=${opts.episode}`;
    }

    const item: SubdlSubtitle = {
      url: fullUrl,
      language: langCode,
      format: "zip",
      release: entry.release_name || entry.name || "",
      episode: opts.episode,
    };

    const existing = pickedByLang.get(langCode);
    if (!existing) {
      pickedByLang.set(langCode, item);
      continue;
    }

    // If searching for an episode, prefer exact episode matches over full-season packs
    if (opts.episode) {
      const isExactMatch = entry.episode === opts.episode && !entry.full_season;
      if (isExactMatch) {
        pickedByLang.set(langCode, item);
      }
    }
  }

  return {
    ok: true,
    status: 200,
    subtitles: Array.from(pickedByLang.values()),
  };
}

/**
 * Maps Subdl subtitles into RawSubtitleCandidate for downstream processing.
 */
export function subdlToCandidates(
  subtitles: SubdlSubtitle[],
): RawSubtitleCandidate[] {
  return subtitles.map((s) => ({
    url: s.url,
    language: s.language,
    format: "srt",
    isDefault: false,
  }));
}
