import "dotenv/config";

export const CONFIG = {
  PORT: parseInt(process.env.PORT || "5005", 10),
  CHROME_PATH: process.env.CHROME_PATH || "",
  USER_DATA_DIR: process.env.USER_DATA_DIR || "./user_data",
  PROXY_SERVER: process.env.PROXY_SERVER || "", // e.g. "http://123.45.67.89:8080" hoặc "http://user:pass@host:port"
  SCRAPER: {
    DEFAULT_TIMEOUT: parseInt(process.env.SCRAPER_TIMEOUT || "15000", 10),
  },
  // 50 minutes — signed m3u8 URLs usually carry short-lived expiry tokens,
  // so we keep the cache short to avoid serving stale links.
  CACHE_TTL_MS: 50 * 60 * 1000,
  // Hard cap on how long proxy mode waits for the upstream stream URL to
  // start responding. Prevents a hung upstream from pinning a client
  // connection forever.
  PROXY_UPSTREAM_TIMEOUT_MS: parseInt(
    process.env.PROXY_UPSTREAM_TIMEOUT_MS || "30000",
    10,
  ),
};
