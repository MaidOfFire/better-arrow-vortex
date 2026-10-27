import { describe, expect, it } from 'vitest';
import { computeOnsets, onsetAt } from '../src/analysis/onsets';

const RATE = 44100;

/** Low thumps at `lowTimes` and bright noise bursts at `highTimes`, over quiet noise. */
function signal(seconds: number, lowTimes: number[], highTimes: number[]): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; ++i) out[i] = rand() * 0.002;
  for (const t of lowTimes) {
    const s = Math.floor(t * RATE);
    for (let i = 0; i < RATE * 0.15; ++i) {
      const attack = Math.min(1, i / (RATE * 0.004)); // no click: keep the thump low-frequency only
      out[s + i] += Math.sin(2 * Math.PI * 60 * (i / RATE)) * Math.exp(-i / (RATE * 0.05)) * attack * 0.8;
    }
  }
  for (const t of highTimes) {
    const s = Math.floor(t * RATE);
    let prev = 0;
    for (let i = 0; i < RATE * 0.04; ++i) {
      const x = rand();
      out[s + i] += (x - prev) * Math.exp(-i / (RATE * 0.01)) * 0.5; // differenced noise = bright
      prev = x;
    }
  }
  return out;
}

const peakNear = (data: ReturnType<typeof computeOnsets>, band: number, t: number) => onsetAt(data, band, t - 0.015, t + 0.015);

describe('computeOnsets', () => {
  const low = [1, 2, 3, 4, 5, 6, 7, 8];
  const high = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
  const data = computeOnsets(signal(9, low, high), RATE);

  it('puts kicks in the low band and bright hits in the high band', () => {
    for (const t of low) {
      expect(peakNear(data, 0, t)).toBeGreaterThan(0.5);
      expect(peakNear(data, 2, t)).toBeLessThan(0.3);
    }
    for (const t of high) {
      expect(peakNear(data, 2, t)).toBeGreaterThan(0.5);
      expect(peakNear(data, 0, t)).toBeLessThan(0.3);
    }
  });

  it('stays quiet between hits', () => {
    for (const t of [1.25, 2.75, 4.25]) for (let b = 0; b < 3; ++b) expect(peakNear(data, b, t)).toBeLessThan(0.15);
  });

  it('places peaks within one frame of the onset', () => {
    for (const t of high) {
      let best = 0;
      let bestT = 0;
      for (let dt = -0.03; dt <= 0.03; dt += 0.001) {
        const v = onsetAt(data, 2, t + dt, t + dt);
        if (v > best) {
          best = v;
          bestT = t + dt;
        }
      }
      expect(Math.abs(bestT - t)).toBeLessThan(1.5 / data.fps);
    }
  });
});
