# scrape-stream-api

A tiny Bun + Elysia + Playwright service that does exactly one thing:
**given a video page URL, return its raw `.m3u8` (or `.mp4`/`.mkv`) stream URL.**

## Endpoints

### `GET /`

Health check. Returns the string `scrape-stream-api`.

### `GET /scrape-stream?url=<page-url>`

Visits the page in a stealthy headless Chrome, waits for media requests, and
returns the best stream URL it can find.

**Query params:**
- `url` (required) — the video page URL to scrape

**200 response:**
```json
{ "url": "https://cdn.example.com/.../index.m3u8?...", "source": "<input url>" }
```

**Error responses:**
- `400` — missing `url` parameter
- `500` — scrape failed (site down, no video source, timeout, etc.)
  ```json
  { "error": "<message>" }
  ```

The extracted URL is cached for 5 minutes (configurable via code) because most
`.m3u8` links carry short-lived signed tokens.

## Setup

```bash
bun install
npx playwright install chromium   # if not already installed elsewhere
cp .env.example .env              # then edit if needed
bun run dev
```

## Configuration (`.env`)

| Variable        | Default     | Description                                                  |
| --------------- | ----------- | ----------------------------------------------------------- |
| `PORT`          | `5005`      | Server port                                                 |
| `CHROME_PATH`   | _empty_     | Path to a real Chrome binary. Empty = Playwright Chromium.  |
| `USER_DATA_DIR` | `./user_data` | Persistent browser profile dir. Shared across requests.    |
| `SCRAPER_TIMEOUT` | `15000`   | Per-page navigation/scrape timeout, in ms.                  |

## Deploy with Docker

The repo ships with a `Dockerfile` and `docker-compose.yml` that bundle the
Bun runtime, Playwright Chromium, and all required system libraries into a
single image (~1.5 GB).

### Quick start

```bash
cp .env.example .env               # one-time, adjust ports/timeouts if needed
docker compose up --build -d
docker compose logs -f app
```

The service will be available at `http://<host>:5005/`.

### What the image does

- Based on `oven/bun:1-debian` (Debian variant — required for Playwright
  system deps like `libnss3`, `libatk1.0-0`, `libgbm1`).
- Installs Chromium via `bunx playwright install --with-deps chromium`.
- Runs as a non-root user (`appuser`, uid 1001). Safe because the app already
  launches Chrome with `--no-sandbox`.
- Persists the Chrome profile to a named Docker volume (`user_data`) so
  cookies / cache survive container restarts.
- Built-in healthcheck pings `GET /` every 30s.

### Useful commands

```bash
docker compose build               # rebuild image after dependency changes
docker compose up -d               # start in background
docker compose logs -f app         # tail logs
docker compose restart app         # restart without rebuilding
docker compose down                # stop and remove containers (keeps volume)
docker compose down -v             # also delete the user_data volume
```

### Changing the exposed port

The compose file reads `PORT` (and optional `HOST_PORT`) from `.env`:

```bash
# .env
PORT=8080                          # container listens on 8080
HOST_PORT=80                       # optional: publish on host port 80 -> 8080
```

### Notes

- **Build is slow the first time** (~5-10 min on a small VPS) because
  Chromium + apt deps must be downloaded. Subsequent rebuilds hit the layer
  cache and finish in seconds unless `package.json` changes.
- **Image size** is ~1.5 GB. If you deploy on a PaaS with size limits,
  consider pushing the image to a registry (ghcr.io / Docker Hub) rather
  than building in place.
- **Memory**: give the container at least 512 MB (1 GB recommended) since
  Chromium is memory-hungry.

## Stealth

`PlaywrightBrowserProvider` injects an init script that masks common
headless-detection signals (`navigator.webdriver`, `userAgentData.brands`,
`plugins`, `languages`, `chrome.runtime`) and sets a realistic Chrome
user-agent. This is necessary for sites like `dlhd.pk` that detect
`HeadlessChrome` and serve ad networks instead of the real player.

If a target site still detects the bot, options to explore:
- run with a real Chrome profile (`USER_DATA_DIR` pointing at an existing one)
- use `playwright-extra` + `puppeteer-extra-plugin-stealth`
- headed mode via Xvfb on Linux (the Docker image is headless-only)
