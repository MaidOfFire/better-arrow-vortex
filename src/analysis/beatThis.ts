// Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024; github.com/CPJKU/beat_this, MIT): a neural
// beat and downbeat tracker. This file is the part around the network, ported from its Python
// inference code: the log-mel spectrogram it reads, the 30-second chunks it runs on, and the
// peak picking that turns its frame-wise scores into beat times. The network itself (the
// "small0" model, exported to ONNX) runs in beatThisWorker.ts.

import { fft } from './fft';

/** The network's input: 22050 Hz audio, 50 spectrogram frames a second, 128 mel bands. */
export const BT_RATE = 22050;
export const BT_FPS = 50;
export const BT_MELS = 128;
/** Frames per network run (30 s), and frames discarded at each edge of a run. */
export const BT_CHUNK = 1500;
const BORDER = 6;

const N_FFT = 1024;
const HOP = 441;

// Slaney mel scale (as torchaudio's mel_scale="slaney"): linear below 1 kHz, logarithmic above.
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;
const hzToMel = (f: number) => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP : f / F_SP);
const melToHz = (m: number) => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : F_SP * m);

/** Triangular mel filters between 30 Hz and 11 kHz, unnormalised (torchaudio's melscale_fbanks). */
function melFilters(): Float32Array[] {
  const nFreqs = N_FFT / 2 + 1;
  const freqs = Array.from({ length: nFreqs }, (_, k) => (k * Math.floor(BT_RATE / 2)) / (nFreqs - 1));
  const mMin = hzToMel(30);
  const mMax = hzToMel(11000);
  const pts = Array.from({ length: BT_MELS + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (BT_MELS + 1)));
  return Array.from({ length: BT_MELS }, (_, m) => {
    const w = new Float32Array(nFreqs);
    for (let k = 0; k < nFreqs; ++k) {
      const down = (freqs[k] - pts[m]) / (pts[m + 1] - pts[m]);
      const up = (pts[m + 2] - freqs[k]) / (pts[m + 2] - pts[m + 1]);
      w[k] = Math.max(0, Math.min(down, up));
    }
    return w;
  });
}

/**
 * log(1 + 1000 · mel magnitude) of 22050 Hz mono audio, frames × 128 (row-major). Frame i is
 * centred on sample 441 i (the signal is reflect-padded by half a window at both ends).
 */
export function logMelSpectrogram(x: Float32Array): { data: Float32Array; frames: number } {
  const pad = N_FFT / 2;
  const frames = 1 + Math.floor(x.length / HOP);
  const at = (i: number) => {
    // Reflect padding (no edge repeat), as torch.stft(center=True, pad_mode="reflect").
    if (i < 0) i = -i;
    if (i >= x.length) i = 2 * (x.length - 1) - i;
    return x[Math.min(x.length - 1, Math.max(0, i))];
  };
  const window = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; ++i) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); // periodic Hann
  // normalized="frame_length": torch.stft's own normalisation, by the square root of the FFT size.
  const norm = Math.sqrt(N_FFT);
  const filters = melFilters();
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  const mag = new Float32Array(N_FFT / 2 + 1);
  const data = new Float32Array(frames * BT_MELS);
  for (let f = 0; f < frames; ++f) {
    const start = f * HOP - pad;
    for (let i = 0; i < N_FFT; ++i) {
      re[i] = at(start + i) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N_FFT / 2; ++k) mag[k] = Math.hypot(re[k], im[k]) / norm;
    for (let m = 0; m < BT_MELS; ++m) {
      const w = filters[m];
      let s = 0;
      for (let k = 0; k < w.length; ++k) if (w[k]) s += w[k] * mag[k];
      data[f * BT_MELS + m] = Math.log1p(1000 * s);
    }
  }
  return { data, frames };
}

/** Start frames of the network runs over a piece (beat_this's split_piece, avoiding a short last run). */
export function chunkStarts(frames: number): number[] {
  const starts: number[] = [];
  for (let s = -BORDER; s < frames - BORDER; s += BT_CHUNK - 2 * BORDER) starts.push(s);
  if (frames > BT_CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (BT_CHUNK - BORDER);
  return starts;
}

/** One network input of BT_CHUNK frames from `start` (zero where it runs past the piece). */
export function chunkInput(spect: Float32Array, frames: number, start: number): Float32Array {
  const out = new Float32Array(BT_CHUNK * BT_MELS);
  const from = Math.max(0, start);
  const to = Math.min(frames, start + BT_CHUNK);
  out.set(spect.subarray(from * BT_MELS, to * BT_MELS), (from - start) * BT_MELS);
  return out;
}

/**
 * Frame-wise scores for the piece from the runs' outputs, dropping each run's borders and, where
 * runs overlap, keeping the earlier run's scores (overlap_mode="keep_first").
 */
export function aggregate(frames: number, starts: number[], runs: Float32Array[]): Float32Array {
  const out = new Float32Array(frames).fill(-1000);
  for (let r = runs.length - 1; r >= 0; --r) {
    const start = starts[r];
    for (let i = BORDER; i < BT_CHUNK - BORDER; ++i) {
      const f = start + i;
      if (f >= 0 && f < frames) out[f] = runs[r][i];
    }
  }
  return out;
}

/** Frames that are the highest within ±3 frames (±60 ms) and above even odds (score > 0). */
function peakFrames(scores: Float32Array): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < scores.length; ++i) {
    if (scores[i] <= 0) continue;
    let max = -Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(scores.length - 1, i + 3); ++j) max = Math.max(max, scores[j]);
    if (scores[i] === max) peaks.push(i);
  }
  // Neighbouring peaks (a plateau) become one, at their running mean (as beat_this does it).
  const out: number[] = [];
  let p = peaks[0];
  let c = 1;
  for (let k = 1; k < peaks.length; ++k) {
    if (peaks[k] - p <= 1) {
      ++c;
      p += (peaks[k] - p) / c;
    } else {
      out.push(p);
      [p, c] = [peaks[k], 1];
    }
  }
  if (peaks.length) out.push(p);
  return out;
}

/** Beat and downbeat times (seconds) from frame-wise scores; downbeats are moved onto the nearest beat. */
export function pickBeats(beatScores: Float32Array, downbeatScores: Float32Array): { beats: number[]; downbeats: number[] } {
  const beats = peakFrames(beatScores).map((f) => f / BT_FPS);
  const downbeats = new Set<number>();
  for (const f of peakFrames(downbeatScores)) {
    const t = f / BT_FPS;
    let best = beats[0];
    for (const b of beats) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
    if (best !== undefined) downbeats.add(best);
  }
  return { beats, downbeats: [...downbeats].sort((a, b) => a - b) };
}
