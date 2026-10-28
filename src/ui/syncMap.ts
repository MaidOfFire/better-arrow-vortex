// Sync map window (see analysis/syncMap.ts): across the song (left to right), where the music's
// attacks fall around the chart's beats (up: later, down: earlier, ±60 ms). A bright line on the
// middle is in sync; a line off the middle or wandering shows where and by how much the chart is
// off. It follows the chart's timing as it is edited. Hover for the numbers, click to go there.

import { analyzeSharpOnsets } from '../analysis/detect';
import type { OnsetCurve } from '../analysis/findTempo';
import { SYNC_RANGE_MS, SYNC_ROWS, beatColumns, localOffsets, type LocalOffset } from '../analysis/syncMap';
import type { Editor } from '../editor/editor';
import { mmss } from './chordGraph';
import { h } from './dom';
import { FloatingWindow } from './floatingWindow';

interface MapData {
  beats: number[];
  scaled: Float32Array;
  offsets: LocalOffset[];
  /** Seconds shown, from 0. */
  duration: number;
}

const fmtMs = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms).toFixed(1)} ms`;

export class SyncMap {
  private readonly window: FloatingWindow;
  private readonly canvas = h('canvas', { class: 'panel-canvas' });
  private readonly info = h('div', { class: 'panel-info' });
  /** The onset curve and the music it belongs to (computed once per music, in a worker). */
  private curve: OnsetCurve | null = null;
  private curveFor: AudioBuffer | null = null;
  private analyzing: AudioBuffer | null = null;
  private data: MapData | null = null;
  private dataKey: unknown[] = [];
  private image: HTMLCanvasElement | null = null;
  private imageKey: unknown[] = [];
  private hoverX: number | null = null;
  private dragging = false;

  constructor(
    private readonly editor: Editor,
    layer: HTMLElement,
    private readonly onSeek: () => void,
  ) {
    const keys = { open: 'showSyncMap', pinned: 'syncMapPinned', x: 'syncMapX', y: 'syncMapY', w: 'syncMapW', h: 'syncMapH' } as const;
    this.window = new FloatingWindow(editor, layer, 'Sync map', keys, 'Shift+O', () => this.draw());
    this.window.body.append(h('div', { class: 'panel-plot' }, this.canvas), this.info);
    new ResizeObserver(() => this.draw()).observe(this.canvas);

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.data) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.seek(e.offsetX);
    });
    c.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      if (this.dragging) this.seek(e.offsetX);
      else this.draw();
    });
    const release = () => {
      this.dragging = false;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.draw();
    });
  }

  /** Called whenever the editor redraws. */
  update(): void {
    if (this.window.update()) this.draw();
  }

  /** Starts the onset analysis when the window shows music it has not analyzed yet. */
  private ensureCurve(): OnsetCurve | null {
    const buffer = this.editor.audio.buffer;
    if (!buffer) return null;
    if (this.curveFor === buffer) return this.curve;
    if (this.analyzing !== buffer) {
      this.analyzing = buffer;
      analyzeSharpOnsets(buffer)
        .then((curve) => {
          if (this.analyzing !== buffer) return;
          [this.curve, this.curveFor, this.analyzing] = [curve, buffer, null];
          this.editor.changed();
        })
        .catch((e) => {
          this.analyzing = null;
          this.editor.hud(`Sync map analysis failed: ${(e as Error).message}`, 'warning');
        });
    }
    return null;
  }

  /** The columns for the chart's current beat grid (redone when the timing changes). */
  private mapData(curve: OnsetCurve): MapData {
    const ed = this.editor;
    const duration = ed.audio.duration;
    const key = [curve, ed.tempo, duration];
    if (this.data && key.every((k, i) => k === this.dataKey[i])) return this.data;
    this.dataKey = key;
    const beats: number[] = [];
    for (let b = 0; b < 1e6; ++b) {
      const t = ed.tempo.beatToTime(b);
      if (t > duration) break;
      if (t >= 0) beats.push(t);
    }
    const { raw, scaled } = beatColumns(curve, beats);
    this.data = { beats, scaled, offsets: localOffsets(raw, beats), duration };
    return this.data;
  }

  /** The columns drawn into an image: one pixel column per slice of the song, bright where attacks are. */
  private mapImage(d: MapData, w: number, hgt: number, dpr: number): HTMLCanvasElement {
    const key = [d, w, hgt, dpr];
    if (this.image && key.every((k, i) => k === this.imageKey[i])) return this.image;
    this.imageKey = key;
    const img = this.image ?? document.createElement('canvas');
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(hgt * dpr));
    img.width = pw;
    img.height = ph;
    const ctx = img.getContext('2d')!;
    const pixels = ctx.createImageData(pw, ph);
    const px = pixels.data;
    const rowOf = new Int32Array(ph);
    // Top row +60 ms, bottom row −60 ms.
    for (let y = 0; y < ph; ++y) rowOf[y] = Math.round((SYNC_ROWS - 1) * (1 - (y + 0.5) / ph));
    let b = 0;
    const column = new Float32Array(SYNC_ROWS);
    for (let x = 0; x < pw; ++x) {
      const t1 = ((x + 1) / pw) * d.duration;
      // The beats in this slice (averaged), or else the last beat before it.
      column.fill(0);
      let n = 0;
      while (b < d.beats.length && d.beats[b] < t1) {
        for (let k = 0; k < SYNC_ROWS; ++k) column[k] += d.scaled[b * SYNC_ROWS + k];
        ++n;
        ++b;
      }
      if (!n && b > 0 && t1 - d.beats[b - 1] < 2) {
        for (let k = 0; k < SYNC_ROWS; ++k) column[k] = d.scaled[(b - 1) * SYNC_ROWS + k];
        n = 1;
      }
      for (let y = 0; y < ph; ++y) {
        const k = Math.min(SYNC_ROWS - 1, Math.max(0, rowOf[y]));
        const v = n ? column[k] / n : 0;
        const g = Math.round(18 + 237 * v * v);
        const i = (y * pw + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = g;
        px[i + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    this.image = img;
    return img;
  }

  /** The map moves the main pane, like the minimap: editing returns to it first. */
  private seek(x: number): void {
    const d = this.data;
    const w = this.canvas.clientWidth;
    if (!d || !w) return;
    const ed = this.editor;
    ed.sections.focusMain();
    ed.setCursorTime((Math.min(w, Math.max(0, x)) / w) * d.duration);
    this.onSeek();
  }

  private setInfo(text: string): void {
    if (this.info.textContent !== text) this.info.textContent = text;
  }

  private draw(): void {
    const ed = this.editor;
    const c = this.canvas;
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (this.window.el.hidden || !ed.isOpen || !w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, w, hgt);
    if (!ed.audio.buffer) return this.setInfo('Load the music to see how the chart lines up with it.');
    const curve = this.ensureCurve();
    if (!curve) return this.setInfo('Analyzing the music...');
    const d = this.mapData(curve);
    ctx.drawImage(this.mapImage(d, w, hgt, dpr), 0, 0, w, hgt);
    const xOf = (t: number) => (t / d.duration) * w;
    const yOf = (ms: number) => hgt / 2 - (ms / SYNC_RANGE_MS) * (hgt / 2);

    // Reference lines: in sync (0), and ±10 / ±30 ms.
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const ms of [-30, -10, 10, 30]) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, Math.round(yOf(ms)), w, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(`${ms > 0 ? '+' : '−'}${Math.abs(ms)}`, 3, yOf(ms));
    }
    ctx.fillStyle = 'rgba(74,143,217,0.75)';
    ctx.fillRect(0, Math.round(yOf(0)), w, 1);

    // The main pane's visible stretch and cursor, as on the NPS graph.
    const v = ed.view;
    let top = 0;
    let bottom = 0;
    let cursor = 0;
    v.withPane(v.paneShiftX, ed.sections.mainDelta, () => {
      top = v.offsetToTime(v.yToOffset(0));
      bottom = v.offsetToTime(v.yToOffset(v.height));
      cursor = v.cursorTime;
    });
    ctx.fillStyle = 'rgba(255,170,40,0.16)';
    const va = xOf(Math.min(top, bottom));
    ctx.fillRect(va, 0, Math.max(2, xOf(Math.max(top, bottom)) - va), hgt);

    // The measured sync over every 8 beats, where it is clear.
    ctx.strokeStyle = 'rgba(90,209,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let drawing = false;
    for (const o of d.offsets) {
      if (o.offset === null) {
        drawing = false;
        continue;
      }
      const [x, y] = [xOf(o.time), yOf(o.offset)];
      if (drawing) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      drawing = true;
    }
    ctx.stroke();
    ctx.fillStyle = '#ff8c00';
    ctx.fillRect(Math.round(xOf(cursor)) - 1, 0, 2, hgt);

    this.setInfo(this.hoverX === null ? this.summary(d) : this.describe(d, (this.hoverX / w) * d.duration));
  }

  /** The sync at one time: of the nearest measured stretch. */
  private describe(d: MapData, t: number): string {
    let near: LocalOffset | null = null;
    for (const o of d.offsets) if (!near || Math.abs(o.time - t) < Math.abs(near.time - t)) near = o;
    const measure = this.editor.tempo.beatToMeasure(this.editor.tempo.timeToBeat(t));
    const where = `${mmss(t)}  ·  measure ${Math.max(0, Math.floor(measure))}`;
    if (!near || near.offset === null) return `${where}  ·  no clear attacks on the beats here`;
    const o = near.offset;
    return `${where}  ·  music ${fmtMs(o)} ${Math.abs(o) < 0.5 ? '(in sync)' : o > 0 ? '(after the beats)' : '(before the beats)'}`;
  }

  /** Overall: the typical offset and the furthest-off stretches. */
  private summary(d: MapData): string {
    const clear = d.offsets.filter((o): o is { time: number; offset: number } => o.offset !== null);
    if (!clear.length) return 'No clear attacks on the beats: is the BPM right?';
    const sorted = clear.map((o) => o.offset).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const lo = clear.reduce((a, o) => (o.offset < a.offset ? o : a));
    const hi = clear.reduce((a, o) => (o.offset > a.offset ? o : a));
    const spread = hi.offset - lo.offset < 6 ? '  ·  even throughout' : `  ·  from ${fmtMs(lo.offset)} at ${mmss(lo.time)} to ${fmtMs(hi.offset)} at ${mmss(hi.time)}`;
    return `Music vs beats: typically ${fmtMs(median)}${spread}  (above the middle: music after the beats)`;
  }
}
