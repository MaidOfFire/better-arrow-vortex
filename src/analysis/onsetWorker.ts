// Runs computeOnsets off the main thread.

import { computeOnsets } from './onsets';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    const data = computeOnsets(e.data.samples, e.data.sampleRate);
    self.postMessage({ data }, { transfer: data.bands.map((b) => b.buffer) });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
