// Cursor, zoom, snap and the mapping between chart positions and screen coordinates.

import { ROWS_PER_BEAT, ROWS_PER_MEASURE } from '../model/types';
import type { TempoMap } from '../model/timing';

/** Rows per snap step; index 0 is "no snap", the last index is the custom snap. */
export const SNAP_ROWS = [0, 48, 24, 16, 12, 8, 6, 4, 3, 2, 1, 0];
export const SNAP_NAMES = ['None', '4th', '8th', '12th', '16th', '24th', '32nd', '48th', '64th', '96th', '192nd', 'Custom'];
export const SNAP_CUSTOM = SNAP_ROWS.length - 1;

export type SnapDir = 'up' | 'down' | 'closest';

/** A position along the chart: seconds in time-based view, rows in row-based view. */
export type ChartOffset = number;

export class View {
  width = 800;
  height = 600;

  zoomLevel = 8;
  scaleLevel = 4;
  timeBased = true;
  reverse = false;
  receptorX = 0;
  receptorY = 192;
  snapType = 4;
  customSnap = 20;
  private customSteps: number[] = [];

  cursorRow = 0;
  cursorTime = 0;
  cursorBeat = 0;
  hoverRow = -1;
  numCols = 4;
  /** Extra half-width needed around the receptors (e.g. for the waveform). */
  waveformHalfWidth = 0;
  /** Width of the onset strip drawn left of the receptors (0 when hidden). */
  audioStripWidth = 0;
  /** Horizontal shift of the notefield, used for side-by-side compare panes. */
  paneShiftX = 0;

  constructor(
    public tempo: TempoMap,
    private endRow: () => number,
  ) {
    this.updateCustomSnapSteps();
  }

  // ----------------------------------------------------------------------------------------------
  // Scroll speed and scale.

  get pixPerSec(): number {
    const v = Math.round(21.077 * Math.pow(1.518, this.zoomLevel));
    return this.reverse ? -v : v;
  }

  get pixPerRow(): number {
    const v = Math.round(11.588 * Math.pow(1.48, this.zoomLevel)) / ROWS_PER_BEAT;
    return this.reverse ? -v : v;
  }

  get pixPerOfs(): number {
    return this.timeBased ? this.pixPerSec : this.pixPerRow;
  }

  /** Scales a length given at the default note scale (64 px columns). */
  applyZoom(v: number): number {
    return (v * this.scaleLevel) / 4;
  }

  get colWidth(): number {
    return this.applyZoom(64);
  }

  setZoom(level: number): void {
    this.zoomLevel = Math.min(16, Math.max(-2, level));
  }

  setScale(level: number): void {
    this.scaleLevel = Math.min(10, Math.max(1, level));
  }

  // ----------------------------------------------------------------------------------------------
  // Horizontal layout.

  get centerX(): number {
    return Math.round(this.width / 2 + this.receptorX + this.paneShiftX);
  }

  /**
   * Runs `fn` with the notefield shifted by `dx` and the cursor moved by `rows` (for drawing
   * another compare pane), then restores the view.
   */
  withPane(dx: number, rows: number, fn: () => void): void {
    const saved = [this.paneShiftX, this.cursorRow, this.cursorTime, this.cursorBeat] as const;
    this.paneShiftX = dx;
    if (rows) {
      this.cursorTime = this.tempo.rowToTime(this.tempo.timeToRow(saved[2]) + rows);
      this.cursorBeat = this.tempo.timeToBeat(this.cursorTime);
      this.cursorRow = Math.floor(this.cursorBeat * ROWS_PER_BEAT + 1e-6);
    }
    try {
      fn();
    } finally {
      [this.paneShiftX, this.cursorRow, this.cursorTime, this.cursorBeat] = saved;
    }
  }

  colX(col: number): number {
    return this.centerX + this.applyZoom((col - (this.numCols - 1) / 2) * 64);
  }

  get receptorLeft(): number {
    return this.centerX - this.applyZoom(this.numCols * 32);
  }

  get receptorRight(): number {
    return this.centerX + this.applyZoom(this.numCols * 32);
  }

  get stripRight(): number {
    return this.receptorLeft - this.applyZoom(12);
  }

  get stripLeft(): number {
    return this.stripRight - this.audioStripWidth;
  }

  /** Extent of the dark notefield strip. */
  get fieldLeft(): number {
    let x = this.receptorLeft - this.applyZoom(32);
    if (this.audioStripWidth) x = Math.min(x, this.stripLeft - this.applyZoom(32));
    if (this.waveformHalfWidth) x = Math.min(x, this.centerX - this.waveformHalfWidth - 4);
    return x;
  }

  get fieldRight(): number {
    let x = this.receptorRight + this.applyZoom(32);
    if (this.waveformHalfWidth) x = Math.max(x, this.centerX + this.waveformHalfWidth + 4);
    return x;
  }

  get receptorScreenY(): number {
    return this.reverse ? this.height - this.receptorY : this.receptorY;
  }

  /** The column under screen x, or -1. */
  xToCol(x: number): number {
    const c = Math.floor((x - this.receptorLeft) / this.colWidth);
    return c >= 0 && c < this.numCols ? c : -1;
  }

  // ----------------------------------------------------------------------------------------------
  // Vertical mapping.

  get cursorOffset(): ChartOffset {
    return this.timeBased ? this.cursorTime : this.cursorBeat * ROWS_PER_BEAT;
  }

  /** Screen y of offset 0. */
  get chartTopY(): number {
    return Math.floor(this.receptorScreenY - this.cursorOffset * this.pixPerOfs);
  }

  offsetToY(ofs: ChartOffset): number {
    return this.chartTopY + ofs * this.pixPerOfs;
  }

  yToOffset(y: number): ChartOffset {
    return (y - this.chartTopY) / this.pixPerOfs;
  }

  rowToOffset(row: number): ChartOffset {
    return this.timeBased ? this.tempo.rowToTime(row) : row;
  }

  timeToOffset(time: number): ChartOffset {
    return this.timeBased ? time : this.tempo.timeToRow(time);
  }

  offsetToRow(ofs: ChartOffset): number {
    return this.timeBased ? Math.round(this.tempo.timeToRow(ofs)) : Math.round(ofs);
  }

  offsetToTime(ofs: ChartOffset): number {
    return this.timeBased ? ofs : this.tempo.rowToTime(ofs);
  }

  rowToY(row: number): number {
    return this.offsetToY(this.rowToOffset(row));
  }

  timeToY(time: number): number {
    return this.offsetToY(this.timeToOffset(time));
  }

  yToRow(y: number): number {
    return this.offsetToRow(this.yToOffset(y));
  }

  // ----------------------------------------------------------------------------------------------
  // Cursor.

  get beginTime(): number {
    return this.tempo.rowToTime(0);
  }

  get endTime(): number {
    return this.tempo.rowToTime(this.endRow());
  }

  setCursorTime(time: number): void {
    this.cursorTime = Math.min(this.endTime, Math.max(this.beginTime, time));
    this.cursorBeat = this.tempo.timeToBeat(this.cursorTime);
    this.cursorRow = Math.max(0, Math.floor(this.cursorBeat * ROWS_PER_BEAT + 1e-6));
  }

  setCursorRow(row: number): void {
    this.cursorRow = Math.min(this.endRow(), Math.max(0, Math.round(row)));
    this.cursorBeat = this.cursorRow / ROWS_PER_BEAT;
    this.cursorTime = this.tempo.rowToTime(this.cursorRow);
  }

  setCursorOffset(ofs: ChartOffset): void {
    if (this.timeBased) this.setCursorTime(ofs);
    else this.setCursorRow(Math.round(ofs));
  }

  /** Re-derives the cursor time after the tempo changed, keeping the row. */
  refreshCursor(): void {
    this.setCursorRow(this.cursorRow);
  }

  // ----------------------------------------------------------------------------------------------
  // Snapping.

  get snapQuant(): number {
    if (this.snapType === SNAP_CUSTOM) return this.customSnap;
    const rows = SNAP_ROWS[this.snapType];
    return rows ? ROWS_PER_MEASURE / rows : 192;
  }

  get snapName(): string {
    if (this.snapType === SNAP_CUSTOM) return `${ordinal(this.customSnap)} (custom)`;
    return SNAP_NAMES[this.snapType];
  }

  setSnapType(type: number): void {
    const n = SNAP_ROWS.length;
    this.snapType = ((type % n) + n) % n;
  }

  setCustomSnap(quant: number): void {
    quant = Math.min(192, Math.max(4, Math.round(quant)));
    const preset = SNAP_ROWS.findIndex((r, i) => i > 0 && i < SNAP_CUSTOM && ROWS_PER_MEASURE / r === quant);
    if (preset > 0) {
      this.snapType = preset;
      return;
    }
    this.customSnap = quant;
    this.updateCustomSnapSteps();
    this.snapType = SNAP_CUSTOM;
  }

  private updateCustomSnapSteps(): void {
    const inc = ROWS_PER_MEASURE / this.customSnap;
    this.customSteps = [];
    for (let i = 0; i <= this.customSnap; ++i) this.customSteps.push(Math.round(inc * i));
  }

  isAlignedToSnap(row: number): boolean {
    if (this.snapType === SNAP_CUSTOM) return this.customSteps.includes(((row % 192) + 192) % 192);
    const snap = SNAP_ROWS[this.snapType];
    return snap === 0 || row % snap === 0;
  }

  snapRow(row: number, dir: SnapDir): number {
    if (dir === 'closest') {
      if (this.snapType === 0 || this.isAlignedToSnap(row)) return row;
      const up = this.snapRow(row, 'up');
      const down = this.snapRow(row, 'down');
      return Math.abs(row - up) < Math.abs(row - down) ? up : down;
    }
    if (this.reverse) dir = dir === 'up' ? 'down' : 'up';
    row += dir === 'up' ? -1 : 1;
    if (this.snapType === SNAP_CUSTOM) {
      const measure = Math.floor(row / 192);
      let mrow = row - measure * 192;
      if (dir === 'up') {
        for (let i = this.customSnap; i >= 0; --i) {
          if (this.customSteps[i] <= mrow) {
            mrow = this.customSteps[i];
            break;
          }
        }
      } else {
        for (let i = 0; i <= this.customSnap; ++i) {
          if (this.customSteps[i] >= mrow) {
            mrow = this.customSteps[i];
            break;
          }
        }
      }
      return measure * 192 + mrow;
    }
    const snap = SNAP_ROWS[this.snapType] || 1;
    const rem = ((row % snap) + snap) % snap;
    if (rem === 0) return row;
    return dir === 'up' ? row - rem : row - rem + snap;
  }
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
