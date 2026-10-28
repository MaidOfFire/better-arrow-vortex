import { describe, expect, it } from 'vitest';
import { chordDensity } from '../src/model/density';
import type { Note, NoteType } from '../src/model/types';

const note = (row: number, col: number, type: NoteType = 'tap', endRow = row): Note => ({ row, col, type, endRow });
// 120 BPM from time 0: 48 rows a beat, two beats a second.
const rowToTime = (row: number) => row / 96;

describe('chord density', () => {
  const notes = [
    note(0, 0), // second 0: a single
    note(48, 0),
    note(48, 1, 'hold', 96), // a jump (hold heads count)
    note(96, 0),
    note(96, 1),
    note(96, 2, 'roll', 144), // second 1: a hand
    note(144, 0),
    note(144, 1),
    note(144, 2),
    note(144, 3), // and a quad
    note(192, 0, 'mine'),
    note(192, 1, 'lift'), // lifts and fakes are left out
    note(192, 2, 'fake'),
    note(192, 7), // outside a 4-column chart
  ];

  it('counts notes per second by chord size, like Etterna', () => {
    const d = chordDensity(notes, 4, rowToTime, 0, 3.5);
    expect(d.start).toBe(0);
    expect(d.total).toEqual(Int32Array.from([3, 7, 0, 0]));
    expect(d.byChord.map((c) => [...c])).toEqual([
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 3, 0, 0],
      [0, 4, 0, 0],
    ]);
    expect([...d.mines]).toEqual([0, 0, 1, 0]);
    expect(d.peak).toBe(7);
  });

  it('starts before 0 when notes come before the music', () => {
    const d = chordDensity([note(0, 0)], 4, (row) => row / 96 - 1.5, 0, 2);
    expect(d.start).toBe(-2);
    expect([...d.total]).toEqual([1, 0, 0, 0, 0]);
  });
});
