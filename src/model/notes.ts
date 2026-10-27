// Helpers for sorted, immutable note lists.

import { ROWS_PER_BEAT, type Note } from './types';

/** Unique id of a note position; a column can hold one note per row. */
export function noteKey(row: number, col: number): number {
  return row * 64 + col;
}

export function keyOf(n: Note): number {
  return noteKey(n.row, n.col);
}

export function compareNotes(a: Note, b: Note): number {
  return a.row - b.row || a.col - b.col;
}

export function isLong(n: Note): boolean {
  return n.endRow > n.row;
}

/** Index of the first note with row >= row. */
export function lowerBoundRow(notes: readonly Note[], row: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].row < row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function findNote(notes: readonly Note[], row: number, col: number): Note | undefined {
  for (let i = lowerBoundRow(notes, row); i < notes.length && notes[i].row === row; ++i) {
    if (notes[i].col === col) return notes[i];
  }
  return undefined;
}

/** The note in `col` whose head or hold body covers `row`. */
export function findNoteCovering(notes: readonly Note[], row: number, col: number, maxLen: number): Note | undefined {
  const start = lowerBoundRow(notes, row - maxLen);
  for (let i = start; i < notes.length && notes[i].row <= row; ++i) {
    const n = notes[i];
    if (n.col === col && n.row <= row && n.endRow >= row) return n;
  }
  return undefined;
}

export function maxHoldLength(notes: readonly Note[]): number {
  let max = 0;
  for (const n of notes) max = Math.max(max, n.endRow - n.row);
  return max;
}

/**
 * Returns a new sorted list with `remove` taken out and `add` put in. Added notes replace every
 * existing note they overlap in the same column (including hold bodies).
 */
export function applyNoteEdit(notes: readonly Note[], remove: readonly Note[], add: readonly Note[]): Note[] {
  const removeKeys = new Set(remove.map(keyOf));
  const byCol = new Map<number, Note[]>();
  for (const n of add) {
    let list = byCol.get(n.col);
    if (!list) byCol.set(n.col, (list = []));
    list.push(n);
  }
  for (const list of byCol.values()) list.sort(compareNotes);

  const overlapsAdded = (n: Note): boolean => {
    const list = byCol.get(n.col);
    if (!list) return false;
    // Binary search for the first added note that ends at or after n.row.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].endRow < n.row) lo = mid + 1;
      else hi = mid;
    }
    // Added notes in one column do not overlap each other, so endRow order follows row order.
    return lo < list.length && list[lo].row <= n.endRow;
  };

  const kept = notes.filter((n) => !removeKeys.has(keyOf(n)) && !overlapsAdded(n));
  const sortedAdd = [...add].sort(compareNotes);
  // Merge two sorted lists.
  const out: Note[] = new Array(kept.length + sortedAdd.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < kept.length && j < sortedAdd.length) {
    out[k++] = compareNotes(kept[i], sortedAdd[j]) <= 0 ? kept[i++] : sortedAdd[j++];
  }
  while (i < kept.length) out[k++] = kept[i++];
  while (j < sortedAdd.length) out[k++] = sortedAdd[j++];
  return dedupe(out);
}

/** Drops notes sharing a row and column with the next one (keeps the later entry). */
function dedupe(notes: Note[]): Note[] {
  const out: Note[] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && last.row === n.row && last.col === n.col) out[out.length - 1] = n;
    else out.push(n);
  }
  return out;
}

/** Quantization index used for colouring: 0=4th 1=8th 2=12th 3=16th 4=24th 5=32nd 6=48th 7=64th 8=192nd. */
const QUANT_MODS = [48, 24, 16, 12, 8, 6, 4, 3];
const QUANT_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < ROWS_PER_BEAT; ++i) {
    let q = 0;
    while (q < QUANT_MODS.length && i % QUANT_MODS[q] !== 0) ++q;
    table.push(q);
  }
  return table;
})();

export function rowQuant(row: number): number {
  return QUANT_TABLE[((row % ROWS_PER_BEAT) + ROWS_PER_BEAT) % ROWS_PER_BEAT];
}

export const QUANT_NAMES = ['4th', '8th', '12th', '16th', '24th', '32nd', '48th', '64th', '192nd'];
/** Rows between notes of each quantization. */
export const QUANT_ROWS = [48, 24, 16, 12, 8, 6, 4, 3, 1];
