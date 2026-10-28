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

/** Loud low kicks on the beats and quieter, sharper hi-hats halfway between them. */
function kicksAndHats(bpm: number, first: number, seconds: number, rate = 44100): Float32Array {
  const out = new Float32Array(Math.floor(seconds * rate));
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const period = 60 / bpm;
  for (let t = first; t < seconds; t += period) {
    const kick = Math.floor(t * rate);
    for (let i = 0; i < 6000 && kick + i < out.length; ++i) out[kick + i] += 0.9 * Math.sin((2 * Math.PI * 55 * i) / rate) * Math.exp(-i / 2500);
    const hat = Math.floor((t + period / 2) * rate);
    for (let i = 0; i < 400 && hat + i < out.length; ++i) out[hat + i] += 0.3 * rand() * Math.exp(-i / 60);
  }
  for (let i = 0; i < out.length; ++i) out[i] += rand() * 0.005;
  return out;
}

const phaseError = (beatTime: number, first: number, period: number) => Math.abs(((beatTime - first + period * 1.5) % period) - period / 2);

describe('findTempo', () => {
  it('finds the BPM and beat phase of a click track', () => {
    const est = findTempo(clickTrack(150, 0.3, 30), 44100);
    expect(est.length).toBeGreaterThan(0);
    expect(Math.abs(est[0].bpm - 150)).toBeLessThan(0.01);
    expect(phaseError(est[0].beatTime, 0.3, 60 / 150)).toBeLessThan(0.003);
  });

  it('puts the beat on the kicks, not on the sharper hi-hats between them', () => {
    const est = findTempo(kicksAndHats(180, 0.2, 30), 44100);
    const at180 = est.find((e) => Math.abs(e.bpm - 180) < 0.05)!;
    expect(at180).toBeDefined();
    expect(phaseError(at180.beatTime, 0.2, 60 / 180)).toBeLessThan(0.01);
  });
});
