// Estimates the BPM and the first beat of a piece of music.
//
// 1. Spectral flux on a log-magnitude spectrogram gives a smooth onset strength curve, and its
//    autocorrelation over 60..300 BPM finds coarse tempo candidates.
// 2. A sharp onset curve (short windows, timed at their centres) refines each candidate: the
//    tempo at which its attacks pile up most tightly on one phase of the beat.
// 3. The beat sits where they pile up (plus a small calibration), or half a beat later when the
//    music gets louder there (as ArrowVortex decides between beat and off-beat).
//
// Checked against 21 charts with known timing (a jumpstream pack synced for Etterna, THE END
// OF THE LINE): most land within a few milliseconds of the charted beat.

import { fft } from './fft';

export interface TempoEstimate {
  bpm: number;
  /** 0..1, relative to the best estimate. */
  fitness: number;
  /** Time in seconds of a beat (the first one at or after 0). */
  beatTime: number;
}

const FRAME = 1024;
const HOP = 256;

export function onsetEnvelope(samples: Float32Array, sampleRate: number): { env: Float32Array; fps: number } {
  // Resample to ~22 kHz by skipping samples when the rate is high; flux is robust to this.
  const step = sampleRate > 32000 ? 2 : 1;
  const rate = sampleRate / step;
  const n = Math.floor(samples.length / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; ++i) x[i] = samples[i * step];

  const frames = Math.max(0, Math.floor((n - FRAME) / HOP));
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; ++i) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const bins = FRAME / 2;
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; ++f) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; ++i) {
      re[i] = x[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < bins; ++k) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  // Remove the slowly varying part and keep positive peaks.
  const fps = rate / HOP;
  const win = Math.max(1, Math.round(fps * 0.4));
  const out = new Float32Array(frames);
  let sum = 0;
  for (let i = 0; i < frames; ++i) {
    sum += env[i];
    if (i >= win) sum -= env[i - win];
    const mean = sum / Math.min(i + 1, win);
    out[i] = Math.max(0, env[i] - mean);
  }
  return { env: out, fps };
}

function interp(a: Float32Array, t: number): number {
  const i = Math.floor(t);
  if (i < 0 || i + 1 >= a.length) return 0;
  const f = t - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

/**
 * How well onsets line up when folded at `period` frames: the length of the onset-weighted mean
 * phase vector (1 = every onset on the same phase). Also returns that mean phase in frames.
 */
function foldScore(env: Float32Array, period: number): { score: number; phase: number } {
  const w = (2 * Math.PI) / period;
  let c = 0;
  let s = 0;
  let total = 0;
  for (let i = 0; i < env.length; ++i) {
    const v = env[i];
    if (v === 0) continue;
    c += v * Math.cos(w * i);
    s += v * Math.sin(w * i);
    total += v;
  }
  const angle = Math.atan2(s, c);
  const phase = ((angle / (2 * Math.PI)) * period + period) % period;
  return { score: Math.hypot(c, s) / (total || 1), phase };
}

export function findTempo(samples: Float32Array, sampleRate: number, minBpm = 60, maxBpm = 300): TempoEstimate[] {
  const { env, fps } = onsetEnvelope(samples, sampleRate);
  if (env.length < fps * 4) return [];

  // Coarse: autocorrelation per BPM.
  const coarse: { bpm: number; score: number }[] = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = 0; i + lag * 2 < env.length; i += 1) {
      const v = env[i];
      if (v === 0) continue;
      s += v * (interp(env, i + lag) + 0.5 * interp(env, i + lag * 2));
    }
    coarse.push({ bpm, score: s });
  }
  const peaks = coarse
    .filter((c, i) => (i === 0 || c.score >= coarse[i - 1].score) && (i === coarse.length - 1 || c.score >= coarse[i + 1].score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Fine: the tempo near each candidate at which the sharp onsets line up best. The first three
  // minutes pin the tempo to a few thousandths of a BPM, and the start is where the offset counts.
  const head = samples.subarray(0, Math.min(samples.length, Math.round(sampleRate * 180)));
  const sharp = sharpOnsets(head, sampleRate);
  const rise = loudnessRise(head, sampleRate);
  const refined = peaks.slice(0, 4).map((p) => {
    const bpm = refineTempo(sharp, p.bpm);
    return { bpm, score: foldScore(env, (60 / bpm) * fps).score };
  });
  refined.sort((a, b) => b.score - a.score);
  // Remove near-duplicates.
  const unique: typeof refined = [];
  for (const r of refined) if (!unique.some((u) => Math.abs(u.bpm - r.bpm) < 0.1)) unique.push(r);
  // Most simfiles use whole-number BPMs: offer the rounded tempo next to a near-integer estimate.
  for (let i = 0; i < unique.length; ++i) {
    const r = unique[i];
    const rounded = Math.round(r.bpm);
    if (Math.abs(r.bpm - rounded) < 0.15 && Math.abs(r.bpm - rounded) > 0.0005 && !unique.some((u) => u.bpm === rounded)) {
      unique.splice(i + 1, 0, { bpm: rounded, score: foldScore(env, (60 / rounded) * fps).score });
      ++i;
    }
  }
  const top = Math.max(...unique.map((u) => u.score)) || 1;
  return unique.map((r) => {
    const bpm = Math.round(r.bpm * 1000) / 1000;
    return { bpm, fitness: Math.max(0, r.score / top), beatTime: beatPhase(sharp, rise, 60 / bpm) };
  });
}

/** An onset curve sampled at `start + i * step` seconds. */
interface Curve {
  env: Float32Array;
  start: number;
  step: number;
}

/**
 * Onset strength for timing: log spectral flux over ~12 ms windows every ~1.5 ms, each value
 * placed at its window's centre. Too fine to find a tempo with, but it puts attacks within a
 * few milliseconds of where charts put the beat.
 */
export function sharpOnsets(samples: Float32Array, sampleRate: number): Curve {
  const step = sampleRate > 32000 ? 2 : 1;
  const rate = sampleRate / step;
  const N = 256;
  const H = 32;
  const frames = Math.max(0, Math.floor((Math.floor(samples.length / step) - N) / H));
  const window = new Float32Array(N);
  for (let i = 0; i < N; ++i) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let prev = new Float32Array(N / 2);
  let cur = new Float32Array(N / 2);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; ++f) {
    const off = f * H * step;
    for (let i = 0; i < N; ++i) {
      let v = 0;
      for (let k = 0; k < step; ++k) v += samples[off + i * step + k];
      re[i] = (v / step) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < N / 2; ++k) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      if (mag > prev[k]) flux += mag - prev[k];
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  return { env, start: N / 2 / rate, step: H / rate };
}

/**
 * How much louder the next 50 ms are than the last 50 ms, every ~1 ms (ArrowVortex's "slopes"):
 * high where drums hit, which tells the beat from the off-beat better than spectral flux does
 * (in fast metal the hi-hats and snares between beats have the sharper attacks).
 */
function loudnessRise(samples: Float32Array, sampleRate: number): Curve {
  const half = Math.round(sampleRate / 20);
  const hop = Math.max(1, Math.round(sampleRate / 1000));
  const sum = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; ++i) sum[i + 1] = sum[i] + Math.abs(samples[i]);
  const n = Math.max(0, Math.floor((samples.length - 2 * half) / hop));
  const env = new Float32Array(n);
  for (let j = 0; j < n; ++j) {
    const i = half + j * hop;
    env[j] = Math.max(0, (sum[i + half] - 2 * sum[i] + sum[i - half]) / half);
  }
  return { env, start: half / sampleRate, step: hop / sampleRate };
}

/** Sum of a curve at t0, t0 + period, t0 + 2 period, ... (linearly interpolated). */
function sumAtBeats(c: Curve, t0: number, period: number): number {
  const end = c.start + (c.env.length - 1) * c.step;
  let s = 0;
  for (let t = t0; t < end; t += period) {
    const p = (t - c.start) / c.step;
    const i = Math.floor(p);
    if (i >= 0) s += c.env[i] + (c.env[i + 1] - c.env[i]) * (p - i);
  }
  return s;
}

/**
 * A curve folded at `period` seconds into 1 ms phase bins: the mean value at each phase, lightly
 * smoothed. A mean, not a sum: at periods that are a whole number of samples of the curve, its
 * samples keep landing in the same bins and sums there would look like a strong beat.
 */
function fold(c: Curve, period: number, stride = 1): Float64Array {
  const bins = Math.max(3, Math.round(period * 1000));
  const sum = new Float64Array(bins);
  const count = new Float64Array(bins);
  for (let i = 0; i < c.env.length; i += stride) {
    const t = c.start + i * c.step;
    const b = Math.floor(((t % period) / period) * bins) % bins;
    sum[b] += c.env[i];
    ++count[b];
  }
  const out = new Float64Array(bins);
  for (let b = 0; b < bins; ++b) {
    const l = (b + bins - 1) % bins;
    const r = (b + 1) % bins;
    const n = count[l] + 2 * count[b] + count[r];
    out[b] = n ? (sum[l] + 2 * sum[b] + sum[r]) / n : 0;
  }
  return out;
}

/**
 * The tempo within ±1.5 BPM of `bpm` (the coarse estimate can be a whole BPM off) at which the
 * onsets pile up most on one phase of the beat. That peak is narrow: a twentieth of a BPM off,
 * the beats have drifted apart over a few minutes.
 */
function refineTempo(c: Curve, bpm: number): number {
  const tightness = (b: number, stride: number) => Math.max(...fold(c, 60 / b, stride));
  let best = bpm;
  let bestV = -Infinity;
  for (let k = -150; k <= 150; ++k) {
    const b = bpm + k * 0.01;
    const v = tightness(b, 2);
    if (v > bestV) [best, bestV] = [b, v];
  }
  const center = best;
  bestV = -Infinity;
  for (let b = center - 0.012; b <= center + 0.012; b += 0.0005) {
    const v = tightness(b, 1);
    if (v > bestV) [best, bestV] = [b, v];
  }
  return best;
}

/** Charts put the beat this long after the peak of the sharp onset curve (median over 29 songs). */
const BEAT_AFTER_ONSET_PEAK = 0.0015;

/** Time of the first beat at or after 0 for a beat period (seconds). */
function beatPhase(sharp: Curve, rise: Curve, period: number): number {
  const h = fold(sharp, period);
  let bin = 0;
  for (let b = 1; b < h.length; ++b) if (h[b] > h[bin]) bin = b;
  // To a tenth of a millisecond around the best bin.
  let t0 = ((bin + 0.5) / h.length) * period;
  let best = -Infinity;
  const center = t0;
  for (let d = -0.0015; d <= 0.0015; d += 0.0001) {
    const v = sumAtBeats(sharp, center + d, period);
    if (v > best) [t0, best] = [center + d, v];
  }
  t0 += BEAT_AFTER_ONSET_PEAK;
  // The sharpest attacks can fall between beats (fast hi-hats and snares): take the half of the
  // beat where the music gets louder. A slow estimate is likely half the chart's tempo, so its
  // quarters are the chart's half beats and are tested too.
  const shifts = period > 0.4 ? 4 : 2;
  let bestRise = -Infinity;
  let beat = t0;
  for (let q = 0; q < shifts; ++q) {
    const t = (t0 + (q * period) / shifts) % period;
    const v = sumAtBeats(rise, t, period);
    if (v > bestRise) [beat, bestRise] = [t, v];
  }
  return ((beat % period) + period) % period;
}
