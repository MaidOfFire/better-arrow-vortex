import { describe, expect, it } from 'vitest';
import { BT_CHUNK, BT_FPS, BT_MELS, aggregate, chunkStarts, logMelSpectrogram, pickBeats } from '../src/analysis/beatThis';
import { tempoFromBeats } from '../src/analysis/findTempo';

describe('Beat This! around the network', () => {
  it('makes one 128-band frame every 20 ms', () => {
    const { data, frames } = logMelSpectrogram(new Float32Array(22050));
    expect(frames).toBe(51);
    expect(data.length).toBe(51 * BT_MELS);
  });

  it('splits a piece into overlapping runs and keeps the first run where they overlap', () => {
    expect(chunkStarts(1000)).toEqual([-6]);
    const starts = chunkStarts(4000);
    expect(starts).toEqual([-6, 1482, 4000 - (BT_CHUNK - 6)]);
    const runs = starts.map((_, r) => new Float32Array(BT_CHUNK).fill(r));
    const scores = aggregate(4000, starts, runs);
    // Each run gives frames start + 6 .. start + 1493; the second run takes over at 1488, the third after the second ends.
    expect([scores[0], scores[1487], scores[1488], scores[2975], scores[2976], scores[3999]]).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('picks beats at score peaks and puts downbeats on the nearest beat', () => {
    const beat = new Float32Array(400).fill(-5);
    const downbeat = new Float32Array(400).fill(-5);
    for (const f of [10, 35, 60, 85]) beat[f] = 3;
    beat[110] = beat[111] = 2; // a plateau counts once, between its frames
    downbeat[11] = 1; // one frame off the beat at frame 10
    const { beats, downbeats } = pickBeats(beat, downbeat);
    expect(beats).toEqual([10, 35, 60, 85, 110.5].map((f) => f / BT_FPS));
    expect(downbeats).toEqual([10 / BT_FPS]);
  });

  it('turns tracked beats into a tempo with beat 0 on a downbeat', () => {
    // Clicks at 150 BPM from 0.3 s; the tracker reports them on its 20 ms grid, bars start on the third beat.
    const period = 0.4;
    const audio = new Float32Array(22050 * 40);
    const beats: number[] = [];
    for (let t = 0.3; t < 39; t += period) {
      const s = Math.round(t * 22050);
      for (let i = 0; i < 400; ++i) audio[s + i] += Math.exp(-i / 60) * (i % 2 ? 1 : -1);
      beats.push(Math.round(t * BT_FPS) / BT_FPS);
    }
    const downbeats = beats.filter((_, i) => i % 4 === 2);
    const [best] = tempoFromBeats(beats, downbeats, audio, 22050);
    expect(Math.abs(best.bpm - 150)).toBeLessThan(0.01);
    // Beat 0 at the first downbeat, 0.3 + 2 beats, to within a few milliseconds.
    expect(Math.abs(best.beatTime - 1.1)).toBeLessThan(0.004);
  });
});
