import { describe, expect, it } from "bun:test";
import { secondsToVttTimestamp } from "../src/utils/subtitles";
import {
  alignSubtitleCues,
  applyVttTimeTransform,
  extractCueTimings,
} from "../src/utils/subtitleSync";

/** Builds a minimal WebVTT document from [start, end] cue pairs. */
function vtt(cues: Array<[number, number]>): string {
  const blocks = cues.map(
    ([s, e], i) => `${i + 1}\n${secondsToVttTimestamp(s)} --> ${secondsToVttTimestamp(e)}\nCue ${i + 1}`,
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/** Seeded PRNG (mulberry32) so jitter tests are deterministic. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly spaced cue onsets across [from, to]. */
function evenOnsets(from: number, to: number, count: number): number[] {
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, i) => from + i * step);
}

/**
 * Cue onsets with random uneven gaps — real dialogue rhythm. Perfectly even
 * spacing is quasi-periodic, which makes every seed one cue-period apart an
 * equally valid alignment (undetectable by timing alone).
 */
function dialogueOnsets(from: number, to: number, count: number, seed: number): number[] {
  const rand = rng(seed);
  const total = to - from;
  const weights = Array.from({ length: count }, () => 0.15 + rand() * 1.7);
  const wSum = weights.reduce((a, b) => a + b, 0);
  let t = from;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += ((weights[i] ?? 1) / wSum) * total;
  }
  return out;
}

describe("extractCueTimings", () => {
  it("parses HH:MM:SS.mmm and MM:SS.mmm cue lines", () => {
    const doc = [
      "WEBVTT",
      "",
      "00:00:01.500 --> 00:00:03.000",
      "Hello",
      "",
      "01:02.250 --> 01:04.750",
      "World",
    ].join("\n");
    expect(extractCueTimings(doc)).toEqual([
      { start: 1.5, end: 3.0 },
      { start: 62.25, end: 64.75 },
    ]);
  });

  it("ignores NOTE, STYLE, X-TIMESTAMP-MAP and cue text", () => {
    const doc = [
      "WEBVTT",
      "X-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000",
      "NOTE this is a comment with --> arrow",
      "STYLE ::cue { color: red }",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "text mentioning --> timestamps 00:00:09.000",
    ].join("\n");
    expect(extractCueTimings(doc)).toEqual([{ start: 5, end: 6 }]);
  });

  it("drops cues with end <= start and sorts ascending", () => {
    const doc = [
      "WEBVTT",
      "",
      "00:00:10.000 --> 00:00:10.000",
      "degenerate",
      "",
      "00:00:20.000 --> 00:00:22.000",
      "later",
      "",
      "00:00:05.000 --> 00:00:07.000",
      "earlier",
    ].join("\n");
    expect(extractCueTimings(doc)).toEqual([
      { start: 5, end: 7 },
      { start: 20, end: 22 },
    ]);
  });
});

describe("alignSubtitleCues", () => {
  const baseCues = dialogueOnsets(30, 7000, 120, 99).map(
    (t) => [t, t + 2] as [number, number],
  );

  it("recovers a pure constant offset", () => {
    const ref = vtt(baseCues);
    // Target track plays 3.2s LATE → target_t = ref_t + 3.2 → offset ≈ -3.2.
    const target = vtt(baseCues.map(([s, e]) => [s + 3.2, e + 3.2]));
    const result = alignSubtitleCues(ref, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform.scale).toBeCloseTo(1, 3);
    expect(result.transform.offset).toBeCloseTo(-3.2, 1);
    expect(result.transform.score).toBeGreaterThan(0.9);
  });

  it("recovers fps drift (24 vs 23.976) over a 2h timeline", () => {
    const ref = vtt(baseCues);
    // Target authored for 24.000fps release, video runs at 23.976 → drift.
    const ratio = 24 / 23.976;
    const target = vtt(baseCues.map(([s, e]) => [s * ratio, e * ratio]));
    const result = alignSubtitleCues(ref, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform.scale).toBeCloseTo(23.976 / 24, 3);
    expect(result.transform.offset).toBeCloseTo(0, 0);
    // End-of-movie residual: the last TARGET cue sits at 7000 × ratio; after
    // the transform it must land within 1s of its reference partner at 7000s.
    const lastTarget = 7000 * ratio;
    const mapped = lastTarget * result.transform.scale + result.transform.offset;
    expect(Math.abs(mapped - 7000)).toBeLessThan(1);
  });

  it("recovers combined offset + scale (PAL speedup on shifted cut)", () => {
    const longCues = dialogueOnsets(30, 1800, 90, 5).map(
      (t) => [t, t + 2] as [number, number],
    );
    const ref = vtt(longCues);
    const scale = 25 / 23.976;
    const offset = 5;
    const target = vtt(
      longCues.map(([s, e]) => [s * scale + offset, e * scale + offset]),
    );
    const result = alignSubtitleCues(ref, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform.scale).toBeCloseTo(1 / scale, 3);
    expect(result.transform.offset).toBeCloseTo(-offset / scale, 0);
  });

  it("recovers the PAL reciprocal direction (target slower than ref)", () => {
    const longCues = dialogueOnsets(30, 1800, 90, 6).map(
      (t) => [t, t + 2] as [number, number],
    );
    const ref = vtt(longCues);
    const scale = 23.976 / 25;
    const target = vtt(longCues.map(([s, e]) => [s * scale, e * scale]));
    const result = alignSubtitleCues(ref, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform.scale).toBeCloseTo(1 / scale, 3);
  });

  it("survives ±150ms per-cue jitter", () => {
    const rand = rng(42);
    const jittered = baseCues.map(([s, e]) => {
      const j = (rand() - 0.5) * 0.3; // ±150ms
      return [s + 3.2 + j, e + 3.2 + j] as [number, number];
    });
    const ref = vtt(baseCues);
    const target = vtt(jittered);
    const result = alignSubtitleCues(ref, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform.offset).toBeCloseTo(-3.2, 1);
  });

  it("rejects structurally unrelated cues", () => {
    const rand = rng(7);
    const randomCues = Array.from({ length: 120 }, (_, i) => {
      const s = 30 + rand() * 6900 + i; // keep onsets increasing but unaligned
      return [s, s + 2] as [number, number];
    });
    const result = alignSubtitleCues(vtt(baseCues), vtt(randomCues));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["low_confidence", "no_alignment_candidate"]).toContain(result.reason);
  });

  it("rejects an already-in-sync track", () => {
    const result = alignSubtitleCues(vtt(baseCues), vtt(baseCues));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["already_synced", "not_better_than_identity"]).toContain(result.reason);
  });

  it("rejects when either side has too few cues", () => {
    const few = evenOnsets(30, 600, 8).map((t) => [t, t + 2] as [number, number]);
    const shifted = few.map(([s, e]) => [s + 5, e + 5] as [number, number]);
    expect(alignSubtitleCues(vtt(few), vtt(shifted)).ok).toBe(false);
    expect(alignSubtitleCues(vtt(baseCues), vtt(few)).ok).toBe(false);
  });

  it("rejects intro-only overlap (insufficient spread)", () => {
    // Dense intro present on BOTH sides (matching up to a shift); everything
    // after 90s is unrelated noise. The only true overlap spans ~70s, under
    // the spread gate — aligning on just the intro is how a recap/credits
    // structure fools a naive matcher.
    const rand = rng(13);
    const refIntro = evenOnsets(20, 90, 40);
    const refTail = evenOnsets(120, 7000, 90);
    const ref = vtt([
      ...refIntro.map((t) => [t, t + 1.5] as [number, number]),
      ...refTail.map((t) => [t, t + 2] as [number, number]),
    ]);
    const targetIntro = refIntro.map((t) => [t + 3.2, t + 4.7] as [number, number]);
    const targetTail: Array<[number, number]> = [];
    let t = 200;
    while (t < 6800) {
      const j = (rand() - 0.5) * 6;
      targetTail.push([t + j, t + j + 2]);
      t += 60 + rand() * 6;
    }
    const target = vtt([...targetIntro, ...targetTail]);
    const result = alignSubtitleCues(ref, target);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["insufficient_spread", "low_confidence", "not_better_than_identity"]).toContain(
      result.reason,
    );
  });

  it("reports matched/total/identityScore in the transform", () => {
    const target = vtt(baseCues.map(([s, e]) => [s + 3.2, e + 3.2]));
    const result = alignSubtitleCues(vtt(baseCues), target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform.matched).toBeGreaterThan(0);
    expect(result.transform.total).toBe(baseCues.length);
    expect(result.transform.identityScore).toBeLessThan(result.transform.score);
  });
});

describe("applyVttTimeTransform", () => {
  it("round-trips: apply (s,o) then (1/s, -o/s) recovers original times", () => {
    const cues: Array<[number, number]> = evenOnsets(10, 3000, 40).map(
      (t) => [t, t + 1.5] as [number, number],
    );
    const original = extractCueTimings(vtt(cues));
    const s = 25 / 23.976;
    const o = 7.5;
    const once = applyVttTimeTransform(vtt(cues), s, o);
    const back = applyVttTimeTransform(once, 1 / s, -o / s);
    const recovered = extractCueTimings(back);
    expect(recovered).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]!.start).toBeCloseTo(original[i]!.start, 2);
      expect(recovered[i]!.end).toBeCloseTo(original[i]!.end, 2);
    }
  });

  it("preserves cue text, tags, settings, NOTE and X-TIMESTAMP-MAP", () => {
    const doc = [
      "WEBVTT",
      "X-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000",
      "NOTE a block comment",
      "STYLE ::cue { color: red }",
      "",
      "intro",
      "00:00:10.000 --> 00:00:12.000 align:start line:0",
      "<i>Hello <b>world</b></i>",
      "second line",
      "",
      "00:00:20.000 --> 00:00:22.000",
      "Bye",
    ].join("\n");
    const out = applyVttTimeTransform(doc, 1, 2.5);
    expect(out).toContain("X-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000");
    expect(out).toContain("NOTE a block comment");
    expect(out).toContain("STYLE ::cue { color: red }");
    expect(out).toContain("intro");
    expect(out).toContain("align:start line:0");
    expect(out).toContain("<i>Hello <b>world</b></i>");
    expect(out).toContain("second line");
    expect(out).toContain("00:00:12.500 --> 00:00:14.500 align:start line:0");
    expect(out).toContain("00:00:22.500 --> 00:00:24.500");
  });

  it("clamps negative starts to 00:00:00.000 and drops collapsed cues", () => {
    const doc = [
      "WEBVTT",
      "",
      "id-1",
      "00:00:02.000 --> 00:00:04.000",
      "will collapse",
      "",
      "00:00:03.000 --> 00:00:08.000",
      "clamped start",
    ].join("\n");
    const out = applyVttTimeTransform(doc, 1, -5);
    // 2→4 lies entirely before the shift → both ends clamp to 0 → dropped.
    expect(out).not.toContain("will collapse");
    expect(out).not.toContain("id-1");
    // 3→8 straddles zero: start clamps to 00:00:00.000, end lands at 3s.
    expect(out).toContain("00:00:00.000 --> 00:00:03.000");
    expect(out).toContain("clamped start");
  });

  it("is idempotent at scale=1 offset=0", () => {
    const cues: Array<[number, number]> = evenOnsets(10, 1000, 30).map(
      (t) => [t, t + 2] as [number, number],
    );
    const doc = vtt(cues);
    const out = applyVttTimeTransform(doc, 1, 0);
    // Times must be unchanged (modulo MM:SS → HH:MM:SS normalization, which
    // the builder never emits).
    expect(extractCueTimings(out)).toEqual(extractCueTimings(doc));
    // All cue text survives.
    for (let i = 1; i <= cues.length; i++) {
      expect(out).toContain(`Cue ${i}`);
    }
  });

  it("passes through documents with no cue lines untouched", () => {
    const doc = "WEBVTT\n\nNOTE empty track\n";
    expect(applyVttTimeTransform(doc, 2, 5)).toBe(doc);
  });

  it("does not treat glued cue ids or mid-line arrows as cue lines", () => {
    // Malformed real-world shapes: a cue id glued to its timings, and cue
    // text containing a timestamp-with-arrow. Neither may be rewritten — an
    // unanchored match would corrupt the first ("…04.5001 ") and hallucinate
    // a cue out of the second.
    const doc = [
      "WEBVTT",
      "",
      "1 00:00:02.000 --> 00:00:04.000",
      "text with 00:00:09.000 --> 00:00:10.000 inside",
      "",
      "00:00:05.000 --> 00:00:07.000",
      "real cue",
    ].join("\n");
    expect(extractCueTimings(doc)).toEqual([{ start: 5, end: 7 }]);
    const out = applyVttTimeTransform(doc, 1, 1);
    expect(out).toContain("1 00:00:02.000 --> 00:00:04.000");
    expect(out).toContain("text with 00:00:09.000 --> 00:00:10.000 inside");
    expect(out).toContain("00:00:06.000 --> 00:00:08.000");
    expect(out).not.toContain("00:00:04.5001");
  });
});
