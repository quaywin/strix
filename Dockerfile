# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Base image: the Debian variant of the official Bun image.
# Playwright requires many system shared libraries (libnss3, libatk1.0-0,
# libgbm1, libasound2, fonts-liberation, ...) that are painful to install
# on Alpine/distroless. `bunx playwright install --with-deps` only knows
# how to apt-get them on Debian/Ubuntu.
# Tag follows the 1.x line; pin to e.g. `1.3.14-debian` for reproducibility.
# ---------------------------------------------------------------------------
FROM oven/bun:1-debian

WORKDIR /app

# Playwright reads this to decide where to put its browser binaries.
# Pinning the path keeps it predictable across users/UIDs.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ---------------------------------------------------------------------------
# Non-root user. The app already launches Chrome with `--no-sandbox`
# (see src/scraper/BrowserProvider.ts), so a non-root runtime is safe and
# recommended.
# ---------------------------------------------------------------------------
RUN groupadd --system --gid 1001 appuser \
 && useradd  --system --uid 1001 --gid appuser \
             --create-home --home-dir /home/appuser --shell /usr/sbin/nologin appuser

# ---------------------------------------------------------------------------
# 1. Install JS dependencies first (better layer caching).
#    `--frozen-lockfile` fails the build if bun.lock is out of sync — this
#    catches "forgot to commit the lockfile" mistakes early.
# ---------------------------------------------------------------------------
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2. Install Chromium + its apt dependencies via Playwright.
#    Placed AFTER `bun install` so a Playwright version bump in package.json
#    invalidates this layer and re-downloads the matching browser build.
# ---------------------------------------------------------------------------
RUN bunx playwright install --with-deps chromium

# ---------------------------------------------------------------------------
# 3. Copy application source.
# ---------------------------------------------------------------------------
COPY tsconfig.json index.ts ./
COPY src ./src

# Pre-create the persistent profile directory and hand ownership to appuser.
# When a named volume is first mounted on /app/user_data, Docker copies the
# directory's contents AND ownership from the image, so the non-root process
# can write to it.
RUN mkdir -p /app/user_data && chown -R appuser:appuser /app

USER appuser

# ---------------------------------------------------------------------------
# 4. Runtime configuration.
# ---------------------------------------------------------------------------
ENV PORT=3001 \
    NODE_ENV=production

EXPOSE 3001

# Healthcheck: hit the root endpoint. Uses Bun directly (no curl/wget needed
# in the image). Reads PORT from env so it stays correct if overridden.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||'3001')+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The Elysia server reads CONFIG.PORT at startup and listens on that port.
CMD ["bun", "run", "index.ts"]
