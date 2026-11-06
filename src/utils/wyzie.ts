import type { RawSubtitleCandidate } from "./subtitles";

/**
 * Wyzie Subtitles (sub.wyzie.io) fallback client. The /search endpoint takes
 * the TMDB id directly and returns DIRECT download links to SRT files —
 * nothing needs to be pre-downloaded or unpacked; the links go straight
 * into the subtitle candidates and /proxy-sub fetches+converts them lazily
 * when a player actually selects the track.
 */

const WYZIE_API_BASE = "https://sub.wyzie.io";

export interface WyzieSubtitle {
  url: string;
  /** Lowercased language code as Wyzie reports it, e.g. "en", "vi", "en-US". */
  language: string;
  format: string;
  release: string;
}

interface WyzieApiEntry {
  url?: string;
  language?: string;
  format?: string;
  release?: string;
}

/**
 * Queries Wyzie for subtitles of a TMDB title. Keeps the first exact-match
 * per configured language code (variants like "en-US" are ignored — the
 * plain "en" entries are the canonical releases). Results come ranked by
 * Wyzie already.
 */
export async function fetchWyzieSubtitles(
  apiKey: string,
  opts: {
    tmdbId: string;
    season?: number;
    episode?: number;
    languages: string[];
    signal?: AbortSignal;
  },
): Promise<WyzieSubtitle[]> {
  const params = new URLSearchParams({ key: apiKey, id: opts.tmdbId });
  if (opts.season) params.set("season", String(opts.season));
  if (opts.episode) params.set("episode", String(opts.episode));
  if (opts.languages.length > 0) {
    params.set("language", opts.languages.join(","));
  }

  const res = await fetch(`${WYZIE_API_BASE}/search?${params}`, {
    headers: { accept: "application/json" },
    signal: opts.signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];

  let body: WyzieApiEntry[];
  try {
    body = (await res.json()) as WyzieApiEntry[];
  } catch {
    return [];
  }
  if (!Array.isArray(body)) return [];

  const allowed = new Set(opts.languages.map((l) => l.toLowerCase()));
  const seenLanguages = new Set<string>();
  const picked: WyzieSubtitle[] = [];
  for (const entry of body) {
    const url = entry.url || "";
    const language = (entry.language || "").toLowerCase();
    if (!url.startsWith("http") || !language) continue;
    if (allowed.size > 0 && !allowed.has(language)) continue;
    if (seenLanguages.has(language)) continue; // first-listed wins per language
    seenLanguages.add(language);
    picked.push({
      url,
      language,
      format: (entry.format || "srt").toLowerCase(),
      release: entry.release || "",
    });
  }
  return picked;
}

/** Maps Wyzie entries to subtitle candidates (URL is used as-is). */
export function wyzieToCandidates(
  subtitles: WyzieSubtitle[],
): RawSubtitleCandidate[] {
  return subtitles
    .filter((s) => s.format === "srt" || s.format === "vtt")
    .map((s) => ({
      url: s.url,
      language: s.language,
      format: (s.format as "vtt" | "srt") || "srt",
      isDefault: false,
    }));
}
