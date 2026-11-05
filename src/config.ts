import "dotenv/config";

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
  // Path to ffmpeg binary (defaults to system PATH lookup or common macOS/Linux locations)
  FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
};
