import { describe, expect, it } from 'vitest';
import { findTempo } from '../src/analysis/findTempo';

function clickTrack(bpm: number, first: number, seconds: number, rate = 44100): Float32Array {
  const out = new Float32Array(Math.floor(seconds * rate));
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let t = first; t < seconds; t += 60 / bpm) {
    const start = Math.floor(t * rate);
    for (let i = 0; i < 2000 && start + i < out.length; ++i) out[start + i] += rand() * Math.exp(-i / 300);
  }
  for (let i = 0; i < out.length; ++i) out[i] += rand() * 0.01;
  return out;
}

describe('findTempo', () => {
  it('finds the BPM and beat phase of a click track', () => {
    const est = findTempo(clickTrack(150, 0.3, 30), 44100);
    expect(est.length).toBeGreaterThan(0);
    expect(est[0].bpm).toBeCloseTo(150, 0);
    const period = 60 / 150;
    const phaseErr = Math.abs(((est[0].beatTime - 0.3 + period / 2) % period) - period / 2);
    expect(phaseErr).toBeLessThan(0.005);
  });
});
