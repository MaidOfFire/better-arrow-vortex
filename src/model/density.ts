// Notes per second split by chord size, as in Etterna's chord density graph (Til' Death theme).

import type { Note } from './types';

export interface ChordDensity {
  /** Song time (whole seconds) where the first one-second bin starts. */
  start: number;
  /** byChord[k - 1][i]: notes in chords of exactly k notes during second `start + i`. */
  byChord: Int32Array[];
  /** Notes per second, all chord sizes together. */
  total: Int32Array;
  mines: Int32Array;
  /** Highest notes per second. */
  peak: number;
}

/**
 * Counts like Etterna's GetCDGraphVectors: taps and hold/roll heads count, a chord is the notes
 * on one row, lifts and fakes are left out and mines are counted on their own. Bins cover
 * [from, to] in song seconds, widened to every note.
 */
export function chordDensity(
  notes: readonly Note[],
  columns: number,
  rowToTime: (row: number) => number,
  from: number,
  to: number,
): ChordDensity {
  const chords = new Map<number, number>();
  const mineRows: number[] = [];
  for (const n of notes) {
    if (n.col >= columns) continue;
    if (n.type === 'mine') mineRows.push(n.row);
    else if (n.type === 'tap' || n.type === 'hold' || n.type === 'roll') chords.set(n.row, (chords.get(n.row) ?? 0) + 1);
  }
  const chordTimes = [...chords].map(([row, size]) => [rowToTime(row), size] as const);
  const mineTimes = mineRows.map(rowToTime);
  let first = from;
  let last = to;
  for (const [t] of chordTimes) [first, last] = [Math.min(first, t), Math.max(last, t)];
  for (const t of mineTimes) [first, last] = [Math.min(first, t), Math.max(last, t)];
  const start = Math.floor(first);
  const bins = Math.max(1, Math.floor(last) - start + 1);

  const byChord = Array.from({ length: columns }, () => new Int32Array(bins));
  const total = new Int32Array(bins);
  const mines = new Int32Array(bins);
  for (const [t, size] of chordTimes) {
    const i = Math.floor(t) - start;
    byChord[Math.min(size, columns) - 1][i] += size;
    total[i] += size;
  }
  for (const t of mineTimes) mines[Math.floor(t) - start]++;
  let peak = 0;
  for (const v of total) peak = Math.max(peak, v);
  return { start, byChord, total, mines, peak };
}
