// Runs the section analysis off the main thread. Features already computed for the same beat
// grid can be passed in, so changing the detail level only reruns the search.

import type { OnsetData } from './onsets';
import { computeBeatFeatures, findHierarchy, type BeatFeatures } from './structure';

interface Request {
  samples?: Float32Array;
  sampleRate?: number;
  beatTimes?: Float64Array;
  onsets?: OnsetData;
  features?: BeatFeatures;
  detail: number;
}

self.onmessage = (e: MessageEvent<Request>) => {
  try {
    const { samples, sampleRate, beatTimes, onsets, detail } = e.data;
    const features = e.data.features ?? computeBeatFeatures(samples!, sampleRate!, beatTimes!, onsets!);
    const groups = findHierarchy(features, detail);
    self.postMessage({ result: { features, groups } }, { transfer: [features.data.buffer] });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
