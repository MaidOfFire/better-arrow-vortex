// Estimates the BPM and the first beat of a piece of music from its onset envelope.
//
// 1. Spectral flux on a log-magnitude spectrogram gives an onset strength curve.
// 2. Autocorrelation of that curve over 60..300 BPM finds coarse tempo candidates.
// 3. Each candidate is refined by folding the curve at the beat period and measuring how
//    concentrated the onsets are in phase; the best phase gives the beat offset.

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

  // Fine: fold at the beat period around each candidate.
  const refined: { bpm: number; score: number; phase: number }[] = [];
  for (const p of peaks) {
    let best = { bpm: p.bpm, score: -Infinity, phase: 0 };
    for (let bpm = p.bpm - 0.6; bpm <= p.bpm + 0.6; bpm += 0.02) {
      const r = foldScore(env, (60 / bpm) * fps);
      if (r.score > best.score) best = { bpm, ...r };
    }
    const center = best.bpm;
    for (let bpm = center - 0.03; bpm <= center + 0.03; bpm += 0.002) {
      const r = foldScore(env, (60 / bpm) * fps);
      if (r.score > best.score) best = { bpm, ...r };
    }
    refined.push(best);
  }
  refined.sort((a, b) => b.score - a.score);
  // Remove near-duplicates.
  const unique: typeof refined = [];
  for (const r of refined) if (!unique.some((u) => Math.abs(u.bpm - r.bpm) < 0.1)) unique.push(r);
  // Most simfiles use whole-number BPMs: offer the rounded tempo next to a near-integer estimate.
  for (let i = 0; i < unique.length; ++i) {
    const r = unique[i];
    const rounded = Math.round(r.bpm);
    if (Math.abs(r.bpm - rounded) < 0.15 && Math.abs(r.bpm - rounded) > 0.0005 && !unique.some((u) => u.bpm === rounded)) {
      unique.splice(i + 1, 0, { bpm: rounded, ...foldScore(env, (60 / rounded) * fps) });
      ++i;
    }
  }
  const top = Math.max(...unique.map((u) => u.score)) || 1;
  // Flux peaks once the attack is well inside the window; calibrated on synthetic clicks.
  const frameDelay = (0.71 * FRAME) / (fps * HOP);
  return unique.map((r) => {
    const period = 60 / r.bpm;
    let beatTime = r.phase / fps + frameDelay;
    beatTime = ((beatTime % period) + period) % period;
    return { bpm: Math.round(r.bpm * 1000) / 1000, fitness: Math.max(0, r.score / top), beatTime };
  });
}
