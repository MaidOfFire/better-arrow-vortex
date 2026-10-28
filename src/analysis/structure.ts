// Finds repeated sections of a song on its beat grid.
//
// Every beat gets a feature vector made of three equally weighted, unit-length blocks:
// harmony (12 pitch classes), timbre (12 log-spaced band energies) and rhythm (onset strength
// of the low/mid/high bands in each 16th of the beat). The dot product of two beats is then the
// mean cosine similarity of the three. Windows of beats that stay similar along a diagonal are
// repeats. On a power-metal test song this found the repeated verse+chorus block and the
// looping solo.

import { fft } from './fft';
import type { OnsetData } from './onsets';

export interface BeatFeatures {
  beats: number;
  dims: number;
  /** beats x dims, row-major. */
  data: Float32Array;
}

/** A group of equally long, similar stretches of the song (in beats). */
export interface RepeatGroup {
  length: number;
  starts: number[];
  score: number;
  /** The first detail level that has this group (see findLevels). */
  level?: number;
}

const BLOCK = 12;
const DIMS = BLOCK * 3;

export function computeBeatFeatures(samples: Float32Array, sampleRate: number, beatTimes: Float64Array, onsets: OnsetData): BeatFeatures {
  const beats = Math.max(0, beatTimes.length - 1);
  const step = sampleRate > 32000 ? 2 : 1;
  const rate = sampleRate / step;
  const n = Math.floor(samples.length / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; ++i) {
    let v = 0;
    for (let k = 0; k < step; ++k) v += samples[i * step + k];
    x[i] = v / step;
  }

  // Spectrum every 1024 samples (~46 ms) for harmony and timbre.
  const NFFT = 2048;
  const HOP = 1024;
  const bins = NFFT / 2 + 1;
  const pitchClass = new Int8Array(bins).fill(-1);
  const band = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; ++k) {
    const hz = (k * rate) / NFFT;
    if (hz > 150 && hz < 5000) pitchClass[k] = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12;
    if (hz >= 40 && hz < 10000) band[k] = Math.min(BLOCK - 1, Math.floor((BLOCK * Math.log(hz / 40)) / Math.log(10000 / 40)));
  }
  const frames = Math.max(0, Math.floor((n - NFFT) / HOP) + 1);
  const window = new Float32Array(NFFT);
  for (let i = 0; i < NFFT; ++i) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1));
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);
  const chroma = new Float32Array(frames * BLOCK);
  const timbre = new Float32Array(frames * BLOCK);
  for (let f = 0; f < frames; ++f) {
    const off = f * HOP;
    for (let i = 0; i < NFFT; ++i) {
      re[i] = x[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < bins; ++k) {
      const m = Math.hypot(re[k], im[k]);
      if (pitchClass[k] >= 0) chroma[f * BLOCK + pitchClass[k]] += m;
      if (band[k] >= 0) timbre[f * BLOCK + band[k]] += m;
    }
    for (let j = 0; j < BLOCK; ++j) {
      chroma[f * BLOCK + j] = Math.log1p(chroma[f * BLOCK + j]);
      timbre[f * BLOCK + j] = Math.log1p(timbre[f * BLOCK + j]);
    }
  }

  const data = new Float32Array(beats * DIMS);
  for (let b = 0; b < beats; ++b) {
    const t0 = beatTimes[b];
    const t1 = beatTimes[b + 1];
    // Harmony and timbre: mean over the frames inside the beat (nearest frame if none).
    let f0 = Math.max(0, Math.ceil(t0 * (rate / HOP) - NFFT / 2 / HOP));
    let f1 = Math.min(frames - 1, Math.floor(t1 * (rate / HOP) - NFFT / 2 / HOP));
    if (f1 < f0) f0 = f1 = Math.min(frames - 1, Math.max(0, Math.round((t0 + t1) / 2 / (HOP / rate) - NFFT / 2 / HOP)));
    if (frames > 0) {
      const count = f1 - f0 + 1;
      for (let f = f0; f <= f1; ++f) {
        for (let j = 0; j < BLOCK; ++j) {
          data[b * DIMS + j] += chroma[f * BLOCK + j] / count;
          data[b * DIMS + BLOCK + j] += timbre[f * BLOCK + j] / count;
        }
      }
    }
    // Rhythm: strongest onset per band in each 16th of the beat.
    for (let s = 0; s < 4; ++s) {
      const a = t0 + ((t1 - t0) * s) / 4;
      const e = t0 + ((t1 - t0) * (s + 1)) / 4;
      for (let g = 0; g < 3; ++g) {
        const c = onsets.bands[g];
        let i0 = Math.max(0, Math.floor((a - onsets.start) * onsets.fps));
        const i1 = Math.min(c.length - 1, Math.floor((e - onsets.start) * onsets.fps));
        let max = 0;
        for (; i0 <= i1; ++i0) if (c[i0] > max) max = c[i0];
        data[b * DIMS + 2 * BLOCK + s * 3 + g] = max;
      }
    }
  }

  // Centre every dimension over the song, then make each block unit length (weight 1/sqrt(3)).
  for (let d = 0; d < DIMS; ++d) {
    let mean = 0;
    for (let b = 0; b < beats; ++b) mean += data[b * DIMS + d];
    mean /= Math.max(1, beats);
    for (let b = 0; b < beats; ++b) data[b * DIMS + d] -= mean;
  }
  const w = 1 / Math.sqrt(3);
  for (let b = 0; b < beats; ++b) {
    for (let blk = 0; blk < 3; ++blk) {
      let norm = 0;
      for (let j = 0; j < BLOCK; ++j) norm += data[b * DIMS + blk * BLOCK + j] ** 2;
      norm = Math.sqrt(norm);
      for (let j = 0; j < BLOCK; ++j) data[b * DIMS + blk * BLOCK + j] = norm > 1e-9 ? (data[b * DIMS + blk * BLOCK + j] / norm) * w : 0;
    }
  }
  return { beats, dims: DIMS, data };
}

/** Similarity (-1..1) of two beats. */
export function beatSimilarity(f: BeatFeatures, a: number, b: number): number {
  if (a < 0 || b < 0 || a >= f.beats || b >= f.beats) return 0;
  let s = 0;
  for (let d = 0; d < f.dims; ++d) s += f.data[a * f.dims + d] * f.data[b * f.dims + d];
  return s;
}

/** Mean beat similarity of [a, a+len) and [b, b+len). */
export function windowSimilarity(f: BeatFeatures, a: number, b: number, len: number): number {
  let s = 0;
  let n = 0;
  for (let k = 0; k < len; ++k) {
    if (a + k >= f.beats || b + k >= f.beats) break;
    s += beatSimilarity(f, a + k, b + k);
    ++n;
  }
  return n ? s / n : 0;
}

/** Best-matching other stretches for [start, start+len), strongest first. */
export function rankMatches(f: BeatFeatures, start: number, len: number, count = 8): { start: number; score: number }[] {
  const scores: number[] = [];
  for (let b = 0; b + len <= f.beats; ++b) scores.push(windowSimilarity(f, start, b, len));
  const out: { start: number; score: number }[] = [];
  for (let b = 0; b < scores.length; ++b) {
    if (Math.abs(b - start) < len) continue; // overlaps the query
    const isPeak = (b === 0 || scores[b] >= scores[b - 1]) && (b === scores.length - 1 || scores[b] >= scores[b + 1]);
    if (isPeak) out.push({ start: b, score: scores[b] });
  }
  out.sort((p, q) => q.score - p.score);
  const picked: typeof out = [];
  for (const m of out) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.start - m.start) >= len / 2)) picked.push(m);
  }
  return picked;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Repeats on a grid of `step` beats (one measure), compared in windows of `window` beats.
 * Runs of similar windows at the same lag become pairs; pairs sharing an occurrence merge
 * into groups.
 */
/**
 * Beat-to-beat similarities summed along each diagonal, so the mean similarity of any two
 * windows (`a` vs `a + lag`) is one subtraction.
 */
export class SimilarityIndex {
  /** prefix[offset(lag) + i] = sum of similarity(k, k + lag) for k < i. */
  private readonly prefix: Float64Array;
  private readonly offsets: Int32Array;

  constructor(readonly f: BeatFeatures) {
    const n = f.beats;
    this.offsets = new Int32Array(n + 1);
    let total = 0;
    for (let lag = 0; lag < n; ++lag) {
      this.offsets[lag] = total;
      total += n - lag + 1;
    }
    this.offsets[n] = total;
    this.prefix = new Float64Array(total);
    for (let lag = 0; lag < n; ++lag) {
      const o = this.offsets[lag];
      for (let k = 0; k < n - lag; ++k) this.prefix[o + k + 1] = this.prefix[o + k] + beatSimilarity(f, k, k + lag);
    }
  }

  /** Mean similarity of [a, a+len) and [b, b+len), with a < b. */
  window(a: number, b: number, len: number): number {
    const lag = b - a;
    const o = this.offsets[lag];
    const end = Math.min(a + len, this.f.beats - lag);
    if (end <= a) return 0;
    return (this.prefix[o + end] - this.prefix[o + a]) / (end - a);
  }
}

export function findRepeats(
  f: BeatFeatures,
  window = 16,
  step = 4,
  minLength = 32,
  maxGroups = 16,
  maxLength = Infinity,
  index = new SimilarityIndex(f),
  strong = 0.99,
): RepeatGroup[] {
  const starts: number[] = [];
  for (let i = 0; i + window <= f.beats; i += step) starts.push(i);
  // First windows on the step grid, second windows at every beat, so lags are exact.
  const pairs: { a: number; b: number; s: number; c: number }[] = [];
  for (const a of starts) {
    for (let b = a + window; b + window <= f.beats; ++b) pairs.push({ a, b, s: index.window(a, b, window), c: alignedContrast(index, a, b, window) });
  }
  if (!pairs.length) return [];
  const sorted = pairs.map((p) => p.c).sort((x, y) => x - y);
  // Strong pairs line up sharply: they match clearly better at their exact offset than a few beats
  // off (the top 1% by default, within fixed bounds), and sound at least somewhat alike. Raw
  // similarity alone also catches music that keeps one texture throughout, and in songs made of
  // such music the real repeats do not stand out from it.
  const threshold = Math.max(0.08, Math.min(0.25, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * strong))]));
  const MIN_SIMILAR = 0.25;

  // Runs of strong windows along each lag.
  const byLag = new Map<number, { a: number; s: number }[]>();
  for (const p of pairs) {
    if (p.c < threshold || p.s < MIN_SIMILAR) continue;
    const lag = p.b - p.a;
    let list = byLag.get(lag);
    if (!list) byLag.set(lag, (list = []));
    list.push({ a: p.a, s: p.s });
  }
  const runs: { a: number; b: number; length: number; score: number }[] = [];
  for (const [lag, list] of byLag) {
    list.sort((p, q) => p.a - q.a);
    let first = 0;
    for (let k = 1; k <= list.length; ++k) {
      if (k < list.length && list[k].a - list[k - 1].a <= step) continue;
      const seg = list.slice(first, k);
      // Windows that only partly overlap the repeat still score high, so trim whole steps
      // (measures) at both ends that do not line up on their own.
      let a = seg[0].a;
      let end = seg[seg.length - 1].a + window;
      const weak = (x: number) => index.window(x, x + lag, step) < MIN_SIMILAR || alignedContrast(index, x, x + lag, step) < threshold / 2;
      while (end - a > step && weak(a)) a += step;
      while (end - a > step && weak(end - step)) end -= step;
      const length = end - a;
      if (length >= minLength && length <= maxLength) {
        runs.push({ a, b: a + lag, length, score: seg.reduce((t, p) => t + p.s, 0) / seg.length });
      }
      first = k;
    }
  }
  runs.sort((p, q) => q.length * q.score - p.length * p.score);

  const groups: RepeatGroup[] = [];
  for (const r of runs) {
    // A loop (the repeat overlaps itself): one occurrence per period.
    const occ = r.b - r.a < r.length ? Array.from({ length: Math.floor((r.b + r.length - r.a) / (r.b - r.a)) }, (_, k) => r.a + k * (r.b - r.a)) : [r.a, r.b];
    const len = r.b - r.a < r.length ? r.b - r.a : r.length;
    const covers = (g: RepeatGroup, s: number, t: number) => overlap(s, s + len, t, t + g.length) >= 0.5 * Math.min(len, g.length);
    const covered = (g: RepeatGroup, s: number) => g.starts.some((t) => covers(g, s, t));
    // Shift that lines this run up with an occurrence of an existing group, if any.
    const alignTo = (g: RepeatGroup): number | null => {
      for (const s of occ) for (const t of g.starts) if (covers(g, s, t)) return t - s;
      return null;
    };
    const same = groups.find((g) => Math.abs(g.length - len) <= 0.25 * Math.max(g.length, len) && alignTo(g) !== null);
    if (same) {
      const d = alignTo(same)!;
      for (const s of occ) if (!covered(same, s + d)) same.starts.push(s + d);
      same.starts.sort((p, q) => p - q);
      continue;
    }
    // Skip runs that mostly lie inside an already found, longer group.
    const inside = groups.some((g) => occ.every((s) => g.starts.some((t) => overlap(s, s + len, t, t + g.length) >= 0.8 * len)));
    if (inside) continue;
    groups.push({ length: len, starts: occ, score: r.score });
    if (groups.length >= maxGroups) break;
  }
  // Drop groups that mostly repeat what stronger groups (found earlier) of about the same length
  // already cover. A clearly shorter group inside a longer one stays: it is a part of that section
  // that also repeats elsewhere, i.e. a nested group.
  const kept: RepeatGroup[] = [];
  for (const g of groups) {
    const covered = new Uint8Array(f.beats);
    for (const k of kept) {
      if (k.length < 1.5 * g.length) for (const s of k.starts) covered.fill(1, s, Math.min(f.beats, s + k.length));
    }
    let total = 0;
    let already = 0;
    for (const s of g.starts) {
      for (let b = s; b < Math.min(f.beats, s + g.length); ++b) {
        ++total;
        already += covered[b];
      }
    }
    if (total && already / total > 0.6) continue;
    kept.push(g);
  }
  return kept.sort((p, q) => p.starts[0] - q.starts[0]);
}

/**
 * How much detection looks for, from 1 (only the clearest big sections) to 5 (every repeat it
 * can find): how many of the three scales it searches, which share of all window pairs counts as
 * alike (0.99: the top 1%), how sure a group must be (see confirmGroups) and how many are kept.
 */
export const DETAIL_LEVELS = [
  { scales: 1, maxGroups: 4, perScale: 12, strong: 0.99, minConfidence: 0.15, label: 'Only the clearest big sections' },
  { scales: 1, maxGroups: 12, perScale: 12, strong: 0.99, minConfidence: 0.12, label: 'Big sections' },
  { scales: 2, maxGroups: 18, perScale: 12, strong: 0.99, minConfidence: 0.1, label: 'Sections and the parts repeating inside them' },
  { scales: 3, maxGroups: 24, perScale: 16, strong: 0.99, minConfidence: 0.1, label: 'Sections, parts and short figures' },
  { scales: 3, maxGroups: 40, perScale: 24, strong: 0.98, minConfidence: 0.06, label: 'Everything, also fainter and shorter repeats' },
] as const;
export const DEFAULT_DETAIL = 4;

/**
 * Repeats at up to three scales, pooled so that groups can nest: whole sections, then parts of
 * up to 8 measures, then figures of up to 4 measures. The finer scales are capped in length, so
 * they find what repeats inside sections instead of finding the sections again. A finer group
 * that describes the same stretches as one already found (similar length, mostly the same beats)
 * is dropped. The nesting itself is derived later from which occurrences contain which.
 */
export function findHierarchy(
  f: BeatFeatures,
  detail = DEFAULT_DETAIL,
  options: {
    refine?: boolean;
    /** Groups marked by hand: found groups fit around them, and they are not changed. */
    fixed?: RepeatGroup[];
    /** Groups found at a coarser level: found groups fit around them, and they can only gain occurrences. */
    kept?: RepeatGroup[];
    /** How many new groups to keep at most (default: the level's). */
    maxGroups?: number;
  } = {},
): RepeatGroup[] {
  const { refine = true, fixed = [], kept = [] } = options;
  const level = DETAIL_LEVELS[Math.min(DETAIL_LEVELS.length, Math.max(1, Math.round(detail))) - 1];
  const { perScale, strong, minConfidence } = level;
  const maxGroups = options.maxGroups ?? level.maxGroups;
  // Pool more than will be kept: confirming drops some, and the cap applies to what is left.
  const poolSize = Math.max(24, maxGroups);
  const index = new SimilarityIndex(f);
  // Window, step, shortest and longest repeat (beats) of each scale.
  const scaleSpecs = [
    [16, 4, 32, Infinity],
    [8, 4, 16, 32],
    [4, 2, 8, 16],
  ].slice(0, level.scales);
  /** The shortest repeat each group's scale looks for. */
  const shortest = new Map<RepeatGroup, number>();
  const scales = scaleSpecs.map(([window, step, min, max]) => {
    const found = findRepeats(f, window, step, min, perScale, max, index, strong);
    for (const g of found) shortest.set(g, min);
    return found;
  });
  const coverage = (g: RepeatGroup) => {
    const marks = new Uint8Array(f.beats);
    for (const s of g.starts) marks.fill(1, s, Math.min(f.beats, s + g.length));
    return marks;
  };
  const sameRepeat = (a: RepeatGroup, b: RepeatGroup) => {
    if (Math.max(a.length, b.length) >= 1.5 * Math.min(a.length, b.length)) return false;
    const ca = coverage(a);
    const cb = coverage(b);
    let both = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < f.beats; ++i) {
      na += ca[i];
      nb += cb[i];
      both += ca[i] & cb[i];
    }
    return both >= 0.6 * Math.min(na, nb);
  };
  const pooled: RepeatGroup[] = [];
  for (const scale of scales) {
    // Strongest first, so the cap below keeps the clearest repeats of each scale.
    for (const g of [...scale].sort((p, q) => q.score * q.length * q.starts.length - p.score * p.length * p.starts.length)) {
      if (pooled.length >= poolSize) break;
      const same = pooled.find((p) => sameRepeat(p, g));
      // The same repeat found at another scale can have occurrences this one missed.
      if (same) absorbGroup(f, same, g);
      else pooled.push(g);
    }
  }
  for (const g of pooled) {
    // Occurrences overlapping by a few beats are usually a beat or two off: refining moves them
    // apart. Larger overlaps come from merging runs and are settled first.
    dropOverlaps(f, g, refine ? Math.max(2, Math.floor(g.length / 8)) : 0);
    if (refine) refineGroup(f, g);
  }
  // Refining can move two groups onto the same stretches: keep the one pooled first. And a run
  // that only matched weakly can shrink to a fragment of what its scale looks for: not a section.
  for (let i = pooled.length - 1; i >= 0; --i) {
    const g = pooled[i];
    if (g.starts.length < 2 || g.length < 0.6 * (shortest.get(g) ?? 0) || pooled.slice(0, i).some((p) => sameRepeat(p, g))) pooled.splice(i, 1);
  }
  // Equal-length groups whose occurrences sound alike are one group (e.g. a chorus phrase that
  // comes back in the final chorus).
  for (let i = 0; i < pooled.length; ++i) {
    for (let j = i + 1; j < pooled.length; ++j) {
      const a = pooled[i];
      const b = pooled[j];
      if (Math.abs(a.length - b.length) > 1) continue;
      const len = Math.min(a.length, b.length);
      let best = -1;
      for (const sa of a.starts) for (const sb of b.starts) best = Math.max(best, windowSimilarity(f, sa, sb, len));
      if (best < 0.9 * Math.min(a.score, b.score)) continue;
      for (const sb of b.starts) if (a.starts.every((sa) => Math.abs(sa - sb) >= len)) a.starts.push(sb);
      a.starts.sort((x, y) => x - y);
      a.length = len;
      a.score = Math.min(a.score, b.score);
      pooled.splice(j--, 1);
    }
  }
  resolveEdgeOverlaps(f, pooled, [...fixed, ...kept]);
  return confirmGroups(index, pooled, minConfidence, maxGroups, fixed, kept).sort((p, q) => p.starts[0] - q.starts[0] || q.length - p.length);
}

/**
 * Detection at every detail level at once, as one hierarchy: each level searches more widely
 * and fits around what the coarser levels found, which it may add occurrences to but never
 * changes otherwise. So going one level up only adds groups, and each group's `level` is the
 * first level that has it: showing a level is a cut-off, not a new detection.
 */
export function findLevels(f: BeatFeatures, fixed: RepeatGroup[] = []): RepeatGroup[] {
  const found: RepeatGroup[] = [];
  DETAIL_LEVELS.forEach((level, i) => {
    const maxGroups = level.maxGroups - found.length;
    if (maxGroups <= 0) return;
    for (const g of findHierarchy(f, i + 1, { fixed, kept: found, maxGroups })) found.push(Object.assign(g, { level: i + 1 }));
  });
  return found.sort((p, q) => p.starts[0] - q.starts[0] || q.length - p.length);
}

/**
 * Adds the occurrences of `g` that `p` lacks, lined up through an occurrence both have (refining
 * or the caller settles the last beat). Returns the starts that were added.
 */
function absorbGroup(f: BeatFeatures, p: RepeatGroup, g: RepeatGroup, offset?: number): number[] {
  const covers = (s: number, t: number) => overlap(s, s + g.length, t, t + p.length) >= 0.5 * Math.min(g.length, p.length);
  let d: number | null = offset ?? null;
  for (const s of g.starts) for (const t of p.starts) if (d === null && covers(s, t)) d = t - s;
  if (d === null) return [];
  const added: number[] = [];
  for (const s of g.starts) {
    const at = Math.min(f.beats - p.length, Math.max(0, s + d));
    if (p.starts.every((t) => overlap(at, at + p.length, t, t + p.length) < 0.5 * p.length)) {
      p.starts.push(at);
      added.push(at);
    }
  }
  p.starts.sort((x, y) => x - y);
  return added;
}

/**
 * How much better two stretches match at their exact offset than with the second shifted by 1–3
 * beats. A real repeat lines up on one beat (about 0.15 and up); music that keeps one sound or
 * texture matches about as well at any shift (near 0), however alike it sounds.
 */
export function alignedContrast(index: SimilarityIndex, a: number, b: number, len: number): number {
  const beats = index.f.beats;
  const w = (x: number, y: number) => index.window(Math.min(x, y), Math.max(x, y), len);
  let off = 0;
  let n = 0;
  for (const d of [-3, -2, -1, 1, 2, 3]) {
    const y = b + d;
    if (y < 0 || y + len > beats || y === a) continue;
    off += w(a, y);
    ++n;
  }
  return n && a !== b ? w(a, b) - off / n : 0;
}

/** Below this an occurrence does not line up with the rest of its group (see alignedContrast). */
const MIN_OCCURRENCE = 0.08;

/**
 * Keeps what the music clearly supports. Each group loses occurrences that do not line up with
 * the others and gets its confidence (how well its occurrences line up, on average) as score;
 * groups below `minConfidence` go. Then, surest and biggest first, groups may only nest (an
 * occurrence inside one at least 1.5 times as long) or touch: an occurrence partly overlapping
 * a stronger group's is dropped, and a group that is nearly the same as a stronger one (one of
 * its occurrences on top of one of the other's, similar length) is merged into it. At most
 * `maxGroups` new ones are kept. `fixed` groups (marked by hand) and `kept` ones (found at a
 * coarser level) count as stronger than all and only `kept` ones can gain occurrences: a group
 * that is nearly the same as a fixed one is dropped instead of merged. Returns the new groups.
 */
export function confirmGroups(
  index: SimilarityIndex,
  groups: RepeatGroup[],
  minConfidence: number,
  maxGroups: number,
  fixed: RepeatGroup[] = [],
  kept: RepeatGroup[] = [],
): RepeatGroup[] {
  const pair = (len: number, a: number, b: number) => (alignedContrast(index, a, b, len) + alignedContrast(index, b, a, len)) / 2;
  const fit = (g: RepeatGroup, s: number) => g.starts.reduce((sum, t) => (t === s ? sum : sum + pair(g.length, s, t)), 0) / (g.starts.length - 1);
  const prune = (g: RepeatGroup) => {
    while (g.starts.length >= 2) {
      const fits = g.starts.map((s) => fit(g, s));
      const sorted = [...fits].sort((x, y) => x - y);
      const worst = fits.indexOf(sorted[0]);
      // Far below the rest (or below the floor): it does not belong.
      if (sorted[0] >= Math.max(MIN_OCCURRENCE, 0.4 * sorted[Math.floor(sorted.length / 2)])) break;
      g.starts.splice(worst, 1);
    }
    g.score = g.starts.length >= 2 ? g.starts.reduce((t, s) => t + fit(g, s), 0) / g.starts.length : 0;
  };
  for (const g of groups) prune(g);
  const rank = (g: RepeatGroup) => g.score * g.length * g.starts.length;
  const candidates = groups.filter((g) => g.starts.length >= 2 && g.score >= minConfidence).sort((p, q) => rank(q) - rank(p));

  // Inside: sticking out by at most 15% of its length, and never more than a measure.
  const inside = (s: number, len: number, t: number, tlen: number) => overlap(s, s + len, t, t + tlen) >= len - Math.min(4, 0.15 * len);
  /** How an occurrence [x, x+len) relates to group p: fine (apart, touching or nested), the same stretch, or a clash. */
  const relation = (x: number, len: number, p: RepeatGroup): { kind: 'fine' } | { kind: 'same'; d: number } | { kind: 'clash' } => {
    const ratio = Math.max(len, p.length) / Math.min(len, p.length);
    for (const y of p.starts) {
      if (overlap(x, x + len, y, y + p.length) <= 2) continue;
      const nested = inside(x, len, y, p.length) || inside(y, p.length, x, len);
      if (nested && ratio >= 1.5) continue;
      return nested ? { kind: 'same', d: y - x } : { kind: 'clash' };
    }
    return { kind: 'fine' };
  };
  const given = fixed.length + kept.length;
  const accepted: RepeatGroup[] = [...fixed, ...kept];
  for (const g of candidates) {
    if (accepted.length - given >= maxGroups) break;
    let twin: { p: RepeatGroup; d: number } | null = null;
    const kept: number[] = [];
    for (const x of g.starts) {
      let ok = true;
      for (const p of accepted) {
        const r = relation(x, g.length, p);
        if (r.kind === 'same') twin ??= { p, d: r.d };
        if (r.kind === 'clash') ok = false;
      }
      if (ok) kept.push(x);
    }
    if (twin) {
      // The same section found twice: its other occurrences join the stronger group when they line
      // up with it and clash with nothing (groups marked by hand are not changed).
      const { p, d } = twin;
      if (fixed.includes(p)) continue;
      for (const at of absorbGroup(index.f, p, g, d)) {
        const clash = accepted.some((q) => q !== p && relation(at, p.length, q).kind !== 'fine');
        if (clash || fit(p, at) < MIN_OCCURRENCE) p.starts.splice(p.starts.indexOf(at), 1);
      }
      continue;
    }
    g.starts = kept;
    if (g.starts.length < 2) continue;
    prune(g);
    if (g.score >= minConfidence) accepted.push(g);
  }
  return accepted.slice(given);
}

/**
 * Each group's edges are tuned on their own, so the end of one section can run a few beats into
 * the start of the next when those beats sound like both. Split such shared beats where it fits
 * best: each side keeps the beats on which its own occurrences agree more. One occurrence inside
 * another is nesting and is left alone, and so are overlaps of more than a quarter of either.
 * `frozen` groups (marked by hand, or found at a coarser level) keep all the beats they share.
 */
export function resolveEdgeOverlaps(f: BeatFeatures, groups: RepeatGroup[], frozen: RepeatGroup[] = []): void {
  /** How alike a group's occurrences are `rel` beats after their starts. */
  const agree = (g: RepeatGroup, rel: number) => {
    let sum = 0;
    let n = 0;
    for (let p = 0; p < g.starts.length; ++p) {
      for (let q = p + 1; q < g.starts.length; ++q) {
        const a = g.starts[p] + rel;
        const b = g.starts[q] + rel;
        if (a < 0 || b < 0 || a >= f.beats || b >= f.beats) continue;
        sum += beatSimilarity(f, a, b);
        ++n;
      }
    }
    return n ? sum / n : 0;
  };
  const all = [...frozen, ...groups];
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of all) {
      for (const b of all) {
        if (a === b || (frozen.includes(a) && frozen.includes(b))) continue;
        // The most beats by which an occurrence of b starts inside an occurrence of a and runs on past its end.
        let k = 0;
        for (const sa of a.starts) {
          for (const sb of b.starts) if (sb > sa && sb < sa + a.length && sb + b.length > sa + a.length) k = Math.max(k, sa + a.length - sb);
        }
        if (!k || k > 0.25 * Math.min(a.length, b.length)) continue;
        // a keeps the first `keep` shared beats, b the rest.
        let keep = frozen.includes(a) ? k : 0;
        if (!frozen.includes(a) && !frozen.includes(b)) {
          const aAgree = Array.from({ length: k }, (_, i) => agree(a, a.length - k + i));
          const bAgree = Array.from({ length: k }, (_, i) => agree(b, i));
          let best = -Infinity;
          for (let m = 0; m <= k; ++m) {
            let score = 0;
            for (let i = 0; i < k; ++i) score += i < m ? aAgree[i] : bAgree[i];
            if (score > best) {
              best = score;
              keep = m;
            }
          }
        }
        a.length -= k - keep;
        b.starts = b.starts.map((s) => s + keep);
        b.length -= keep;
        changed = true;
      }
    }
  }
}

/**
 * Runs merged into one group can leave two occurrences on top of each other (a repeat that also
 * matches itself a few measures later). Keep the one that sounds more like the rest of the group.
 * Overlaps of up to `slack` beats are left alone.
 */
export function dropOverlaps(f: BeatFeatures, g: RepeatGroup, slack = 0): void {
  const fit = (s: number) => g.starts.reduce((sum, t) => (t === s ? sum : sum + windowSimilarity(f, Math.min(s, t), Math.max(s, t), g.length)), 0);
  g.starts.sort((x, y) => x - y);
  for (let k = 1; k < g.starts.length; ++k) {
    if (g.starts[k] - g.starts[k - 1] >= g.length - slack) continue;
    g.starts.splice(fit(g.starts[k]) > fit(g.starts[k - 1]) ? k - 1 : k, 1);
    --k;
  }
}

/**
 * Detection works on a grid of 2–4 beats and merges runs found at slightly different offsets, so
 * an occurrence can be a beat or two off and edges snap to that grid. This moves each occurrence
 * by up to ±3 beats to where it clearly sounds more like the others (and out of a neighbour it
 * overlaps), drops what still overlaps, then moves the start and end one beat at a time to where
 * the occurrences stop sounding alike.
 */
export function refineGroup(f: BeatFeatures, g: RepeatGroup): void {
  const GAIN = 0.03; // a shift must improve the match by this much (repeats often match themselves when shifted)
  const SHIFT = 3;
  const overlap = (k: number, s: number) =>
    g.starts.reduce((most, t, j) => (j === k ? most : Math.max(most, g.length - Math.abs(t - s))), 0);
  const fit = (k: number, s: number) =>
    g.starts.reduce((sum, t, j) => (j === k ? sum : sum + windowSimilarity(f, Math.min(s, t), Math.max(s, t), g.length)), 0) /
    (g.starts.length - 1);
  // Two passes, since moving one occurrence changes what the others are compared with.
  for (let pass = 0; pass < 2 && g.starts.length > 1; ++pass) {
    for (let k = 0; k < g.starts.length; ++k) {
      const s = g.starts[k];
      const before = overlap(k, s);
      let best = 0;
      let bestScore = fit(k, s) + GAIN;
      for (let d = -SHIFT; d <= SHIFT; ++d) {
        if (d === 0 || s + d < 0 || s + d + g.length > f.beats) continue;
        // Never move into a neighbour; moving out of one is worth a small loss in similarity.
        const o = overlap(k, s + d);
        if (o > 0 && o >= before) continue;
        const v = fit(k, s + d) + (o < before ? 2 * GAIN : 0);
        if (v > bestScore) {
          bestScore = v;
          best = d;
        }
      }
      g.starts[k] = s + best;
    }
  }
  dropOverlaps(f, g);
  const ref = g.starts[0];

  // Mean similarity across occurrences of beat i (relative to the start), and of a beat pair.
  const beatSim = (i: number) => {
    let sum = 0;
    let n = 0;
    for (let k = 1; k < g.starts.length; ++k) {
      const a = ref + i;
      const b = g.starts[k] + i;
      if (a < 0 || b < 0 || a >= f.beats || b >= f.beats) continue;
      sum += beatSimilarity(f, a, b);
      ++n;
    }
    return n ? sum / n : -1;
  };
  const pair = (i: number, j: number) => (beatSim(i) + beatSim(j)) / 2;
  const threshold = 0.6 * g.score;
  const room = (dir: number) => {
    // How far every occurrence can grow in this direction without touching another one.
    const sorted = [...g.starts].sort((x, y) => x - y);
    let r = SHIFT + 1;
    for (let k = 0; k < sorted.length; ++k) {
      const gap = dir < 0 ? sorted[k] - (k ? sorted[k - 1] + g.length : 0) : (k + 1 < sorted.length ? sorted[k + 1] : f.beats) - (sorted[k] + g.length);
      r = Math.min(r, gap);
    }
    return Math.max(0, r);
  };
  let start = 0;
  let end = g.length;
  // Grow outwards while the two beats just outside still sound alike, else trim the edge while
  // the two beats just inside do not.
  for (let r = room(-1); r > 0 && pair(start - 1, start - 2) >= threshold; --r) --start;
  if (start === 0) while (end - start > 4 && pair(start, start + 1) < threshold) ++start;
  for (let r = room(1); r > 0 && pair(end, end + 1) >= threshold; --r) ++end;
  if (end === g.length) while (end - start > 4 && pair(end - 1, end - 2) < threshold) --end;
  g.starts = g.starts.map((s) => s + start).sort((x, y) => x - y);
  g.length = end - start;
}
