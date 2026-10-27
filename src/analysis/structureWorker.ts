// Runs the section analysis off the main thread.

import type { OnsetData } from './onsets';
import { computeBeatFeatures, findRepeats } from './structure';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number; beatTimes: Float64Array; onsets: OnsetData }>) => {
  try {
    const { samples, sampleRate, beatTimes, onsets } = e.data;
    const features = computeBeatFeatures(samples, sampleRate, beatTimes, onsets);
    const groups = findRepeats(features);
    self.postMessage({ result: { features, groups } }, { transfer: [features.data.buffer] });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
