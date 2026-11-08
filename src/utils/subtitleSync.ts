import {
  parseCueTimingLine,
  secondsToVttTimestamp,
} from "./subtitles";

/**
 * Cue-timing alignment between two WebVTT documents of the same title.
 * Used to auto-calibrate external subtitle tracks (Wyzie SRTs, which are
 * synced to an arbitrary release of the movie) against a subtitle rendition
 * embedded in the same HLS master as the video — the embedded track is muxed
 * with the stream, so it is in sync by construction.
 *
 * The two tracks are in different languages by design (the external track
 * fills exactly the languages the source lacks), so alignment runs on cue
 * ONSET TIMES only: dialogue rhythm is language-independent. The result is a
 * linear map ref = scale * target + offset that fixes both constant offsets
 * (different cuts / head trims) and progressive drift (fps mismatches such as
 * 23.976↔24.000, which accumulate to seconds over a feature film).
 *
 * Pure functions — no network, no CONFIG. The service layer passes the one
 * env-tunable knob (search window) and owns the confidence gates' logging.
 */

export interface SubtitleSyncTransform {
  /** ref = scale * target + offset — maps target (external) time into video time. */
  scale: number;
  offset: number;
  /** Fraction of TARGET cues matched after the final fit (0..1). */
  score: number;
  /** Inlier pair count after outlier rejection. */
  matched: number;
  /** Total target cues considered. */
  total: number;
  /** Same score computed at scale=1, offset=0 — the "already in sync" baseline. */
  identityScore: number;
}

export type AlignmentFailureReason =
  | "not_enough_cues"
  | "no_alignment_candidate"
  | "insufficient_spread"
  | "low_confidence"
  | "not_better_than_identity"
  | "already_synced";

export type AlignmentResult =
  | { ok: true; transform: SubtitleSyncTransform }
  | { ok: false; reason: AlignmentFailureReason };

export interface AlignOptions {
  /** Coarse search window in seconds, each direction. Everything else is
   * tuned via the module constants below (deliberately not configurable —
   * the gates' relationship to each other is what makes no-harm hold). */
  windowSec?: number;
}

// --- Tuning constants (documented WHY, not WHAT) ---------------------------

const COARSE_BIN_S = 1;
const COARSE_WINDOW_S = 120;
// Generous enough to absorb cross-language cue-segmentation jitter
// (translations merge/split dialogue lines), tight enough — vs the 1s coarse
// bins — that accidental matches stay rare.
const MATCH_TOLERANCE_S = 0.75;
// Forced-only renditions and stub tracks (a handful of cues) fall out here.
const MIN_CUES = 25;
const MIN_MATCHES = 10;
// A real sync between two tracks of the same title matches at least a third
// of the cues; coincidence matches stay well under that.
const MIN_SCORE = 0.3;
// The single most important gate: an already-in-sync track must be left
// alone, so a candidate fit has to clearly beat doing nothing.
const MIN_IMPROVEMENT = 0.1;
// Offsets under a quarter second are imperceptible; don't touch the track.
const NEGLIGIBLE_OFFSET_S = 0.25;
const NEGLIGIBLE_SCALE_DELTA = 0.0005;
// Admits every plausible fps pair incl. PAL↔NTSC (1.25 / 0.8); rejects
// nonsense fits from degenerate match sets.
const SCALE_CLAMP: [number, number] = [0.8, 1.3];
const OUTLIER_ROUNDS = 3;
// Matched pairs must span the movie, not just the intro — cross-release
// chapter/music structures otherwise produce convincing-looking local fits.
const MIN_SPREAD_S = 120;

// Seed scales from the fps pairs that actually occur between releases.
// 23.976 is exact (24000/1001 ≈ 23.97602 — the delta is far below the fit's
// resolution). The coarse stage evaluates all of them; the free linear fit
// refines from there, so an unlisted ratio between two close seeds is still
// recoverable.
const SCALE_CANDIDATES = [
  1.0,
  24 / 23.976, 23.976 / 24, // ±0.1% NTSC tick — the sneaky ~7s-per-2h drift
  25 / 23.976, 23.976 / 25, // PAL speedup on a 23.976 master (1.0427 / 0.9590)
  25 / 24, 24 / 25,
  29.97 / 25, 25 / 29.97, // PAL↔NTSC
  29.97 / 23.976, 23.976 / 29.97, // 1.25 / 0.8
];

// --- Cue extraction ---------------------------------------------------------

/**
 * Parses cue start/end times (seconds) out of a WebVTT document. Only lines
 * carrying a cue-timing arrow can match, so NOTE/STYLE/REGION blocks,
 * X-TIMESTAMP-MAP headers and cue text are structurally excluded. Cues with
 * end <= start are dropped; output is sorted by start ascending.
 */
export function extractCueTimings(vtt: string): Array<{ start: number; end: number }> {
  const cues: Array<{ start: number; end: number }> = [];
  for (const line of vtt.split("\n")) {
    const timing = parseCueTimingLine(line);
    if (!timing || timing.end <= timing.start) continue;
    cues.push({ start: timing.start, end: timing.end });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// --- Alignment --------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Index of the closest element to `needle` in a sorted array. */
function nearestIndex(sorted: number[], needle: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < needle) lo = mid;
    else hi = mid;
  }
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return Math.abs(a - needle) <= Math.abs(b - needle) ? lo : hi;
}

/**
 * Counts how many transformed target onsets land within tolerance of a ref
 * onset (greedy nearest-neighbor, one ref onset can serve multiple targets —
 * translations legitimately collapse several cues into one).
 */
function matchFraction(
  refOnsets: number[],
  targetOnsets: number[],
  scale: number,
  offset: number,
  tolerance: number,
): number {
  if (targetOnsets.length === 0) return 0;
  let matched = 0;
  for (const t of targetOnsets) {
    const transformed = t * scale + offset;
    const idx = nearestIndex(refOnsets, transformed);
    if (Math.abs(refOnsets[idx]! - transformed) <= tolerance) matched++;
  }
  return matched / targetOnsets.length;
}

/**
 * Robust linear fit ref ≈ scale * target + offset from matched cue pairs.
 * Seeded offset-only (median of residuals under the seed scale), then free
 * least-squares with iterative MAD outlier rejection. The final offset is the
 * MEDIAN of residuals (not the LS intercept) so one bad pair cannot drag it.
 */
function fitPairs(
  pairs: Array<{ t: number; r: number }>,
  seedScale: number,
  tolerance: number,
): { scale: number; offset: number; inliers: Array<{ t: number; r: number }> } {
  let working = pairs;

  // Offset-only robust start around the seed scale.
  const seedDeltas = working.map((p) => p.r - seedScale * p.t);
  const seedMed = median(seedDeltas);
  working = working.filter(
    (_, i) => Math.abs(seedDeltas[i]! - seedMed) <= tolerance,
  );
  if (working.length < 4) {
    return { scale: seedScale, offset: seedMed, inliers: working };
  }

  const leastSquares = (set: Array<{ t: number; r: number }>) => {
    const n = set.length;
    const meanT = set.reduce((s, p) => s + p.t, 0) / n;
    const meanR = set.reduce((s, p) => s + p.r, 0) / n;
    let cov = 0;
    let varT = 0;
    for (const p of set) {
      cov += (p.t - meanT) * (p.r - meanR);
      varT += (p.t - meanT) ** 2;
    }
    if (varT < 1e-6) return null; // matches bunched at one timestamp
    const scale = cov / varT;
    return { scale, offset: meanR - scale * meanT };
  };

  let fit = leastSquares(working) ?? {
    scale: seedScale,
    offset: median(working.map((p) => p.r - seedScale * p.t)),
  };

  for (let round = 0; round < OUTLIER_ROUNDS; round++) {
    const residuals = working.map((p) => p.r - (fit.scale * p.t + fit.offset));
    const m = median(residuals);
    const mad = median(residuals.map((e) => Math.abs(e - m)));
    const limit = Math.max(3 * mad, 0.5);
    const kept = working.filter((_, i) => Math.abs(residuals[i]! - m) <= limit);
    if (kept.length === working.length || kept.length < 4) break;
    working = kept;
    fit = leastSquares(working) ?? fit;
  }

  let { scale } = fit;
  scale = Math.min(SCALE_CLAMP[1], Math.max(SCALE_CLAMP[0], scale));
  if (Math.abs(scale - 1) < NEGLIGIBLE_SCALE_DELTA) scale = 1.0;
  const offset = median(working.map((p) => p.r - scale * p.t));
  return { scale, offset, inliers: working };
}

/**
 * Aligns a target VTT (external track, possibly shifted/scaled for a
 * different release) against a reference VTT (embedded rendition, in sync).
 * Returns the linear transform mapping target time into video time, or a
 * rejection reason — every gate falling through to "leave the track alone".
 */
export function alignSubtitleCues(
  refVtt: string,
  targetVtt: string,
  opts: AlignOptions = {},
): AlignmentResult {
  const windowSec = opts.windowSec ?? COARSE_WINDOW_S;

  const refOnsets = extractCueTimings(refVtt).map((c) => c.start);
  const targetOnsets = extractCueTimings(targetVtt).map((c) => c.start);
  if (refOnsets.length < MIN_CUES || targetOnsets.length < MIN_CUES) {
    return { ok: false, reason: "not_enough_cues" };
  }
  const targetSpan = targetOnsets[targetOnsets.length - 1]! - targetOnsets[0]!;

  // Stage B — coarse onset-density cross-correlation per candidate scale.
  // Integer-second bins keep this at a few million int adds — milliseconds.
  const window = Math.max(1, Math.floor(windowSec));
  const refBins = new Map<number, number>();
  for (const r of refOnsets) {
    const b = Math.floor(r);
    refBins.set(b, (refBins.get(b) ?? 0) + 1);
  }
  const scoredOffsets = new Map<number, number>(); // offset -> peak hits
  const seedScaleAt = new Map<number, number>(); // offset -> scale that found it
  for (const scale of SCALE_CANDIDATES) {
    const scaledBins = targetOnsets.map((t) => Math.floor(t * scale));
    const perOffset = new Array<number>(2 * window + 1).fill(0);
    for (let o = -window; o <= window; o++) {
      let hits = 0;
      for (const b of scaledBins) {
        const hit = refBins.get(b + o);
        if (hit) hits += hit;
      }
      perOffset[o + window] = hits;
    }
    let bestO = -window;
    let bestHits = -1;
    for (let i = 0; i < perOffset.length; i++) {
      if (perOffset[i]! > bestHits) {
        bestHits = perOffset[i]!;
        bestO = i - window;
      }
    }
    // Multiple scales legitimately converge on the same integer offset
    // (their coarse bins are identical); keep the strongest claimant so the
    // refinement stage sees each offset neighborhood once per scale family.
    if (bestHits > (scoredOffsets.get(bestO) ?? -1)) {
      scoredOffsets.set(bestO, bestHits);
      seedScaleAt.set(bestO, scale);
    }
  }
  const offsets = [...scoredOffsets.keys()].sort(
    (a, b) => scoredOffsets.get(b)! - scoredOffsets.get(a)!,
  );
  // Always refine the identity neighborhood even if another scale won coarse —
  // a sub-second true offset may lose the integer-bin argmax to noise.
  const topOffsets = offsets.slice(0, 3);
  if (!topOffsets.includes(0)) topOffsets.push(0);

  // Stage C+D — nearest-neighbor refinement and robust fit per seed.
  const identityScore = matchFraction(
    refOnsets,
    targetOnsets,
    1,
    0,
    MATCH_TOLERANCE_S,
  );
  const fits: Array<{
    scale: number;
    offset: number;
    score: number;
    matched: number;
    inlierSpan: number;
  }> = [];

  for (const o0 of topOffsets) {
    const s0 = seedScaleAt.get(o0) ?? 1.0;
    const pairs: Array<{ t: number; r: number }> = [];
    for (const t of targetOnsets) {
      const transformed = t * s0 + o0;
      const idx = nearestIndex(refOnsets, transformed);
      const r = refOnsets[idx]!;
      if (Math.abs(r - transformed) <= MATCH_TOLERANCE_S) pairs.push({ t, r });
    }
    if (pairs.length < MIN_MATCHES) continue;
    const fit = fitPairs(pairs, s0, MATCH_TOLERANCE_S);
    // Recount against the FIT (not the seed) — this is the score the gates see.
    const matched = targetOnsets.filter((t) => {
      const transformed = t * fit.scale + fit.offset;
      const idx = nearestIndex(refOnsets, transformed);
      return Math.abs(refOnsets[idx]! - transformed) <= MATCH_TOLERANCE_S;
    }).length;
    const score = matched / targetOnsets.length;
    const inlierSpan = fit.inliers.length >= 2
      ? fit.inliers[fit.inliers.length - 1]!.t - fit.inliers[0]!.t
      : 0;
    fits.push({ scale: fit.scale, offset: fit.offset, score, matched, inlierSpan });
  }

  if (fits.length === 0) return { ok: false, reason: "no_alignment_candidate" };

  // Quasi-periodic cue spacing (long uniform dialogue stretches) makes seeds
  // exactly one cue-period apart score identically — every candidate is then a
  // mathematically valid alignment. Occam on the time axis: among fits within
  // a hair of the best score, the smallest shift wins.
  const bestScore = Math.max(...fits.map((f) => f.score));
  const contenders = fits.filter((f) => f.score >= bestScore - 1e-6);
  contenders.sort(
    (a, b) =>
      Math.abs(a.offset) - Math.abs(b.offset) || b.matched - a.matched,
  );
  const best = contenders[0]!;

  // Stage F — gates, each falling through to "serve unchanged".
  if (best.inlierSpan < Math.min(MIN_SPREAD_S, 0.1 * targetSpan)) {
    return { ok: false, reason: "insufficient_spread" };
  }
  if (best.score < MIN_SCORE) return { ok: false, reason: "low_confidence" };
  if (best.score < identityScore + MIN_IMPROVEMENT) {
    return { ok: false, reason: "not_better_than_identity" };
  }
  if (
    Math.abs(best.offset) < NEGLIGIBLE_OFFSET_S &&
    Math.abs(best.scale - 1) < NEGLIGIBLE_SCALE_DELTA
  ) {
    return { ok: false, reason: "already_synced" };
  }

  return {
    ok: true,
    transform: {
      scale: best.scale,
      offset: best.offset,
      score: best.score,
      matched: best.matched,
      total: targetOnsets.length,
      identityScore,
    },
  };
}

// --- Transform applier ------------------------------------------------------

/**
 * Rewrites cue timing lines of a WebVTT document through the linear map
 * new = scale * old + offset, preserving every non-timing byte (cue text,
 * inline tags, cue settings, NOTE/STYLE/REGION blocks, X-TIMESTAMP-MAP
 * headers, blank-line structure). Cues that collapse (end <= start after the
 * shift — e.g. a negative offset cutting off head cues) are removed whole,
 * including their optional cue-id line. Output timestamps are normalized to
 * HH:MM:SS.mmm, matching what mergeHlsVttSegments emits.
 */
export function applyVttTimeTransform(
  vtt: string,
  scale: number,
  offset: number,
): string {
  const out: string[] = [];
  // Set while walking: the line just written was a bare cue id → the next
  // dropped timing line must take it with it.
  let pendingCueId: string | null = null;
  let droppingCue = false;

  for (const line of vtt.split("\n")) {
    if (droppingCue) {
      // A cue body ends at the first blank line; text lines are discarded.
      if (line.trim() === "") {
        droppingCue = false;
        pendingCueId = null;
        out.push(line);
      }
      continue;
    }

    const timing = parseCueTimingLine(line);
    if (!timing) {
      pendingCueId =
        line.trim() !== "" &&
        !line.startsWith("NOTE") &&
        !line.startsWith("STYLE") &&
        !line.startsWith("REGION") &&
        !line.startsWith("WEBVTT")
          ? line
          : null;
      out.push(line);
      continue;
    }

    if (pendingCueId !== null) {
      out.pop(); // the cue id goes only if the cue is dropped
    }

    // Clamp before the collapse check: a cue that lies entirely before the
    // video start (both ends negative) collapses to 0→0 after clamping and
    // must be dropped, not emitted as a zero-length cue.
    const newStart = Math.max(0, scale * timing.start + offset);
    const newEnd = Math.max(0, scale * timing.end + offset);
    if (newEnd <= newStart) {
      // Collapsed cue: drop it and everything up to the next blank line.
      // (The popped cue id, if any, is gone with it.)
      droppingCue = true;
      pendingCueId = null;
      continue;
    }

    if (pendingCueId !== null) out.push(pendingCueId);
    pendingCueId = null;
    out.push(
      `${secondsToVttTimestamp(newStart)} --> ${secondsToVttTimestamp(newEnd)}${timing.rest}`,
    );
  }

  return out.join("\n");
}
