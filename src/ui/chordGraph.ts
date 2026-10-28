// NPS graph window, after Etterna's Til' Death chord density graph: one bar per second of the
// song, as tall as its notes per second and shaded darker for notes in bigger chords (single,
// jump, hand, quad), mines in red, and a red line at 70% of the peak. Unlike Til' Death the
// shades are stacked, so a busy second shows every chord size it has. The orange band is the
// stretch the notefield shows; click or drag to move the main cursor.
//
// The window starts half as wide as the editor; drag it by its title, resize it from the corner.
// Unpinned it is a popup that closes on a click elsewhere; pinned it stays open, also in the next
// session.

import { fmtNum, type Editor } from '../editor/editor';
import { chordDensity, type ChordDensity } from '../model/density';
import { makeDraggable } from './dialogs';
import { h } from './dom';

const CHORD_NAMES = ['single', 'jump', 'hand', 'quad'];

const PIN_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M5 1h6v1.5l-1 1V7l2.5 2.5V11h-9V9.5L6 7V3.5l-1-1z"/><path fill="currentColor" d="M7.4 11h1.2v3.5L8 16l-.6-1.5z"/></svg>';

function chordName(size: number, count: number): string {
  const name = CHORD_NAMES[size - 1] ?? `${size}-chord`;
  return `${count} ${name}${count === 1 ? '' : 's'}`;
}

function mmss(t: number): string {
  const a = Math.abs(t);
  return `${t < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

export class ChordGraph {
  readonly el: HTMLElement;
  private readonly canvas = h('canvas', { class: 'nps-canvas' });
  private readonly info = h('div', { class: 'nps-info' });
  private readonly pin = h('button', { class: 'nps-pin', type: 'button' });
  private data: ChordDensity | null = null;
  private dataKey: unknown[] = [];
  private bars: HTMLCanvasElement | null = null;
  private barsKey: unknown[] = [];
  private hoverX: number | null = null;
  private dragging = false;
  private saveTimer = 0;

  constructor(
    private readonly editor: Editor,
    private readonly layer: HTMLElement,
    private readonly onSeek: () => void,
  ) {
    const s = editor.settings;
    // An unpinned graph is a popup: it does not come back on its own in the next session.
    if (!s.chordGraphPinned) s.showChordGraph = false;

    const close = h('button', { class: 'dlg-close', title: 'Close (Shift+G)', type: 'button' }, '×');
    const title = h('div', { class: 'dlg-title' }, h('span', {}, 'NPS graph'), h('div', { class: 'nps-buttons' }, this.pin, close));
    this.el = h('div', { class: 'dialog nps-window', hidden: true }, title, h('div', { class: 'nps-body' }, h('div', { class: 'nps-plot' }, this.canvas), this.info));
    this.pin.innerHTML = PIN_ICON;
    layer.append(this.el);
    this.updatePin();

    makeDraggable(this.el, title, () => this.saveGeometry());
    close.addEventListener('click', () => this.setOpen(false));
    this.pin.addEventListener('click', () => {
      s.chordGraphPinned = !s.chordGraphPinned;
      editor.saveSettings();
      this.updatePin();
      editor.hud(`NPS graph ${s.chordGraphPinned ? 'pinned: stays open' : 'unpinned: closes on a click elsewhere'}`);
    });
    // Bring to front before the canvas captures the pointer (moving it later would drop the capture).
    this.el.addEventListener(
      'pointerdown',
      () => {
        if (layer.lastElementChild !== this.el) layer.append(this.el);
      },
      true,
    );
    // Unpinned: a click anywhere else closes it (the menus and its own toolbar button excepted).
    window.addEventListener(
      'mousedown',
      (e) => {
        const t = e.target;
        if (this.el.hidden || s.chordGraphPinned || !(t instanceof Element)) return;
        if (this.el.contains(t) || t.closest('.menubar')) return;
        this.setOpen(false);
      },
      true,
    );
    new ResizeObserver(() => {
      this.place();
      this.draw();
    }).observe(layer);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    // Resizing from the corner: remember the size once the mouse stops.
    new ResizeObserver(() => {
      if (this.el.hidden) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.saveGeometry(), 250);
    }).observe(this.el);

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
    const show = this.editor.isOpen && this.editor.settings.showChordGraph;
    if (this.el.hidden === show) {
      this.el.hidden = !show;
      if (show) this.place();
    }
    if (show) this.draw();
  }

  private setOpen(open: boolean): void {
    const ed = this.editor;
    if (ed.settings.showChordGraph === open) return;
    ed.settings.showChordGraph = open;
    ed.saveSettings();
    ed.changed();
  }

  private updatePin(): void {
    const pinned = this.editor.settings.chordGraphPinned;
    this.pin.classList.toggle('pinned', pinned);
    this.pin.title = pinned ? 'Pinned: stays open while you edit. Click to unpin.' : 'Pin: keep it open while you edit (unpinned it closes on a click elsewhere).';
  }

  /**
   * Width is kept as a fraction of the editor and position as a fraction of the room around the
   * window, so both survive resizing the browser.
   */
  private place(): void {
    if (this.el.hidden) return;
    const s = this.editor.settings;
    this.el.style.width = `${(s.chordGraphW * 100).toFixed(2)}%`;
    this.el.style.height = `${Math.round(s.chordGraphH)}px`;
    const roomX = Math.max(0, this.layer.clientWidth - this.el.offsetWidth);
    const roomY = Math.max(0, this.layer.clientHeight - this.el.offsetHeight - 8);
    this.el.style.left = `${Math.round(s.chordGraphX * roomX)}px`;
    this.el.style.top = `${Math.round(s.chordGraphY * roomY)}px`;
  }

  private saveGeometry(): void {
    if (this.el.hidden || !this.layer.clientWidth) return;
    const s = this.editor.settings;
    s.chordGraphW = Math.min(1, this.el.offsetWidth / this.layer.clientWidth);
    s.chordGraphH = this.el.offsetHeight;
    const roomX = this.layer.clientWidth - this.el.offsetWidth;
    const roomY = this.layer.clientHeight - this.el.offsetHeight - 8;
    s.chordGraphX = roomX > 0 ? Math.min(1, Math.max(0, this.el.offsetLeft / roomX)) : 0.5;
    s.chordGraphY = roomY > 0 ? Math.min(1, Math.max(0, this.el.offsetTop / roomY)) : 1;
    this.editor.saveSettings();
  }

  private density(): ChordDensity {
    const ed = this.editor;
    const v = ed.view;
    const key = [ed.notes, ed.tempo, ed.numCols, v.beginTime, v.endTime];
    if (!this.data || key.some((k, i) => k !== this.dataKey[i])) {
      this.dataKey = key;
      this.data = chordDensity(ed.notes, ed.numCols, (row) => ed.tempo.rowToTime(row), Math.min(0, v.beginTime), v.endTime);
    }
    return this.data;
  }

  /** The graph moves the main pane, like the minimap: editing returns to it first. */
  private seek(x: number): void {
    const d = this.data;
    const w = this.canvas.clientWidth;
    if (!d || !w) return;
    const ed = this.editor;
    ed.sections.focusMain();
    ed.setCursorTime(d.start + (Math.min(w, Math.max(0, x)) / w) * d.total.length);
    this.onSeek();
  }

  private binLeft(i: number, n: number, w: number): number {
    return Math.floor((i * w) / n);
  }

  /** White background, stacked grey bars, mines and the 70% line; redrawn only when the chart changes. */
  private barsImage(d: ChordDensity, w: number, hgt: number, dpr: number): HTMLCanvasElement {
    const key = [d, w, hgt, dpr];
    if (this.bars && key.every((k, i) => k === this.barsKey[i])) return this.bars;
    this.barsKey = key;
    const img = this.bars ?? document.createElement('canvas');
    img.width = Math.round(w * dpr);
    img.height = Math.round(hgt * dpr);
    const ctx = img.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, hgt);
    const n = d.total.length;
    const cols = d.byChord.length;
    const peak = Math.max(1, d.peak);
    const plotH = hgt - 2;
    for (let i = 0; i < n; ++i) {
      const x0 = this.binLeft(i, n, w);
      const bw = Math.max(1, this.binLeft(i + 1, n, w) - x0);
      // Biggest chords at the bottom, black for a chord on every column, lighter for smaller ones.
      let y = hgt;
      for (let k = cols; k >= 1; --k) {
        const v = d.byChord[k - 1][i];
        if (!v) continue;
        const bh = (v / peak) * plotH;
        const g = Math.round(255 * (1 - k / cols));
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.fillRect(x0, y - bh, bw, bh);
        y -= bh;
      }
      if (d.mines[i]) {
        const bh = (Math.min(peak, d.mines[i]) / peak) * plotH;
        ctx.fillStyle = 'rgba(255,0,0,0.5)';
        ctx.fillRect(x0, hgt - bh, bw, bh);
      }
    }
    ctx.fillStyle = 'rgba(191,0,0,0.75)';
    ctx.fillRect(0, Math.round(hgt - 0.7 * plotH) - 1, w, 2);
    this.bars = img;
    return img;
  }

  private draw(): void {
    const ed = this.editor;
    const c = this.canvas;
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (this.el.hidden || !ed.isOpen || !w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const d = this.density();
    const n = d.total.length;
    ctx.drawImage(this.barsImage(d, w, hgt, dpr), 0, 0, w, hgt);
    const xOf = (t: number) => ((t - d.start) / n) * w;

    if (ed.region) {
      const a = xOf(ed.tempo.rowToTime(ed.region.begin));
      const b = xOf(ed.tempo.rowToTime(ed.region.end));
      ctx.fillStyle = 'rgba(60,190,60,0.35)';
      ctx.fillRect(a, 0, Math.max(1, b - a), hgt);
    }
    // The main pane's visible stretch and cursor, also while a side view is being edited.
    const v = ed.view;
    let top = 0;
    let bottom = 0;
    let cursor = 0;
    v.withPane(v.paneShiftX, ed.sections.mainDelta, () => {
      top = v.offsetToTime(v.yToOffset(0));
      bottom = v.offsetToTime(v.yToOffset(v.height));
      cursor = v.cursorTime;
    });
    const va = xOf(Math.min(top, bottom));
    const vb = xOf(Math.max(top, bottom));
    ctx.fillStyle = 'rgba(255,170,40,0.28)';
    ctx.fillRect(va, 0, Math.max(2, vb - va), hgt);
    ctx.fillStyle = '#ff8c00';
    ctx.fillRect(Math.round(xOf(cursor)) - 1, 0, 2, hgt);

    // The 70% line's label moves to the other end while the mouse is over it, as in Til' Death.
    const label = `${fmtNum(d.peak * 0.7, 1)} NPS`;
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    const lw = ctx.measureText(label).width;
    const lx = this.hoverX !== null && this.hoverX < lw + 12 ? w - lw - 4 : 4;
    ctx.fillStyle = '#d00000';
    ctx.fillText(label, lx, Math.round(hgt - 0.7 * (hgt - 2)) - 2);

    // The info line describes the second under the mouse, or else the one the cursor is in.
    const i = Math.min(n - 1, Math.max(0, this.hoverX !== null ? Math.floor((this.hoverX / w) * n) : Math.floor(cursor) - d.start));
    if (this.hoverX !== null) {
      const x0 = this.binLeft(i, n, w);
      ctx.strokeStyle = 'rgba(40,120,255,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 0.5, Math.max(1, this.binLeft(i + 1, n, w) - x0 - 1), hgt - 1);
    }
    const parts = d.byChord.map((counts, k) => (counts[i] ? chordName(k + 1, counts[i] / (k + 1)) : '')).filter(Boolean);
    if (d.mines[i]) parts.push(`${d.mines[i]} mine${d.mines[i] === 1 ? '' : 's'}`);
    const text = `${mmss(d.start + i)}  ·  ${d.total[i]} NPS${parts.length ? '  ·  ' + parts.join(', ') : ''}`;
    if (this.info.textContent !== text) this.info.textContent = text;
  }
}
