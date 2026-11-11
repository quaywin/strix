/**
 * Cinejoy provider probe: headless resolve + timing + proxy-ability check.
 *
 * Verifies the three claims from the 2026-11-11 recon:
 *  1. Headless patchright resolves a source without bot-blocking
 *  2. Resolve time is competitive (single page -> click -> lightspeed.st m3u8)
 *  3. The CDN only needs a static `Origin: https://cinejoy.pk` header
 *     (so strix's existing /playlist -> /proxy-chunk pipeline can serve it)
 *
 * Usage: bun scripts/diag_cinejoy.ts [tmdbId] [type=movie|tv] [maxSeconds] [mock]
 *   mock = intercept api.themoviedb.org and serve stub data (tests whether
 *   cinejoy's player can mount without real TMDB metadata — the block-prone
 *   dependency on VN networks).
 */
import { chromium } from "patchright";

const TMDB = process.argv[2] || "101";
const TYPE = process.argv[3] === "tv" ? "tv" : "movie";
const BASE = "https://cinejoy.pk";
const MAX = parseInt(process.argv[4] || "40", 10);
const MOCK_TMDB = process.argv[5] === "mock";
const ORIGIN = "https://cinejoy.pk";

const TMDB_STUB = {
  id: Number(TMDB),
  title: "Probe",
  name: "Probe",
  original_title: "Probe",
  original_name: "Probe",
  overview: "",
  tagline: "",
  runtime: 6000,
  episode_run_time: [1400],
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
          runtime: 1400,
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

const t0 = Date.now();
const at = () => ` [+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

let masterUrl: string | null = null;
let masterAt = 0;
let gPostAt = 0;
let masterRetries = 0;

const profile = `/tmp/strix-cinejoy-${Math.random().toString(36).slice(2, 8)}`;
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  args: [
    "--headless=new",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
  ],
  ignoreHTTPSErrors: true,
});

const page = await ctx.newPage();

if (MOCK_TMDB) {
  await ctx.route(
    (u) => u.hostname === "api.themoviedb.org",
    (route) => route.fulfill({ status: 200, body: JSON.stringify(TMDB_STUB), contentType: "application/json" }),
  );
  console.log(`${at()} 🎭 TMDB interception armed`);
}

page.on("request", (req) => {
  const u = req.url();
  if (u === "https://api.wing.st/g" && req.method() === "POST" && !gPostAt) {
    gPostAt = Date.now() - t0;
    console.log(`${at()} 🔐 /g sealed resolve POST`);
  }
  if (/wing\.st|lightspeed\.st/.test(u) && !/\.png$|\.woff|flagsapi/.test(u)) {
    console.log(`${at()}   net ${req.method()} ${u.slice(0, 100)}`);
  }
  // Any m3u8/mp4 from ANY domain (TV may resolve to a different CDN host)
  if (/\.(m3u8|mp4|mkv)(\?|$)|\/hls\//i.test(u) && !/cinejoy\.pk\/_app/.test(u)) {
    console.log(`${at()} 📼 media ${req.method()} ${u.slice(0, 120)}`);
  }
  if (/https:\/\/[a-z0-9.-]+\/hls\/[0-9a-f-]+(?:\/\d+)?\/master\.m3u8/i.test(u) && !masterUrl) {
    masterUrl = u;
    masterAt = Date.now() - t0;
    console.log(`${at()} 🎬 MASTER ${u}`);
  }
});
page.on("requestfailed", (r) => {
  if (r.resourceType() === "document")
    console.log(`${at()} ❌ DOC FAIL ${r.failure()?.errorText} ${r.url().slice(0, 90)}`);
});

const watchPath =
  TYPE === "tv" ? `/watch/tv/${TMDB}/1/1` : `/watch/movie/${TMDB}`;
console.log(`${at()} goto ${BASE}${watchPath}`);
await page
  .goto(`${BASE}${watchPath}`, { timeout: 20000, waitUntil: "commit" })
  .catch((e) => console.log(`${at()} goto err: ${(e as Error).message.slice(0, 80)}`));

const deadline = t0 + MAX * 1000;
while (Date.now() < deadline && !masterUrl) {
  await page.waitForTimeout(2000);
  if (!masterUrl) {
    // Real (trusted) input events only: JS el.click() is untrusted and the
    // player ignores it. Click the video element / viewport center with real
    // CDP mouse events — never nav buttons (blind clicking hit Search).
    await page
      .locator("video")
      .first()
      .click({ timeout: 3000, force: true })
      .catch(() => {});
    if (!masterUrl) {
      const cx = 640;
      const cy = 360;
      await page.mouse.move(cx, cy).catch(() => {});
      await page.mouse.click(cx, cy).catch(() => {});
    }
  }
  const st = await page
    .evaluate(() => {
      const v = document.querySelector("video");
      const errState = document.body.innerText.includes("couldn't find this");
      return {
        title: document.title.slice(0, 60),
        url: location.pathname,
        blocked: document.title.includes("Attention Required"),
        errState,
        hasVideo: !!v,
        videoSrc: v ? (v.currentSrc || v.src || "(empty)").slice(0, 50) : null,
        paused: v ? v.paused : null,
      };
    })
    .catch(() => ({
      title: "ERR",
      url: "?",
      blocked: false,
      errState: false,
      hasVideo: false,
      videoSrc: null,
      paused: null,
    }));
  if (st.blocked) {
    console.log(`${at()} 🚫 CLOUDFLARE BLOCK`);
    break;
  }
  if (st.errState) {
    // cinejoy shows "Oops! We couldn't find this" when its client-side TMDB
    // fetches fail (api.themoviedb.org is reset-flaky from VN networks).
    // A retry re-fires the metadata + resolve pipeline.
    if (!st.hasVideo && masterRetries < 3) {
      masterRetries++;
      console.log(`${at()} ⚠️ page error state — clicking Try Again (#${masterRetries})`);
      await page
        .getByRole("button", { name: "Try Again" })
        .click({ timeout: 3000 })
        .catch(() => {});
    }
  }
  if (Math.floor((Date.now() - t0) / 2000) % 3 === 0) {
    console.log(
      `${at()} waiting... title="${st.title}" path=${st.url} video=${st.hasVideo ? `${st.videoSrc} paused=${st.paused}` : "none"}${st.errState ? " [ERR-STATE]" : ""}`,
    );
  }
}

await ctx.close();

if (!masterUrl) {
  console.log(`\nRESULT: FAILED (no master.m3u8 within ${MAX}s)`);
  process.exit(1);
}

// ---- Phase 2: verify proxy-ability with pure fetch (what /proxy-chunk does) ----
console.log(`\n--- proxy verification (pure fetch) ---`);
const probe = async (url: string, origin: string | null) => {
  const headers: Record<string, string> = { "user-agent": "strix-probe" };
  if (origin) headers["origin"] = origin;
  const res = await fetch(url, { headers });
  const body = await res.text();
  return { status: res.status, body, bytes: body.length };
};

const withOrigin = await probe(masterUrl, ORIGIN);
console.log(
  `master + origin : ${withOrigin.status} | first line: ${withOrigin.body.split("\n")[0]?.trim().slice(0, 40)}`,
);

const noOrigin = await probe(masterUrl, null);
console.log(
  `master no origin: ${noOrigin.status} | first line: ${noOrigin.body.split("\n")[0]?.trim().slice(0, 40)}`,
);

// Walk one level down: variant playlist -> first segment
let segOk = "";
if (withOrigin.body.includes("#EXTM3U")) {
  const variantLine = withOrigin.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))[0];
  if (variantLine) {
    const variantUrl = new URL(variantLine, masterUrl).toString();
    const vRes = await probe(variantUrl, ORIGIN);
    console.log(
      `variant (${variantLine})  : ${vRes.status} | lines: ${vRes.body.split("\n").length}`,
    );
    const segLine = vRes.body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))[0];
    if (segLine) {
      const segUrl = new URL(segLine, variantUrl).toString();
      const segRes = await fetch(segUrl, {
        headers: { origin: ORIGIN, "user-agent": "strix-probe" },
      });
      const buf = await segRes.arrayBuffer();
      // fMP4 init/segments disguised as .png — check ftyp/styp boxes
      const magic = Buffer.from(buf.slice(0, 8)).toString("latin1");
      segOk = `${segRes.status} ${buf.byteLength}B magic="${magic}"`;
      console.log(`segment (${segLine.slice(0, 30)}) : ${segOk}`);
    }
  }
}

const gDelta = gPostAt ? `g=${(gPostAt / 1000).toFixed(1)}s -> master=${((masterAt - gPostAt) / 1000).toFixed(1)}s later` : "no /g seen";
console.log(
  `\nRESULT: resolve=${(masterAt / 1000).toFixed(1)}s (${gDelta}) | origin-header=${withOrigin.body.includes("#EXTM3U") ? "SUFFICIENT" : "INSUFFICIENT"} | segment=${segOk || "n/a"}`,
);
