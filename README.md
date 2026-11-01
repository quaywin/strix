# strix

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D1.0.0-blue?logo=bun)](https://bun.sh)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-green?logo=playwright)](https://playwright.dev)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://www.docker.com)

A high-performance Bun + Elysia + Playwright microservice designed to do one thing exceptionally well:
**given a video hosting or sports streaming page URL, bypass anti-bot and hotlink protections, extract the raw `.m3u8` (HLS) or video (`.mp4`/`.mkv`/etc.) stream URL alongside dynamic request headers, and either return JSON metadata, redirect, or proxy the stream directly to client players.**

Built for IPTV systems, video aggregators, and streaming apps that need reliable resolution of protected, token-gated, or short-lived video streams.

---

## Key Features

- **Anti-Bot Stealth Engine**:
  - Neutralizes `navigator.webdriver`, sandbox detection tricks (`sandDetect`), and overrides `userAgentData`, permissions API, plugins, and language lists.
  - Mimics natural visibility states (`document.visibilityState = 'visible'`) and disables autoplay restrictions (`--autoplay-policy=no-user-gesture-required`) so players initialize immediately without human interaction.
- **Interactive Player Clicker**:
  - Automatically searches, polls, and triggers play buttons across frames and shadow DOMs (JWPlayer, Video.js, Clappr, custom sports player buttons).
- **Synthetic Iframe Container**:
  - Seamlessly handles both host pages (`ppv.st/live/...`) and direct embed links (`taifood-blog.asia/embed/...`). Embed URLs are wrapped in a synthetic `<iframe>` container to bypass anti-direct-access checks (`window.top !== window.self`).
- **Dynamic Header Forwarding**:
  - Captures dynamic request headers (`Referer`, `User-Agent`) during scraping and forwards them when proxying streams, bypassing upstream CDN 403 Forbidden hotlink blocks.
- **TLS Fingerprint Bypass (`smartFetch`)**:
  - Progressive enhancement: calls native Bun `fetch()` first, and automatically falls back to native system `curl` when upstream CDN firewalls (such as "Iron Dome" / JA3 TLS ClientHello fingerprinting) block automated runtimes with 403 Forbidden.
- **Sub-Playlist & Variant Auto-Resolution (`sub=1`)**:
  - Resolves HLS Master Playlists (`index.m3u8`) to the highest quality variant stream (`mono.ts.m3u8`), converting relative paths into absolute segment URLs for direct client playback.
- **Production-Grade Concurrency & Memory Guard**:
  - **In-flight Deduplication (SingleFlight)**: Coalesces concurrent requests for the exact same stream into a single browser tab, completely preventing cache stampedes / thundering herd CPU spikes.
  - **Concurrency Limiter (Semaphore)**: Caps simultaneous browser tabs (`MAX_CONCURRENT_SCRAPES`) to safeguard low-memory VPS instances from OOM crashes.
  - **Browser Context Auto-Recycle**: Automatically closes and renews the Chromium context after a configurable number of uses (`MAX_BROWSER_USES`) to eliminate long-term V8 memory fragmentation.
  - **Bounded Memory Cache**: In-memory `TtlCache` with maximum item ceiling (`CACHE_MAX_ITEMS`) and FIFO eviction.

---

## API Endpoints

### `GET /`
Health check endpoint. Returns `strix`.

---

### `GET /scrape-stream` & `GET /scrape-stream/:filename`
Visits the target page, intercepts media requests, and resolves the stream.

The variant route with `:filename` (e.g. `/scrape-stream/live.m3u8?url=...`) provides compatibility for IPTV players and media centers (like Apple TV, Kodi, VLC, or TiviMate) that require a specific file extension at the end of the URL path.

#### Query Parameters:
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | string | *required* | The URL of the video page or embed player to scrape. |
| `proxy` | boolean | `false` | When `true` or `1`, Strix acts as a streaming proxy, piping video chunks directly to the client while forwarding dynamic headers. |
| `sub` | boolean | `auto` | When `true` or `1`, resolves HLS Master Playlists to sub-playlist variants (highest resolution/bandwidth). Defaults to `true` when `proxy=1`. |
| `format` | string | `""` | Set to `json` (or `json=1`) to return structured JSON containing both the stream URL and required dynamic request headers. |

---

### Usage Examples

#### 1. JSON Inspection Mode (`format=json`)
Retrieve the resolved stream URL and the dynamic headers needed to play it directly:
```http
GET /scrape-stream?url=https://ppv.st/live/ufc-fight-night-moicano-vs-nolan-31456&format=json
```

**Response (200 OK):**
```json
{
  "url": "https://netanyahu.indianservers.st/secure/.../ufc/tracks-v1a1/mono.ts.m3u8",
  "headers": {
    "Referer": "https://taifood-blog.asia/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
  }
}
```

#### 2. Direct Redirect Mode (`proxy=false`, default)
Returns a standard HTTP `302 Found` redirect pointing directly to the resolved stream:
```http
GET /scrape-stream?url=https://example.com/video-page
```

#### 3. Proxy Streaming Mode (`proxy=true`)
Pipes the video stream through Strix. Upstream hotlink headers (`Referer`, `User-Agent`) and HTTP `Range` headers are forwarded automatically:
```http
GET /scrape-stream/playlist.m3u8?url=https://ppv.st/live/ufc-fight-night-moicano-vs-nolan-31456&proxy=true
```

- **Seek Support**: HTTP Range headers (`Range`, `Content-Range`, `Accept-Ranges`, `Content-Length`) are fully preserved for `.mp4`/`.mkv` seeking.
- **Auto-Retry**: If upstream rejects a proxy request (e.g. 403 / 502 due to an expired token), Strix automatically invalidates the cache, performs a fresh scrape, and retries once.

#### Error Responses
- `400 Bad Request` — Missing `url` parameter.
- `404 Not Found` — No playable video source or `.m3u8` playlist was found on the page.
- `502 Bad Gateway` — Upstream server returned an error during proxying.
- `504 Gateway Timeout` — Upstream connection timed out.
- `500 Internal Server Error` — Scraper browser crash or unexpected system error.

---

## Configuration (`.env`)

You can customize the application behavior using environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `5005` | Port on which the HTTP server listens. |
| `CHROME_PATH` | *empty* | Path to an external Chromium/Chrome executable (defaults to Playwright bundled browser). |
| `USER_DATA_DIR` | `./user_data` | Directory for persistent browser profile, cookies, and local storage cache. |
| `HEADLESS` | `true` | Set to `false` to display the Chromium browser window during scraping (useful for debugging). |
| `PROXY_SERVER` | *empty* | Optional HTTP/SOCKS5 proxy for Playwright browser requests (e.g. `http://user:pass@host:port`). |
| `SCRAPER_TIMEOUT` | `20000` | Browser navigation and page loading timeout (in ms). |
| `MAX_CONCURRENT_SCRAPES` | `3` | Maximum number of concurrent browser tabs allowed at any time. |
| `CACHE_MAX_ITEMS` | `1000` | Maximum number of stream URLs stored in memory before FIFO eviction. |
| `MAX_BROWSER_USES` | `300` | Number of scrape operations before automatically recycling the browser context. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` | Maximum wait timeout when proxying upstream data chunks (in ms). |

---

## Cookie & Authentication Injection (`auth/`)

If a target website requires authentication cookies or local storage states, manage them as **per-domain files** under the `auth/` directory:

```bash
mkdir -p auth
cp auth/auth.example.json auth/example.com.json   # edit with domain credentials
```

On startup, Strix loads every `auth/*.json` file (skipping `*.example.json`) and registers its cookies and local storage to the shared browser context.

---

## Production Deployment with Docker

Strix includes a hardened `Dockerfile` and `docker-compose.yml` optimized for production deployment on both AMD64 and ARM64 servers.

### 1. Using Docker Compose (Recommended)
```bash
# Clone the repository
git clone https://github.com/your-username/strix.git
cd strix

# (Optional) Copy .env if you wish to customize port or concurrency
cp .env.example .env

# Build and start in background
docker compose up --build -d

# Check logs
docker compose logs -f app
```

### 2. Standalone Docker Run
```bash
docker build -t strix:latest .
docker run -d \
  --name strix \
  --init \
  -p 5005:5005 \
  -v strix_user_data:/app/user_data \
  -v $(pwd)/auth:/app/auth:ro \
  strix:latest
```

---

## Local Development & Testing

```bash
# Install dependencies
bun install

# Run TypeScript type check
bun run --bun tsc --noEmit

# Run unit tests
bun test

# Start development server with hot-reload
bun run dev
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
