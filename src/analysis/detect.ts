// Main-thread wrappers: mix the music to mono and run the analyses in workers.

import type { TempoEstimate } from './findTempo';
import type { OnsetData } from './onsets';
import type { BeatFeatures, RepeatGroup } from './structure';

function mono(buffer: AudioBuffer): Float32Array {
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

export function analyzeOnsets(buffer: AudioBuffer): Promise<OnsetData> {
  const worker = new Worker(new URL('./onsetWorker.ts', import.meta.url), { type: 'module' });
  return runWorker(worker, buffer, (d) => d.data as OnsetData);
}

type StructureResult = { features: BeatFeatures; groups: RepeatGroup[] };

/**
 * Beat-level features and automatically found repeats at a detail level (see DETAIL_LEVELS), for
 * the given beat times (seconds), fitted around the `fixed` groups (marked by hand, in beats).
 * With `features` from an earlier run on the same beat grid, only the search runs again.
 */
export function analyzeStructure(
  buffer: AudioBuffer,
  beatTimes: Float64Array,
  onsets: OnsetData,
  options: { detail: number; fixed: RepeatGroup[]; features?: BeatFeatures },
): Promise<StructureResult> {
  const worker = new Worker(new URL('./structureWorker.ts', import.meta.url), { type: 'module' });
  const pick = (d: Record<string, unknown>) => d.result as StructureResult;
  const { detail, fixed, features } = options;
  if (features) return post(worker, { features, detail, fixed }, [], pick);
  return runWorker(worker, buffer, pick, { beatTimes, onsets, detail, fixed });
}
