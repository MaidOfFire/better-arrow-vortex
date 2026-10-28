// Runs the section analysis off the main thread, for every detail level at once. Features
// already computed for the same beat grid can be passed in, so only the search runs again.

import type { OnsetData } from './onsets';
import { computeBeatFeatures, findLevels, type BeatFeatures, type RepeatGroup } from './structure';

interface Request {
  samples?: Float32Array;
  sampleRate?: number;
  beatTimes?: Float64Array;
  onsets?: OnsetData;
  features?: BeatFeatures;
  /** Groups marked by hand (in beats): found groups fit around them. */
  fixed: RepeatGroup[];
}

self.onmessage = (e: MessageEvent<Request>) => {
  try {
    const { samples, sampleRate, beatTimes, onsets, fixed } = e.data;
    const features = e.data.features ?? computeBeatFeatures(samples!, sampleRate!, beatTimes!, onsets!);
    const groups = findLevels(features, fixed);
    self.postMessage({ result: { features, groups } }, { transfer: [features.data.buffer] });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
