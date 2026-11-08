# strix

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D1.0.0-blue?logo=bun)](https://bun.sh)
[![Patchright](https://img.shields.io/badge/Patchright-Undetected%20Chromium-green?logo=playwright)](https://github.com/kaliiiiiiiiii/patchright)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://www.docker.com)

**strix** is a high-performance, stealth video stream resolver and proxy built with **Bun**, **Elysia**, and **Patchright**.

Give it any protected live sports streaming link or video embed page, and Strix will bypass anti-bot defenses, intercept token-gated `.m3u8` playlists or video sources, and deliver a clean, playable stream directly to your IPTV player or backend service.

---

## ⚡ Quick Start (30 Seconds)

### Option 1: Docker Compose (Recommended)
```bash
git clone https://github.com/your-username/strix.git
cd strix
docker compose up -d --build
```
Your service is now running at `http://localhost:5005`.

### Option 2: Docker CLI
```bash
docker run -d \
  --name strix \
  --init \
  -p 5005:5005 \
  -v strix_user_data:/app/user_data \
  ghcr.io/your-username/strix:latest
```

### Option 3: Local Bun
```bash
bun install
bun run dev
```

---

## 🎯 Which Mode Should You Use? (Cheat Sheet)

| Your Use Case | Recommended Endpoint / URL | What Strix Does |
| :--- | :--- | :--- |
| **🎬 VOD & Movies**<br>*(VLC, Infuse, Safari, Kodi)* | `http://localhost:5005/scrape-video?url=<MOVIE_PAGE>` | Resolves movie stream: For **HLS (.m3u8)**, generates an RFC 8216 HLS Master Playlist bundling video & subtitles. For direct containers (**MKV / MP4**), redirects 302 directly to the playable video stream (or `/proxy-chunk` when `proxy=true`). |
| **📺 IPTV Players / Smart TV**<br>*(TiviMate, VLC, Kodi, Apple TV)* | `http://localhost:5005/scrape-stream/live.m3u8?url=<TARGET_PAGE>&proxy=true&proxy_segments=true` | Proxies both playlist and segments. Automatically bypasses CDN hotlink referer checks and unpacks disguised image chunks into standard MPEG-TS. |
| **🤖 Backend API Integration**<br>*(Microservices, Aggregators)* | `http://localhost:5005/scrape-stream?url=<TARGET_PAGE>&format=json` (Live)<br>`http://localhost:5005/scrape-video?url=<MOVIE_PAGE>&json=1` (VOD) | Scrapes the page and returns clean JSON containing the stream URL, subtitle tracks, and required dynamic headers (`Referer`, `User-Agent`). |
| **⚡ Fast Direct Playback**<br>*(Direct Client)* | `http://localhost:5005/scrape-stream?url=<TARGET_PAGE>` | Resolves the stream and issues an immediate `HTTP 302 Found` redirect to the upstream URL. |

---

## 🔌 API Reference

### 1. `GET /scrape-stream` & `GET /scrape-stream/:filename`
Visits the target page, intercepts media requests, and resolves the stream.

> **Tip for IPTV:** Using `/scrape-stream/live.m3u8?...` adds an `.m3u8` extension to the path, which is required by some strict IPTV clients (TiviMate, Apple HLS Player).

#### Query Parameters
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | **Required** | The target video or embed page URL to scrape. |
| `proxy` | `boolean` | `false` | When `true` or `1`, pipes the stream through Strix with upstream hotlink headers forwarded. |
| `proxy_segments` | `boolean` | `false` | When `true` (with `proxy=true`), rewrites all chunk URLs inside `.m3u8` to route via `/proxy-chunk`. **Recommended for protected CDNs (e.g. TikTok CDN, Cinevid, zlive).** |
| `sub` | `boolean` | `auto` | When `true` or `1`, resolves HLS Master Playlists to the highest quality sub-playlist. Auto-enabled when `proxy=true`. |
| `unwrap` | `boolean` | `false` | Explicitly forces unwrapping of disguised image chunks (`.png`/`.webp`). (Auto-detected if segments are non-standard media). |
| `format` | `string` | `""` | Set to `json` to return JSON metadata instead of redirecting or streaming. |

---

### 2. `GET /scrape-video` & `GET /scrape-video/:filename`
Visits a VOD / movie page and resolves the video stream:
- **HLS Streams (`.m3u8`)**: Automatically bundles all multilingual subtitles (`.vtt`, `.srt`) into a standard RFC 8216 HLS Master Playlist.
- **Direct Video Containers (`.mkv`, `.mp4`)**: Issues an immediate `HTTP 302 Found` redirect to the playable stream (or routes via `/proxy-chunk` when `proxy=true` is requested), allowing native players to stream and seek with full byte-range support.

#### Query Parameters
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | **Required** | The target movie or video embed page URL. |
| `proxy` | `boolean` | `false` | When `true`, routes direct MKV/MP4 stream through `/proxy-chunk` with upstream hotlink headers. |
| `format` / `json` | `string` / `boolean` | `""` | Set to `json` or `json=1` to return structured JSON containing video stream info, subtitle track array, and direct stream URLs. |

---

### 3. `GET /proxy-sub`
Proxies external subtitle tracks (`.vtt`, `.srt`), automatically converts SubRip (`.srt`) to WebVTT (`.vtt`), normalizes timestamps and styling, and returns subtitles with `Access-Control-Allow-Origin: *` headers for browser players and video apps.

---

### 4. `GET /proxy-chunk`
Internal endpoint used automatically when `proxy_segments=true` is enabled. Proxies individual media chunks (`.ts`, `.m4s`, `.mp4`) and unwraps disguised image segments on the fly.

---

### 5. `GET /`
Health check endpoint. Returns `strix`.

---

## 💡 Usage Examples

### 1. Stream Protected Live TV to VLC or TiviMate
Paste this URL directly into your player's stream address field:
```http
http://localhost:5005/scrape-stream/live.m3u8?proxy=true&proxy_segments=true&url=https%3A%2F%2Fzlive.st%2Fembed%2Fauto-dazn-f1
```
*Strix launches a stealth browser tab, captures the master playlist, rewrites media segments, unwraps TikTok CDN image chunks, and streams real-time MPEG-TS to your player.*

### 2. Query Stream URL & Headers from Your Backend
```bash
curl -s "http://localhost:5005/scrape-stream?url=https://ppv.st/live/ufc-fight-night-31456&format=json"
```
**Response (200 OK):**
```json
{
  "url": "https://cdn.example.com/secure/.../tracks-v1a1/mono.ts.m3u8",
  "headers": {
    "Referer": "https://taifood-blog.asia/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
  }
}
```

---

## 🛡️ Architecture & Under the Hood

### 🥷 Anti-Bot Stealth Engine
- **Patchright Undetected Driver**: Patched at the native binary level to eliminate all automation traces (bypasses Cloudflare, Kasada, and DataDome).
- **Natural Same-Origin Policy (SOP)**: Runs without dangerous flags like `--disable-web-security` to pass active cross-origin security probes and honeypot traps.
- **Origin-Matched Synthetic Embed Loader**: Embed links (`/embed/`, `/player/`) are loaded inside a virtual origin-matched `<iframe>` (`/strix-embed-loader.html`), satisfying `Sec-Fetch-Dest: iframe` and CSP `frame-ancestors`.
- **Interactive Autoplay Trigger**: Automatically detects and triggers play buttons across shadow DOMs and video libraries (JWPlayer, Video.js, Clappr).

### 🧩 Disguised Chunk Unwrapping (`cvUnwrap`)
Many modern streaming providers disguise video segments as image files (`.png` / `.webp`) to evade ad-blockers and CDN hotlink rules:
- **Zero-Copy Unwrapping**: Slices MPEG-TS directly from byte pointers in `< 0.01 ms` with zero memory re-allocation.
- **Supported Encodings**:
  - PNG IDAT raw streams & compressed metadata `iTXt` (Base64-encoded TS).
  - PNG pixel steganography (`TIKTIKPX` defiltered IDAT).
  - WebP RIFF/EXIF chunks.
  - Raw marker wrappers (`TIKTIKRAW` & `TIKTIKTSGZ`).

### 🔄 Resiliency & Auto-Recovery
- **SingleFlight Deduplication**: When 50 clients request the same live stream at once, Strix launches **only 1 browser tab**; all callers share the resolved result.
- **Auto-Recovery on Stale Tokens**: When upstream returns `401`, `403`, or `404`, Strix invalidates the cached URL, re-scrapes a fresh token, and retries seamlessly.
- **Edge Transcoder Warming Retries**: Automatically handles edge server warming periods (HTTP 404/503 "warming") with exponential backoff.
- **Instant Client Abort Propagation**: When a viewer switches channels, `AbortSignal` immediately cancels upstream fetch jobs and frees Chromium slots.

### 🧠 Production Concurrency & Memory Guard
- **Strict Concurrency Semaphore**: Caps concurrent active browser tabs (`MAX_CONCURRENT_SCRAPES = 3` by default) to keep VPS RAM usage low.
- **Zero Video Decoding in RAM**: Video and audio chunk requests (`.ts`, `.m4s`, `.mp4`) are aborted inside Chromium so the browser never wastes CPU/RAM decoding 1080p video.
- **Proactive Context Recycling**: Chromium contexts are automatically recycled after `MAX_BROWSER_USES` operations along with `Bun.gc()` sweeps to prevent V8 heap fragmentation.

---

## ⚙️ Configuration (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `5005` | HTTP server port. |
| `MAX_CONCURRENT_SCRAPES` | `3` | Maximum concurrent browser tabs allowed at any given time. |
| `SCRAPER_TIMEOUT` | `20000` | Browser scrape timeout in milliseconds. |
| `CACHE_MAX_ITEMS` | `1000` | Maximum number of stream URLs stored in memory cache. |
| `VOD_CACHE_TTL_MS` | `21600000` (6 hrs) | Cache TTL in milliseconds for resolved VOD movie streams and playlists. |
| `SUBTITLE_CACHE_TTL_MS` | `21600000` (6 hrs) | Cache TTL in milliseconds for converted WebVTT subtitles. |
| `SUBTITLE_AUTO_SYNC` | `true` | Auto-align Wyzie subtitle tracks against an in-sync reference (embedded source rendition, else the vidnest caption cache) via cue-onset alignment; fixes constant offset and fps drift. `false` serves Wyzie tracks untouched. |
| `SUBTITLE_SYNC_WINDOW_S` | `120` | Search window in seconds (each direction) for the subtitle alignment scan. |
| `MAX_BROWSER_USES` | `30` | Number of scrapes before recycling the Chromium context. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` | Upstream proxy timeout in milliseconds. |
| `HEADLESS` | `true` | Set to `false` to show browser UI (useful for debugging). |
| `PROXY_SERVER` | *empty* | Optional HTTP/SOCKS5 proxy for browser requests (e.g. `http://user:pass@host:port`). |
| `CHROME_PATH` | *empty* | Path to external Chrome/Chromium executable (defaults to bundled Patchright). |
| `USER_DATA_DIR` | `./user_data` | Directory for persistent cookies and browser storage. |

---

## 🍪 Cookie & Authentication Injection (`auth/`)

For sites requiring authenticated accounts, place Playwright storage state files inside `auth/`:

```bash
mkdir -p auth
cp auth/auth.example.json auth/example.com.json
```
On boot, Strix automatically registers cookies and local storage items matching the target domain.

---

## 🧪 Testing

```bash
# Run full unit and integration test suite
bun test

# Run TypeScript type check
bun run --bun tsc --noEmit
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
