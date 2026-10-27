// A generated demo song (simple drum loop) with a short chart, for trying the editor without files.

import { saveSm } from '../model/simfileIO';
import { newChart, newSimfile, type Note } from '../model/types';

const BPM = 140;
const LEAD_IN = 0.5;
const BEATS = 64;
const RATE = 22050;

function makeWav(): ArrayBuffer {
  const spb = 60 / BPM;
  const seconds = LEAD_IN + BEATS * spb + 1;
  const n = Math.floor(seconds * RATE);
  const data = new Float32Array(n);
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const addKick = (t: number) => {
    const s = Math.floor(t * RATE);
    for (let i = 0; i < RATE * 0.25 && s + i < n; ++i) {
      const tt = i / RATE;
      data[s + i] += Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 9) * 0.9;
    }
  };
  const addHat = (t: number, gain: number) => {
    const s = Math.floor(t * RATE);
    let prev = 0;
    for (let i = 0; i < RATE * 0.05 && s + i < n; ++i) {
      const x = rand();
      data[s + i] += (x - prev) * Math.exp((-i / RATE) * 80) * gain;
      prev = x;
    }
  };
  const addSnare = (t: number) => {
    const s = Math.floor(t * RATE);
    for (let i = 0; i < RATE * 0.15 && s + i < n; ++i) {
      const tt = i / RATE;
      data[s + i] += (rand() * 0.5 + Math.sin(2 * Math.PI * 190 * tt) * 0.5) * Math.exp(-tt * 25) * 0.6;
    }
  };
  for (let b = 0; b < BEATS; ++b) {
    const t = LEAD_IN + b * spb;
    addKick(t);
    if (b % 2 === 1) addSnare(t);
    for (let k = 1; k < 4; ++k) addHat(t + (k * spb) / 4, k === 2 ? 0.35 : 0.18);
  }
  // 16-bit mono WAV.
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; ++i) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * 0.7)) * 32767, true);
  return buf;
}

function makeNotes(): Note[] {
  const notes: Note[] = [];
  const tap = (row: number, col: number) => notes.push({ row, col, type: 'tap', endRow: row });
  // Measures 1-2: quarter notes and jumps.
  for (let b = 4; b < 12; ++b) tap(b * 48, b % 4);
  tap(12 * 48, 0);
  tap(12 * 48, 3);
  // Measures 3-4: an 8th-note trill and a hold.
  for (let i = 0; i < 12; ++i) tap(16 * 48 + i * 24, i % 2 === 0 ? 1 : 2);
  notes.push({ row: 22 * 48, col: 0, type: 'hold', endRow: 24 * 48 });
  for (let i = 0; i < 4; ++i) tap(22 * 48 + i * 24, 3 - (i % 2));
  // Measures 7-8: 16th stream with a roll and mines.
  const pattern = [0, 2, 1, 3, 2, 0, 3, 1];
  for (let i = 0; i < 32; ++i) tap(28 * 48 + i * 12, pattern[i % pattern.length]);
  notes.push({ row: 36 * 48, col: 1, type: 'roll', endRow: 38 * 48 });
  for (let i = 0; i < 4; ++i) notes.push({ row: 36 * 48 + i * 24, col: 3, type: 'mine', endRow: 36 * 48 + i * 24 });
  // A few 12ths and 24ths to show quantization colours.
  for (let i = 0; i < 6; ++i) tap(40 * 48 + i * 16, i % 4);
  for (let i = 0; i < 6; ++i) tap(44 * 48 + i * 8, (i * 3) % 4);
  return notes.sort((a, b) => a.row - b.row || a.col - b.col);
}

export function makeDemo(): { sm: string; wav: ArrayBuffer } {
  const sim = newSimfile();
  sim.meta.TITLE = 'Demo Loop';
  sim.meta.ARTIST = 'Better Arrow Vortex';
  sim.meta.MUSIC = 'demo.wav';
  sim.meta.SAMPLESTART = '4.000';
  sim.meta.SAMPLELENGTH = '10.000';
  sim.timing.offset = -LEAD_IN;
  sim.timing.bpms = [{ beat: 0, bpm: BPM }];
  const chart = newChart('dance-single', 'Hard', 8);
  chart.description = 'demo';
  chart.notes = makeNotes();
  sim.charts.push(chart);
  return { sm: saveSm(sim).text, wav: makeWav() };
}
