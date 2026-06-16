# strix

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D1.0.0-blue?logo=bun)](https://bun.sh)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-green?logo=playwright)](https://playwright.dev)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://www.docker.com)

A tiny, high-performance Bun + Elysia + Playwright microservice designed to do exactly one thing:
**given a video page URL, bypass bot-detection, extract its raw `.m3u8` (HLS) or video (`.mp4`/`.mkv`/etc.) stream URL, and either redirect or proxy the stream directly to the client.**

It is perfect for video streaming applications, IPTV players, and web scrapers that need to resolve protected or short-lived streaming links.

---

## Key Features

- **Anti-Bot Stealth**: Injects advanced anti-fingerprinting overrides (masking `navigator.webdriver`, setting custom user-agent, mocking `userAgentData`, permissions API, plugins, and languages) to bypass sophisticated headless-detection scripts (e.g. on sites like `dlhd.pk`).
- **Interactive Player Clicker**: Auto-detects and triggers play buttons inside frames/iframes to trigger underlying video streams.
- **Smart Cache Resolution**: Caches extracted URLs for 50 minutes (TTL) to save browser resources, with an automatic cache invalidation and retry fallback.
- **Redirect or Proxy Modes**:
  - **Redirect mode**: Returns a HTTP `302` redirect to the raw stream URL.
  - **Proxy mode**: Acts as an intermediary proxy, streaming the video data back to client. Handles Range requests/headers for seamless video seeking on `.mp4`/`.mkv` streams.
- **Docker Ready**: Self-contained multi-stage Docker configuration bundling Bun, Playwright Chromium, and all system libraries.

---

## API Endpoints

### `GET /`
Health check endpoint. Returns `strix`.

---

### `GET /scrape-stream` & `GET /scrape-stream/:filename`
Visits the page in a stealthy headless browser, waits for media requests, and extracts the stream URL.

The variant route with `:filename` is extremely useful for players (e.g. IPTV players or Apple TV/iOS players) that require a specific file extension (like `.m3u8` or `.mp4`) at the end of the URL path to work correctly.

**Query Parameters:**
- `url` (required) — The URL of the video hosting page to scrape.
- `proxy` (optional) — If set to `true` or `1`, the service acts as a streaming proxy instead of redirecting the client to the CDN URL.

#### Mode 1: Redirect Mode (`proxy` is false/omitted)
Returns a HTTP `302 Redirect` pointing directly to the resolved stream.
```http
GET /scrape-stream?url=https://example.com/video-page
```

#### Mode 2: Proxy Mode (`proxy=true`)
Streams the target video data directly from the upstream server to the client. This is helpful if the target CDN restricts access by IP address or custom headers.
```http
GET /scrape-stream/playlist.m3u8?url=https://example.com/video-page&proxy=true
```

In proxy mode:
- **Seek Support**: Range-related headers (`Range`, `Content-Range`, `Accept-Ranges`, `Content-Length`) are fully forwarded to support seeking in video players (e.g., MP4/MKV).
- **Auto-Retry**: If the upstream server rejects the proxy request (e.g., returns `403` or `502` due to an expired CDN token), the service automatically invalidates the cache, performs a fresh scrape, and retries the connection once.

#### Error Responses
- `400 Bad Request` — Missing `url` parameter.
- `404 Not Found` — No playable video source or `.m3u8` playlist was found on the page.
- `504 Gateway Timeout` — Upstream proxy connection timed out.
- `500 Internal Server Error` — Scraper browser crash or unexpected system error.

---

## Setup & Local Development

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/strix.git
   cd strix
   ```
2. Install dependencies:
   ```bash
   bun install
   ```
3. Install the Playwright Chromium browser binary:
   ```bash
   npx playwright install chromium
   ```
4. Copy the environment template and configure:
   ```bash
   cp .env.example .env
   ```

### Running

To start the server in watch mode:
```bash
bun run dev
```
By default, the server will start on `http://localhost:5005`.

---

## Configuration (`.env`)

You can customize the application behavior using the following environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `5005` | The port on which the service will run. |
| `CHROME_PATH` | *empty* | Path to a real, installed Chrome binary (falls back to Playwright's Chromium if empty). |
| `USER_DATA_DIR` | `./user_data` | Directory where browser session profile cookies and cache are stored. |
| `SCRAPER_TIMEOUT` | `15000` | Timeout in milliseconds for navigation and page loading. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` | Timeout in milliseconds when waiting for the upstream proxy connection. |

### Cookie & Authentication Injection (`auth.json`)
If the target website requires specific authentication cookies or local storage states, copy the `auth.json.example` template to `auth.json` and populate it:
```bash
cp auth.json.example auth.json
```
The browser will automatically load these cookies and local storage variables on initialization.

#### How to Export Session Data from Chrome
You can easily export your active session's cookies and local storage directly from your browser console:

1. Log in to the target website on Google Chrome.
2. Open Developer Tools (`F12` or `Cmd + Option + I` on macOS) and click the **Console** tab.
3. Open the file `scripts/export-auth.js` in this project, copy its entire contents, paste it into the browser console, and press **Enter**.
4. The JSON formatted session state is automatically copied to your clipboard. Simply open `auth.json` in your project root and paste (`Ctrl+V` / `Cmd+V`) the contents there.

> ⚠️ **Note on Secure Cookies (HttpOnly)**: JavaScript cannot read cookies marked with the `HttpOnly` flag. If the target website relies on `HttpOnly` cookies for authentication, please use an extension like **Cookie-Editor** to export all cookies as JSON, and copy them directly into the `"cookies"` array in your `auth.json`.

---

## Production Deployment with Docker

The project contains a `Dockerfile` and `docker-compose.yml` to bundle the Bun runtime, headless Playwright Chromium, and Debian-based dependencies into a single image.

### Quick Start
```bash
# Prepare env variables
cp .env.example .env

# Build and run containers in background
docker compose up --build -d

# Check service logs
docker compose logs -f app
```

### Docker Volume Persistence
A named Docker volume `user_data` is configured to persist browser profiles, cookie state, and cached resources across container restarts.

### Useful Commands
- **Rebuild image**: `docker compose build`
- **Stop containers**: `docker compose down`
- **Clean start (deletes cache volume)**: `docker compose down -v && docker compose up --build -d`

---

## Contributing

Contributions are welcome! Please check out [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to run tests, write code, and submit pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
