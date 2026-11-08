import "dotenv/config";

/**
 * Parses SUBTITLE_LANGUAGES ("vi,en" | "*") into a filter spec.
 * Empty/unset defaults to Vietnamese + English.
 */
function parseSubtitleLanguages(): string[] | "*" {
  const raw = (process.env.SUBTITLE_LANGUAGES ?? "vi,en").trim();
  if (raw === "*") return "*";
  const codes = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return codes.length > 0 ? codes : "*";
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || "5005", 10),
  CHROME_PATH: process.env.CHROME_PATH || "",
  USER_DATA_DIR: process.env.USER_DATA_DIR || "./user_data",
  PROXY_SERVER: process.env.PROXY_SERVER || "", // e.g. "http://123.45.67.89:8080" hoặc "http://user:pass@host:port"
  HEADLESS: process.env.HEADLESS !== "false", // Mặc định là true nếu không cấu hình là "false"
  SCRAPER: {
    // VOD scrape timeout (/scrape-video). vidfast.vc warms up its source
    // backend for ~15-25s per fresh session before the stream appears.
    DEFAULT_TIMEOUT: parseInt(process.env.SCRAPER_TIMEOUT || "20000", 10),
    // Live-stream scrape timeout (/scrape-stream). Sources usually emit
    // quickly; keep this shorter so dead links fail fast.
    STREAM_TIMEOUT: parseInt(process.env.SCRAPER_STREAM_TIMEOUT || "30000", 10),
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT_SCRAPES || "3", 10),
  },
  // Maximum number of items in the in-memory cache to prevent unbounded growth
  CACHE_MAX_ITEMS: parseInt(process.env.CACHE_MAX_ITEMS || "1000", 10),
  // 50 minutes — signed m3u8 URLs usually carry short-lived expiry tokens,
  // so we keep the cache short to avoid serving stale links.
  CACHE_TTL_MS: 50 * 60 * 1000,
  // 6 hours for VOD media and playlists
  VOD_CACHE_TTL_MS: parseInt(
    process.env.VOD_CACHE_TTL_MS || String(6 * 60 * 60 * 1000),
    10,
  ),
  // 6 hours for converted subtitle WebVTT files
  SUBTITLE_CACHE_TTL_MS: parseInt(
    process.env.SUBTITLE_CACHE_TTL_MS || String(6 * 60 * 60 * 1000),
    10,
  ),
  // Browser recycling: automatically close and renew browser context after
  // N scrape operations to prevent Chromium V8 memory fragmentation over time.
  MAX_BROWSER_USES: parseInt(process.env.MAX_BROWSER_USES || "30", 10),
  // Hard cap on how long proxy mode waits for the upstream stream URL to
  // start responding. Prevents a hung upstream from pinning a client
  // connection forever.
  PROXY_UPSTREAM_TIMEOUT_MS: parseInt(
    process.env.PROXY_UPSTREAM_TIMEOUT_MS || "30000",
    10,
  ),
  // Signed stream URLs on these CDNs die within ~1-2 minutes while VOD cache
  // lives for hours. Cached m3u8 payloads older than this get a liveness ping
  // before being served; dead tokens trigger a fresh scrape instead of
  // handing players 404-ing URLs.
  STREAM_REVALIDATE_MS: parseInt(
    process.env.STREAM_REVALIDATE_MS || "45000",
    10,
  ),
  // Subtitle languages to probe and expose to players ("vi,en" | "*").
  // Restricting the list also shrinks the caption-cache probe on each
  // fresh scrape (one request per language).
  SUBTITLE_LANGUAGES: parseSubtitleLanguages(),
  // Wyzie fallback (L2): consulted when the vdrk caption cache has no
  // subtitles for a title. Returns direct SRT links — no key on the file
  // URLs themselves, only on the search call. Empty key disables L2.
  WYZIE_API_KEY: process.env.WYZIE_API_KEY || "",
  // Auto-calibrate Wyzie subtitle tracks against an embedded HLS subtitle
  // rendition from the same master (cue-onset alignment → linear scale+offset,
  // then rewritten cue timings at serve time). Wyzie SRTs are synced to an
  // arbitrary release of the movie — some are offset, some drift (fps
  // mismatch). "false" serves Wyzie tracks untouched.
  SUBTITLE_AUTO_SYNC: process.env.SUBTITLE_AUTO_SYNC !== "false",
  // Search window in seconds (each direction) for the coarse onset-density
  // alignment — must cover stream-cut differences (pre-roll/recap trims)
  // without making the correlation scan quadratic in movie length.
  // The `|| 120` catches non-numeric values: parseInt yields NaN there and
  // NaN would silently disable every alignment downstream.
  SUBTITLE_SYNC_WINDOW_S:
    parseInt(process.env.SUBTITLE_SYNC_WINDOW_S || "120", 10) || 120,
};
