import { PlaywrightBrowserProvider } from "../BrowserProvider";
import { logger } from "../../logger";
import { smartFetch } from "../../utils/http";

export interface ExtractedStream {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * cinejoy.pk runs its own pre-transcoded HLS catalog behind a per-request
 * sealed resolve (POST /g, body sealed by crush.wasm) — so the URL can only
 * be obtained by letting their own client JS run. All that is needed from
 * the resulting page is the master.m3u8 request the player fires once the
 * resolve lands.
 *
 * Observed CDN hosts (one per "server" from api.wing.st/servers):
 *  - lightspeed.st  (movie default "secret") — requires Origin: cinejoy.pk
 *  - nebula.bright67.online (TV default "Nebula") — no auth at all
 * The URL shape is shared: /hls/{uuid}[/{n}]/master.m3u8 on a non-cinejoy
 * host, so matching is host-agnostic on purpose.
 *
 * Resolve timing (2026-11-11 probes): page load 6-20s dominates; /g →
 * master is consistently 0.4-1.3s. UUIDs outlive CONFIG.CACHE_TTL_MS
 * (≥50min observed), so callers cache the result at VOD TTL.
 */
const CINEJOY_ORIGIN = "https://cinejoy.pk";
const RESOLVE_TIMEOUT_MS = 50_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const MAX_ERROR_RETRIES = 4;
// cinejoy's page errors out when its client-side TMDB fetches hit
// reset-prone networks; retries must give the metadata round-trip time to
// actually complete before re-evaluating, or they burn out in seconds.
const ERROR_RETRY_COOLDOWN_MS = 5000;

/**
 * Minimal TMDB payload that satisfies cinejoy's watch page. The page fetches
 * real metadata before mounting its player, but the actual source resolve
 * (POST /g + master.m3u8) derives everything from the URL — so intercepting
 * TMDB removes the provider's only flaky dependency (api.themoviedb.org is
 * SNI-reset-prone on some networks) AND speeds the resolve up (measured
 * 6.5-20s real-metadata vs 3.6-4.7s stubbed).
 */
function tmdbStub(id: number, type: "movie" | "tv"): Record<string, unknown> {
  const isTv = type === "tv";
  return {
    id,
    ...(isTv
      ? { name: "strix", original_name: "strix" }
      : { title: "strix", original_title: "strix" }),
    overview: "",
    tagline: "",
    runtime: 110,
    episode_run_time: [22],
    release_date: "2000-01-01",
    first_air_date: "2000-01-01",
    status: "Released",
    adult: false,
    vote_average: 7,
    poster_path: null,
    backdrop_path: null,
    still_path: null,
    genres: [],
    images: { backdrops: [], posters: [], logos: [] },
    credits: { cast: [], crew: [] },
    videos: { results: [] },
    external_ids: {},
    release_dates: { results: [] },
    "watch/providers": { results: {} },
    content_ratings: { results: [] },
    seasons: [
      {
        season_number: 1,
        name: "Season 1",
        episodes: [
          {
            episode_number: 1,
            name: "Episode 1",
            overview: "",
            runtime: 22,
            air_date: "2000-01-01",
            still_path: null,
            vote_average: 7,
          },
        ],
      },
    ],
    number_of_seasons: 1,
    recommendations: { results: [] },
    similar: { results: [] },
  };
}
const MASTER_RE =
  /^https:\/\/(?!cinejoy)[a-z0-9.-]+\/hls\/[0-9a-f-]+(?:\/\d+)?\/master\.m3u8/i;

// Shared provider singleton: launchPersistentContext locks its profile dir
// per-process, so the extractor must join ScraperEngine's context instead of
// launching a second Chromium on the same userDataDir.
const provider = PlaywrightBrowserProvider.shared;

export class CinejoyExtractor {
  /**
   * Check if the given URL is a cinejoy watch page (movie or tv episode).
   */
  static canHandle(url: string): boolean {
    return /^https?:\/\/(www\.)?cinejoy\.pk\/watch\/(movie|tv)\/\d+(\/\d+)?(\/\d+)?/i.test(
      url,
    );
  }

  /**
   * Resolve the master playlist URL by running the cinejoy watch page in the
   * pooled stealth browser and capturing its player's master.m3u8 request.
   *
   * The master is returned untouched on purpose: its variants are video-only
   * with audio carried as a separate EXT-X-MEDIA rendition group, so
   * resolving to the top variant here would hand players a silent stream.
   * The downstream harvest/rewrite pipeline consumes masters as-is.
   */
  static async extract(
    watchUrl: string,
    signal?: AbortSignal,
  ): Promise<ExtractedStream> {
    const path = new URL(watchUrl).pathname;
    // /watch/movie/{tmdbId} or /watch/tv/{tmdbId}/{season}/{episode}
    const watchMatch = path.match(/^\/watch\/(movie|tv)\/(\d+)/);
    const type = (watchMatch?.[1] as "movie" | "tv") ?? "movie";
    const tmdbId = Number(watchMatch?.[2] ?? 0);

    const context = await provider.acquireContext();
    const page = await context.newPage();
    try {
      // Stub out TMDB for THIS page only (page.route, never context.route —
      // the shared context also runs vidnest pages whose TMDB calls are real).
      await page.route(
        /^https:\/\/api\.themoviedb\.org\//,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(tmdbStub(tmdbId, type)),
          }),
      );

      let masterUrl: string | null = null;
      let resolveMaster: ((url: string) => void) | null = null;
      const masterPromise = new Promise<string>((res) => {
        resolveMaster = res;
      });

      page.on("request", (req) => {
        if (!masterUrl && MASTER_RE.test(req.url())) {
          masterUrl = req.url();
          resolveMaster?.(masterUrl);
        }
      });

      const waitOrMaster = async (maxMs: number): Promise<boolean> => {
        if (masterUrl) return true;
        const timer = page.waitForTimeout(maxMs).then(() => false);
        return Promise.race([
          masterPromise.then(() => true),
          timer,
        ]);
      };

      const t0 = Date.now();
      logger.info(
        `cinejoy: opening ${path} in headless browser`,
        "CinejoyExtractor",
      );
      await page.goto(CINEJOY_ORIGIN + path, {
        timeout: PAGE_LOAD_TIMEOUT_MS,
        waitUntil: "commit",
      });

      let errorRetries = 0;
      let nudge = false;
      while (!masterUrl && Date.now() - t0 < RESOLVE_TIMEOUT_MS) {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        // Yield immediately the moment master.m3u8 arrives, avoiding rigid 2s sleep blocks
        const found = await waitOrMaster(1500);
        if (found || masterUrl) break;

        const st = await page
          .evaluate(() => ({
            // cinejoy's own client-side TMDB fetches fail on reset-prone
            // networks (api.themoviedb.org SNI resets); the SPA then shows
            // "Oops! We couldn't find this" — its Try Again re-runs resolve.
            errState:
              (document.body?.innerText ?? "").includes("couldn't find this"),
            hasVideo: Boolean(document.querySelector("video")),
          }))
          .catch(() => ({ errState: false, hasVideo: false }));

        if (st.errState && errorRetries < MAX_ERROR_RETRIES) {
          errorRetries++;
          logger.info(
            `cinejoy: page error state, retrying (${errorRetries}/${MAX_ERROR_RETRIES})`,
            "CinejoyExtractor",
          );
          await page
            .getByRole("button", { name: "Try Again" })
            .click({ timeout: 3000 })
            .catch(() => {});
          await waitOrMaster(ERROR_RETRY_COOLDOWN_MS);
          continue;
        }

        // Trusted-event play nudge: the player may need one interaction on a
        // fresh profile. Only the video element / viewport center — blind
        // clicking hit nav buttons and navigated away during probing.
        if (!masterUrl && (nudge = !nudge)) {
          await page
            .locator("video")
            .first()
            .click({ timeout: 2000, force: true })
            .catch(() => {});
          if (!masterUrl && !st.hasVideo) {
            await page.mouse.click(640, 360).catch(() => {});
          }
        }
      }

      if (!masterUrl) {
        throw new Error(
          `cinejoy: no master.m3u8 captured within ${Math.round(RESOLVE_TIMEOUT_MS / 1000)}s`,
        );
      }

      logger.info(
        `cinejoy: resolved master in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${masterUrl}`,
        "CinejoyExtractor",
      );
      const headers = {
        // lightspeed.st rejects requests without the site Origin (plain
        // curl → 404 "Removed"); nebula-family hosts ignore headers. Both
        // values match what the page's own player sends.
        origin: CINEJOY_ORIGIN,
        referer: CINEJOY_ORIGIN + path,
      };

      // Capture the master body while we're here: consumers need it for
      // rendition parsing and to classify the stream without a second
      // upstream fetch. Non-fatal — URL-only results still play.
      let body: string | undefined;
      try {
        const timeoutSignal = AbortSignal.timeout(8000);
        const combinedSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        const res = await smartFetch(masterUrl, {
          headers: { ...headers, "accept-encoding": "identity" },
          signal: combinedSignal,
        });
        if (res.ok) {
          body = await res.text();
        }
      } catch (e) {
        logger.warn(
          `cinejoy: master body fetch failed (URL itself resolved fine): ${(e as Error).message}`,
          "CinejoyExtractor",
        );
      }

      return { url: masterUrl, headers, body };
    } finally {
      await page.close().catch(() => {});
      await provider.releaseContext();
    }
  }
}
