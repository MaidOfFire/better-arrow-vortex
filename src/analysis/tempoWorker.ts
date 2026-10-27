// Runs findTempo off the main thread.

import { findTempo } from './findTempo';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  const { samples, sampleRate } = e.data;
  try {
    self.postMessage({ estimates: findTempo(samples, sampleRate) });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
