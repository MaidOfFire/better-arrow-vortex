// The overview strip at the right edge: the whole chart in miniature, click or drag to seek.
// When similar sections exist, each group gets its own labelled lane to the left of the notes,
// so groups can be told apart and clicked.

import { isLong, rowQuant } from '../model/notes';
import type { Note } from '../model/types';
import type { Editor } from './editor';
import type { SectionGroup } from './sections';

const HOLD_COLOR = 'rgb(64,128,0)';
const ROLL_COLOR = 'rgb(96,96,128)';
const MINE_COLOR = 'rgb(192,192,192)';

const NOTES_W = 24;
const LANE_W = 11;
const LABEL_H = 14;
/** Deeper levels share the last lane. */
const MAX_LANES = 3;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Minimap {
  private image: HTMLCanvasElement | null = null;
  private cacheKey: unknown[] = [];

  constructor(
    private readonly editor: Editor,
    private readonly quantColors: () => string[],
  ) {}

  /** One lane per nesting level, each holding that level's groups (none when brackets are hidden). */
  private lanes(): SectionGroup[][] {
    const ed = this.editor;
    if (!ed.settings.showSections || !ed.sections.groups.length) return [];
    const lanes: SectionGroup[][] = [];
    for (const { group, depth } of ed.sections.ordered) {
      const i = Math.min(depth, MAX_LANES - 1);
      while (lanes.length <= i) lanes.push([]);
      lanes[i].push(group);
    }
    return lanes;
  }

  private lanesWidth(): number {
    const n = this.lanes().length;
    return n ? n * LANE_W + 4 : 0;
  }

  /** Whole minimap including section lanes. */
  rect(): Rect {
    const v = this.editor.view;
    const lanes = this.lanesWidth();
    const w = NOTES_W + lanes;
    const y = lanes ? 8 + LABEL_H : 8;
    return { x: v.width - 8 - w, y, w, h: Math.max(16, v.height - y - 8) };
  }

  /** The area notes are mapped into (inside the border). */
  private mapRect(): Rect {
    const r = this.rect();
    return { x: r.x + r.w - NOTES_W + 2, y: r.y + 2, w: NOTES_W - 4, h: r.h - 4 };
  }

  private laneX(i: number): number {
    return this.rect().x + 2 + i * LANE_W;
  }

  contains(x: number, y: number): boolean {
    if (!this.editor.settings.showMinimap || !this.editor.isOpen) return false;
    const r = this.rect();
    return x >= r.x && x < r.x + r.w && y >= r.y - (this.lanesWidth() ? LABEL_H : 0) && y < r.y + r.h;
  }

  /** The section occurrence under a point in the lanes, if any. */
  laneAt(x: number, y: number): { group: SectionGroup; index: number } | null {
    const lanes = this.lanes();
    if (!lanes.length || !this.contains(x, y)) return null;
    const lane = lanes[Math.floor((x - this.rect().x - 2) / LANE_W)];
    if (!lane) return null;
    const m = this.mapRect();
    const v = this.editor.view;
    // The closest occurrence in this lane, preferring the shortest group when several overlap.
    let best: { group: SectionGroup; index: number } | null = null;
    let bestKey = [4, Infinity];
    for (const g of lane) {
      g.starts.forEach((start, k) => {
        const y0 = this.offsetToY(m, v.rowToOffset(start));
        const y1 = this.offsetToY(m, v.rowToOffset(start + g.length));
        const d = y < Math.min(y0, y1) ? Math.min(y0, y1) - y : y > Math.max(y0, y1) ? y - Math.max(y0, y1) : 0;
        if (d < bestKey[0] || (d === bestKey[0] && g.length < bestKey[1])) {
          bestKey = [d, g.length];
          best = { group: g, index: k };
        }
      });
    }
    return best;
  }

  private range(): [number, number] {
    const v = this.editor.view;
    return [v.rowToOffset(0), v.rowToOffset(this.editor.endRow())];
  }

  /** Chart offset at a screen y inside the minimap. */
  yToOffset(y: number): number {
    const m = this.mapRect();
    const [a, b] = this.range();
    let f = (y - m.y) / m.h;
    if (this.editor.view.reverse) f = 1 - f;
    return a + Math.min(1, Math.max(0, f)) * (b - a);
  }

  private offsetToY(m: Rect, ofs: number): number {
    const [a, b] = this.range();
    let f = b > a ? (ofs - a) / (b - a) : 0;
    if (this.editor.view.reverse) f = 1 - f;
    return m.y + f * m.h;
  }

  /** Orange band for the rows the current view shows. */
  private drawViewRange(ctx: CanvasRenderingContext2D, m: Rect, x: number, w: number): void {
    const v = this.editor.view;
    const ya = this.offsetToY(m, v.yToOffset(0));
    const yb = this.offsetToY(m, v.yToOffset(v.height));
    const top = Math.max(m.y, Math.min(ya, yb));
    const bottom = Math.min(m.y + m.h, Math.max(ya, yb));
    if (bottom > top) {
      ctx.fillStyle = 'rgba(255,204,102,0.45)';
      ctx.fillRect(x, top, w, Math.max(2, bottom - top));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const editor = this.editor;
    const v = editor.view;
    const r = this.rect();
    const notesX = r.x + r.w - NOTES_W;
    ctx.fillStyle = '#fff';
    ctx.fillRect(notesX, r.y, NOTES_W, r.h);
    ctx.fillStyle = '#000';
    ctx.fillRect(notesX + 1, r.y + 1, NOTES_W - 2, r.h - 2);
    const m = this.mapRect();

    if (editor.region) {
      const ya = this.offsetToY(m, v.rowToOffset(editor.region.begin));
      const yb = this.offsetToY(m, v.rowToOffset(editor.region.end));
      ctx.fillStyle = 'rgba(153,255,153,0.6)';
      ctx.fillRect(m.x, Math.min(ya, yb), m.w, Math.max(1, Math.abs(yb - ya)));
    }
    ctx.fillStyle = 'rgb(128,128,128)';
    ctx.fillRect(m.x, m.y, m.w, 1);
    ctx.fillRect(m.x, m.y + m.h - 1, m.w, 1);

    const img = this.getImage(m.w, m.h);
    if (img) ctx.drawImage(img, m.x, m.y, m.w, m.h);
    this.drawLanes(ctx, m);
    this.drawViewRange(ctx, m, r.x, r.w);
  }

  /**
   * One lane per nesting level (1 = whole sections, 2 = parts inside them, …); each block is an
   * occurrence in its group's colour, the active group's blocks outlined in white.
   */
  private drawLanes(ctx: CanvasRenderingContext2D, m: Rect): void {
    const lanes = this.lanes();
    if (!lanes.length) return;
    const ed = this.editor;
    const v = ed.view;
    const sec = ed.sections;
    const r = this.rect();
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(r.x, r.y, lanes.length * LANE_W + 4, r.h);
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lanes.forEach((lane, i) => {
      const x = this.laneX(i);
      const w = LANE_W - 2;
      ctx.fillStyle = '#181818';
      ctx.fillRect(x, m.y, w, m.h);
      // Longer groups first so shorter, overlapping ones stay visible on top.
      for (const g of [...lane].sort((a, b) => b.length - a.length)) {
        const active = g.id === sec.activeId;
        for (const start of g.starts) {
          const y0 = this.offsetToY(m, v.rowToOffset(start));
          const y1 = this.offsetToY(m, v.rowToOffset(start + g.length));
          const top = Math.min(y0, y1);
          const h = Math.max(2, Math.abs(y1 - y0));
          ctx.globalAlpha = active ? 1 : 0.8;
          ctx.fillStyle = sec.colorOf(g);
          ctx.fillRect(x, top, w, h);
          ctx.globalAlpha = 1;
          if (active) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - 0.5, top - 0.5, w + 1, h + 1);
          }
        }
      }
      ctx.fillStyle = '#aaa';
      ctx.fillText(String(i + 1), x + w / 2, r.y - LABEL_H / 2);
    });
  }

  private getImage(w: number, h: number): HTMLCanvasElement | null {
    const editor = this.editor;
    const v = editor.view;
    const key = [editor.notes, editor.tempo, editor.settings.minimapMode, this.quantColors(), w, h, v.timeBased, v.reverse, editor.numCols, editor.endRow()];
    if (this.image && key.every((k, i) => k === this.cacheKey[i])) return this.image;
    this.cacheKey = key;
    const dpr = window.devicePixelRatio || 1;
    const c = this.image ?? document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const [a, b] = this.range();
    const span = b - a || 1;
    const yOf = (row: number) => {
      const f = (v.rowToOffset(row) - a) / span;
      return (v.reverse ? 1 - f : f) * h;
    };
    if (editor.settings.minimapMode === 'density') this.drawDensity(ctx, w, h, yOf);
    else this.drawNotes(ctx, w, editor.notes, yOf);
    this.image = c;
    return c;
  }

  private drawNotes(ctx: CanvasRenderingContext2D, w: number, notes: readonly Note[], yOf: (row: number) => number): void {
    const cols = this.editor.numCols;
    const mapW = Math.min(w, 16);
    const x0 = (w - mapW) / 2;
    const nw = mapW / cols;
    for (const n of notes) {
      if (n.col >= cols) continue;
      const x = x0 + n.col * nw;
      const y = yOf(n.row);
      if (isLong(n) && (n.type === 'hold' || n.type === 'roll')) {
        const ey = yOf(n.endRow);
        ctx.fillStyle = n.type === 'roll' ? ROLL_COLOR : HOLD_COLOR;
        ctx.fillRect(x, Math.min(y, ey), nw, Math.abs(ey - y));
      }
      ctx.fillStyle = n.type === 'mine' ? MINE_COLOR : this.quantColors()[rowQuant(n.row)];
      ctx.fillRect(x, y, Math.max(1, nw - 0.5), 1);
    }
  }

  private drawDensity(ctx: CanvasRenderingContext2D, w: number, h: number, yOf: (row: number) => number): void {
    const bands = Math.max(1, Math.floor(h / 2));
    const counts = new Float32Array(bands);
    for (const n of this.editor.notes) {
      if (n.type === 'mine' || n.type === 'fake') continue;
      const i = Math.floor((yOf(n.row) / h) * bands);
      if (i >= 0 && i < bands) counts[i]++;
    }
    let max = 0;
    for (const c of counts) max = Math.max(max, c);
    if (!max) return;
    for (let i = 0; i < bands; ++i) {
      const f = counts[i] / max;
      if (!f) continue;
      const hue = 240 - f * 240;
      ctx.fillStyle = `hsl(${hue},90%,55%)`;
      ctx.fillRect(0, (i * h) / bands, f * w, h / bands + 0.5);
    }
  }
}
