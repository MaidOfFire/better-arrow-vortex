// Onset strength in three frequency bands, for drawing where the music has attacks.
//
// A log-frequency spectrogram (96 bands, 30 Hz - 11 kHz) is computed every 128 samples at
// ~22 kHz (5.8 ms). For each band group the positive change in log energy (spectral flux) is
// summed, then normalised against its surroundings (1 s window) so quiet and loud passages read
// the same. On a dense metal chart the high band matched note placement far better than the
// waveform envelope did (AUC 0.78 vs 0.5-0.58).

import { fft } from './fft';

export const ONSET_BANDS = [
  { name: 'low', lo: 30, hi: 400 },
  { name: 'mid', lo: 400, hi: 2000 },
  { name: 'high', lo: 2000, hi: 11000 },
] as const;

export interface OnsetData {
  /** Frames per second. */
  fps: number;
  /** Time in seconds of frame 0. */
  start: number;
  /** One curve per ONSET_BANDS entry, values 0..1. */
  bands: Float32Array[];
}

const NFFT = 512;
const HOP = 128;
const NUM_FILTERS = 96;

export function computeOnsets(samples: Float32Array, sampleRate: number): OnsetData {
  // Halve high sample rates by averaging pairs (cheap anti-aliasing).
  const step = sampleRate > 32000 ? 2 : 1;
  const rate = sampleRate / step;
  const n = Math.floor(samples.length / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; ++i) {
    let v = 0;
    for (let k = 0; k < step; ++k) v += samples[i * step + k];
    x[i] = v / step;
  }

  // Triangular filters on a log-frequency axis.
  const bins = NFFT / 2 + 1;
  const edges: number[] = [];
  for (let i = 0; i < NUM_FILTERS + 2; ++i) edges.push(30 * Math.pow(11000 / 30, i / (NUM_FILTERS + 1)));
  const filters: { bins: number[]; weights: number[]; center: number }[] = [];
  for (let b = 0; b < NUM_FILTERS; ++b) {
    const [lo, c, hi] = [edges[b], edges[b + 1], edges[b + 2]];
    const f = { bins: [] as number[], weights: [] as number[], center: c };
    for (let k = 0; k < bins; ++k) {
      const hz = (k * rate) / NFFT;
      const w = Math.min((hz - lo) / (c - lo), (hi - hz) / (hi - c));
      if (w > 0) {
        f.bins.push(k);
        f.weights.push(w);
      }
    }
    if (!f.bins.length) {
      f.bins.push(Math.min(bins - 1, Math.round((c * NFFT) / rate)));
      f.weights.push(1);
    }
    filters.push(f);
  }
  const groupOf = filters.map((f) => ONSET_BANDS.findIndex((g) => f.center >= g.lo && f.center < g.hi));

  const frames = Math.max(0, Math.floor((n - NFFT) / HOP) + 1);
  const window = new Float32Array(NFFT);
  for (let i = 0; i < NFFT; ++i) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1));
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);
  const mag = new Float32Array(bins);
  let prev = new Float32Array(NUM_FILTERS);
  let cur = new Float32Array(NUM_FILTERS);
  const flux = ONSET_BANDS.map(() => new Float32Array(frames));
  for (let f = 0; f < frames; ++f) {
    const off = f * HOP;
    for (let i = 0; i < NFFT; ++i) {
      re[i] = x[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; ++k) mag[k] = Math.hypot(re[k], im[k]);
    for (let b = 0; b < NUM_FILTERS; ++b) {
      const fl = filters[b];
      let e = 0;
      for (let j = 0; j < fl.bins.length; ++j) e += mag[fl.bins[j]] * fl.weights[j];
      cur[b] = Math.log1p(100 * e);
      const g = groupOf[b];
      if (f > 0 && g >= 0) {
        const d = cur[b] - prev[b];
        if (d > 0) flux[g][f] += d;
      }
    }
    [prev, cur] = [cur, prev];
  }

  const fps = rate / HOP;
  return { fps, start: NFFT / 2 / rate, bands: flux.map((c) => normalize(c, Math.round(fps))) };
}

/** Local z-score over a sliding window, mapped so that z = 0.5 .. 4 becomes 0 .. 1. */
function normalize(c: Float32Array, win: number): Float32Array {
  const n = c.length;
  let gsum = 0;
  let gsq = 0;
  for (let i = 0; i < n; ++i) {
    gsum += c[i];
    gsq += c[i] * c[i];
  }
  const gsd = Math.sqrt(Math.max(0, gsq / Math.max(1, n) - (gsum / Math.max(1, n)) ** 2));
  const floor = 0.25 * gsd + 1e-6; // keeps silence from being amplified into noise
  const out = new Float32Array(n);
  const half = Math.floor(win / 2);
  let sum = 0;
  let sq = 0;
  let lo = 0;
  let hi = 0; // window is [lo, hi)
  for (let i = 0; i < n; ++i) {
    while (hi < Math.min(n, i + half + 1)) {
      sum += c[hi];
      sq += c[hi] * c[hi];
      ++hi;
    }
    while (lo < i - half) {
      sum -= c[lo];
      sq -= c[lo] * c[lo];
      ++lo;
    }
    const count = hi - lo;
    const mean = sum / count;
    const sd = Math.max(floor, Math.sqrt(Math.max(0, sq / count - mean * mean)));
    const z = (c[i] - mean) / sd;
    out[i] = Math.min(1, Math.max(0, (z - 0.5) / 3.5));
  }
  return out;
}

/** Largest value of a curve between two song times (or the interpolated value inside one frame). */
export function onsetAt(data: OnsetData, band: number, t0: number, t1: number): number {
  const c = data.bands[band];
  let a = (Math.min(t0, t1) - data.start) * data.fps;
  let b = (Math.max(t0, t1) - data.start) * data.fps;
  if (b < 0 || a > c.length - 1) return 0;
  if (b - a < 1) {
    const m = (a + b) / 2;
    const i = Math.floor(m);
    if (i < 0 || i + 1 >= c.length) return 0;
    const f = m - i;
    return c[i] * (1 - f) + c[i + 1] * f;
  }
  a = Math.max(0, Math.ceil(a));
  b = Math.min(c.length - 1, Math.floor(b));
  let max = 0;
  for (let i = a; i <= b; ++i) if (c[i] > max) max = c[i];
  return max;
}
