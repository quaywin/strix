import type { RawSubtitleCandidate } from "./subtitles";

/**
 * Subtitle source for embed players of the vidnest family (vidnest.fun and
 * siblings). Their players fetch captions from a static, untokened cache
 * derived purely from the TMDB id:
 *
 *   https://cache.vdrk.site/v2/movie/{tmdbId}/{Language}.vtt
 *   https://cache.vdrk.site/v2/tv/{tmdbId}/{season}/{episode}/{Language}.vtt
 *
 * Candidates are probed once per fresh scrape with cheap headers-only
 * requests, so repeated playback requests pay nothing.
 */
const SUB_CACHE_BASE = "https://cache.vdrk.site/v2";

/** Language file names observed on the subtitle cache (capitalized labels). */
export const SUB_CACHE_LANGUAGES = [
  "Vietnamese",
  "English",
  "Spanish",
  "Arabic",
  "French",
  "German",
  "Japanese",
  "Korean",
  "Chinese",
  "Portuguese",
  "Italian",
  "Indonesian",
  "Thai",
  "Hindi",
  "Turkish",
  "Russian",
  "Filipino",
  "Dutch",
  "Polish",
  "Malay",
];

export interface EmbedVideoIdentity {
  kind: "movie" | "tv";
  tmdbId: string;
  season?: number;
  episode?: number;
}

/**
 * Extracts the TMDB identity from a standard embed URL of the form
 * .../movie/{id} or .../tv/{id}/{season}/{episode}. Works for vidnest.fun
 * and other providers following the same path convention.
 */
export function parseEmbedVideoIdentity(
  embedUrl: string,
): EmbedVideoIdentity | null {
  try {
    const path = new URL(embedUrl).pathname;
    const segments = path.split("/").filter(Boolean);

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!.toLowerCase();
      const id = segments[i + 1]!;
      if (!/^\d{2,}$/.test(id)) continue;

      if (seg === "movie" || seg === "m") {
        return { kind: "movie", tmdbId: id };
      }
      if (seg === "tv" || seg === "show" || seg === "series") {
        const season = Number(segments[i + 2]);
        const episode = Number(segments[i + 3]);
        return {
          kind: "tv",
          tmdbId: id,
          ...(Number.isInteger(season) && season > 0 ? { season } : {}),
          ...(Number.isInteger(episode) && episode > 0 ? { episode } : {}),
        };
      }
    }
  } catch {}
  return null;
}

/**
 * Builds probe candidates for the static subtitle cache. Order matters:
 * Vietnamese first so the shared default-track preference (vi > en > first)
 * picks it when present.
 */
export function buildVdrkSubtitleCandidates(
  embedUrl: string,
): RawSubtitleCandidate[] {
  const identity = parseEmbedVideoIdentity(embedUrl);
  if (!identity) return [];

  const base =
    identity.kind === "movie"
      ? `${SUB_CACHE_BASE}/movie/${identity.tmdbId}`
      : identity.season && identity.episode
        ? `${SUB_CACHE_BASE}/tv/${identity.tmdbId}/${identity.season}/${identity.episode}`
        : `${SUB_CACHE_BASE}/tv/${identity.tmdbId}`;

  return SUB_CACHE_LANGUAGES.map((lang) => ({
    url: `${base}/${lang}.vtt`,
    label: lang,
    isDefault: false,
  }));
}
