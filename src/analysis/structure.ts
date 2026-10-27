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
export function findRepeats(f: BeatFeatures, window = 16, step = 4, minLength = 32, maxGroups = 16, maxLength = Infinity): RepeatGroup[] {
  const starts: number[] = [];
  for (let i = 0; i + window <= f.beats; i += step) starts.push(i);
  const pairs: { a: number; b: number; s: number }[] = [];
  for (let i = 0; i < starts.length; ++i) {
    for (let j = i + 1; j < starts.length; ++j) {
      if (starts[j] < starts[i] + window) continue;
      pairs.push({ a: starts[i], b: starts[j], s: windowSimilarity(f, starts[i], starts[j], window) });
    }
  }
  if (!pairs.length) return [];
  const sorted = pairs.map((p) => p.s).sort((x, y) => x - y);
  // Strong pairs: the top 1%, but never stricter than 0.8 (when repeats are most of that top 1%,
  // the percentile would land on their own score and cut them apart).
  const threshold = Math.max(0.3, Math.min(0.8, sorted[Math.floor(sorted.length * 0.99)]));

  // Runs of strong windows along each lag.
  const byLag = new Map<number, { a: number; s: number }[]>();
  for (const p of pairs) {
    if (p.s < threshold) continue;
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
      // (measures) at both ends that do not match on their own.
      let a = seg[0].a;
      let end = seg[seg.length - 1].a + window;
      while (end - a > step && windowSimilarity(f, a, a + lag, step) < threshold) a += step;
      while (end - a > step && windowSimilarity(f, end - step, end - step + lag, step) < threshold) end -= step;
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
  // Drop groups that mostly repeat what stronger groups (found earlier) already cover.
  const covered = new Uint8Array(f.beats);
  const kept: RepeatGroup[] = [];
  for (const g of groups) {
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
    for (const s of g.starts) covered.fill(1, s, Math.min(f.beats, s + g.length));
  }
  return kept.sort((p, q) => p.starts[0] - q.starts[0]);
}

/**
 * Repeats at three scales, pooled so that groups can nest: whole sections, then parts of up to
 * 8 measures, then figures of up to 4 measures. The finer scales are capped in length, so they
 * find what repeats inside sections instead of finding the sections again. A finer group that
 * describes the same stretches as one already found (similar length, mostly the same beats) is
 * dropped. The nesting itself is derived later from which occurrences contain which.
 */
export function findHierarchy(f: BeatFeatures, maxGroups = 24): RepeatGroup[] {
  const scales = [
    findRepeats(f, 16, 4, 32, 16),
    findRepeats(f, 8, 4, 16, 16, 32),
    findRepeats(f, 4, 2, 8, 16, 16),
  ];
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
      if (pooled.length >= maxGroups) break;
      if (!pooled.some((p) => sameRepeat(p, g))) pooled.push(g);
    }
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
  return pooled.sort((p, q) => p.starts[0] - q.starts[0] || q.length - p.length);
}
