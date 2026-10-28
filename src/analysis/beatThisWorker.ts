// Runs Beat This! (see beatThis.ts) off the main thread with ONNX Runtime Web and turns its
// beats into BPM estimates. Input: 22050 Hz mono samples and the model's URL.

import * as ort from 'onnxruntime-web/wasm';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { BT_CHUNK, BT_MELS, BT_RATE, aggregate, chunkInput, chunkStarts, logMelSpectrogram, pickBeats } from './beatThis';
import { tempoFromBeats } from './findTempo';

ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// Threads need cross-origin isolation, which a static host like GitHub Pages cannot turn on.
ort.env.wasm.numThreads = 1;

self.onmessage = async (e: MessageEvent<{ samples: Float32Array; modelUrl: string }>) => {
  try {
    const { samples, modelUrl } = e.data;
    const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
    const { data, frames } = logMelSpectrogram(samples);
    const starts = chunkStarts(frames);
    const beatRuns: Float32Array[] = [];
    const downbeatRuns: Float32Array[] = [];
    for (let i = 0; i < starts.length; ++i) {
      const spect = new ort.Tensor('float32', chunkInput(data, frames, starts[i]), [1, BT_CHUNK, BT_MELS]);
      const out = await session.run({ spect });
      beatRuns.push(out.beat.data as Float32Array);
      downbeatRuns.push(out.downbeat.data as Float32Array);
      self.postMessage({ progress: (i + 1) / starts.length });
    }
    await session.release();
    const { beats, downbeats } = pickBeats(aggregate(frames, starts, beatRuns), aggregate(frames, starts, downbeatRuns));
    self.postMessage({ result: { estimates: tempoFromBeats(beats, downbeats, samples, BT_RATE), beats, downbeats } });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
