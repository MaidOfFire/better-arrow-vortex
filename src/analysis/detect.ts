// Main-thread wrappers: mix the music to mono and run the analyses in workers.

import { BT_RATE } from './beatThis';
import type { TempoEstimate } from './findTempo';
import type { OnsetData } from './onsets';
import type { BeatFeatures, RepeatGroup } from './structure';

function mono(buffer: AudioBuffer): Float32Array<ArrayBuffer> {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ++ch) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; ++i) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

function runWorker<T>(worker: Worker, buffer: AudioBuffer, pick: (data: Record<string, unknown>) => T, extra: Record<string, unknown> = {}): Promise<T> {
  const samples = mono(buffer);
  return post(worker, { samples, sampleRate: buffer.sampleRate, ...extra }, [samples.buffer], pick);
}

function post<T>(worker: Worker, message: Record<string, unknown>, transfer: Transferable[], pick: (data: Record<string, unknown>) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
      worker.terminate();
      if (e.data.error) reject(new Error(String(e.data.error)));
      else resolve(pick(e.data));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(message, transfer);
  });
}

export function detectTempo(buffer: AudioBuffer): Promise<TempoEstimate[]> {
  const worker = new Worker(new URL('./tempoWorker.ts', import.meta.url), { type: 'module' });
  return runWorker(worker, buffer, (d) => (d.estimates as TempoEstimate[]) ?? []);
}

/**
 * BPM estimates from Beat This!, a neural beat tracker: it tells the beat from the off-beat and
 * finds where bars start, so beat 0 lands on a downbeat. The ~10 MB model is downloaded on first
 * use (then cached by the browser). It reads the first two minutes: plenty for one tempo and
 * offset, and the network is slow without threads (a static host cannot enable them).
 * `onProgress` gets the share analyzed.
 */
export async function detectTempoBeatThis(buffer: AudioBuffer, onProgress?: (done: number) => void): Promise<TempoEstimate[]> {
  const all = mono(buffer);
  const samples = await resample(all.slice(0, Math.min(all.length, Math.round(buffer.sampleRate * 120))), buffer.sampleRate, BT_RATE);
  const worker = new Worker(new URL('./beatThisWorker.ts', import.meta.url), { type: 'module' });
  const modelUrl = new URL('models/beat_this_small0.onnx', document.baseURI).href;
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ progress?: number; result?: { estimates: TempoEstimate[] }; error?: string }>) => {
      if (e.data.progress !== undefined) return onProgress?.(e.data.progress);
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result?.estimates ?? []);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ samples, modelUrl }, [samples.buffer]);
  });
}

/** Resamples with the browser's own (band-limited) resampler. */
async function resample(x: Float32Array<ArrayBuffer>, from: number, to: number): Promise<Float32Array> {
  if (from === to) return x;
  const ctx = new OfflineAudioContext(1, Math.ceil((x.length * to) / from), to);
  const buf = ctx.createBuffer(1, x.length, from);
  buf.copyToChannel(x, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

export function analyzeOnsets(buffer: AudioBuffer): Promise<OnsetData> {
  const worker = new Worker(new URL('./onsetWorker.ts', import.meta.url), { type: 'module' });
  return runWorker(worker, buffer, (d) => d.data as OnsetData);
}

type StructureResult = { features: BeatFeatures; groups: RepeatGroup[] };

/**
 * Beat-level features and automatically found repeats for every detail level (each group has the
 * first level that shows it, see findLevels), for the given beat times (seconds), fitted around
 * the `fixed` groups (marked by hand, in beats). With `features` from an earlier run on the same
 * beat grid, only the search runs again.
 */
export function analyzeStructure(
  buffer: AudioBuffer,
  beatTimes: Float64Array,
  onsets: OnsetData,
  options: { fixed: RepeatGroup[]; features?: BeatFeatures },
): Promise<StructureResult> {
  const worker = new Worker(new URL('./structureWorker.ts', import.meta.url), { type: 'module' });
  const pick = (d: Record<string, unknown>) => d.result as StructureResult;
  const { fixed, features } = options;
  if (features) return post(worker, { features, fixed }, [], pick);
  return runWorker(worker, buffer, pick, { beatTimes, onsets, fixed });
}
