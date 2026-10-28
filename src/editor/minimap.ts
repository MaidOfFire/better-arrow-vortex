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

/** Where an occurrence was drawn in the lanes. */
interface Block extends Rect {
  group: SectionGroup;
  index: number;
}

export class Minimap {
  private image: HTMLCanvasElement | null = null;
  private cacheKey: unknown[] = [];
  private blocks: Block[] = [];

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

  /** The section occurrence under a point in the lanes, if any (as last drawn). */
  laneAt(x: number, y: number): { group: SectionGroup; index: number } | null {
    if (!this.lanes().length || !this.contains(x, y)) return null;
    // The block under the point (deeper parts are drawn last, on top), else the nearest one in
    // that lane within a few pixels, so short blocks are easy to hit.
    for (let i = this.blocks.length - 1; i >= 0; --i) {
      const b = this.blocks[i];
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b;
    }
    const lane = Math.floor((x - this.rect().x - 2) / LANE_W);
    let best: Block | null = null;
    let bestD = 4;
    for (const b of this.blocks) {
      if (Math.floor((b.x - this.rect().x - 2) / LANE_W) !== lane) continue;
      const d = y < b.y ? b.y - y : y > b.y + b.h ? y - b.y - b.h : 0;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
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
   * Where each occurrence goes in the lanes. Occurrences of one level that overlap (sections that
   * partly cover each other) are put side by side, only where they overlap. Levels deeper than
   * there are lanes become a narrower stripe inside the block of the part they belong to.
   */
  private layoutLanes(m: Rect): Block[] {
    const sec = this.editor.sections;
    const v = this.editor.view;
    const blocks: Block[] = [];
    const span = (s: number, e: number) => {
      const y0 = this.offsetToY(m, v.rowToOffset(s));
      const y1 = this.offsetToY(m, v.rowToOffset(e));
      return { y: Math.min(y0, y1), h: Math.max(2, Math.abs(y1 - y0)) };
    };
    this.lanes().forEach((lane, i) => {
      const x = this.laneX(i);
      const w = LANE_W - 2;
      const items = lane
        .filter((g) => sec.depthOf(g) === i)
        .flatMap((group) => group.starts.map((start, index) => ({ group, index, start, end: start + group.length })))
        .sort((a, b) => a.start - b.start || b.end - a.end);
      // Runs of overlapping occurrences share the lane width, each in the first free column.
      for (let k = 0; k < items.length; ) {
        let end = items[k].end;
        let j = k + 1;
        while (j < items.length && items[j].start < end) end = Math.max(end, items[j++].end);
        const ends: number[] = [];
        const cols = items.slice(k, j).map((it) => {
          let c = ends.findIndex((e) => e <= it.start);
          if (c < 0) c = ends.push(0) - 1;
          ends[c] = it.end;
          return c;
        });
        const cw = w / ends.length;
        items.slice(k, j).forEach((it, n) => blocks.push({ group: it.group, index: it.index, x: x + cols[n] * cw, w: ends.length > 1 ? cw - 1 : w, ...span(it.start, it.end) }));
        k = j;
      }
      // Deeper levels (shallowest first, so their parents are placed): inside the parent's block.
      const deeper = lane.filter((g) => sec.depthOf(g) > i).sort((a, b) => sec.depthOf(a) - sec.depthOf(b));
      for (const group of deeper) {
        const parent = sec.parentOf(group);
        group.starts.forEach((start, index) => {
          const end = start + group.length;
          const host = blocks.find((b) => b.group === parent && Math.min(end, parent.starts[b.index] + parent.length) - Math.max(start, parent.starts[b.index]) >= 0.5 * group.length);
          const bx = host ? host.x : x;
          const bw = host ? host.w : w;
          blocks.push({ group, index, x: bx + Math.min(2, bw / 4), w: Math.max(2, bw - 2 * Math.min(2, bw / 4)), ...span(start, end) });
        });
      }
    });
    return blocks;
  }

  /**
   * One lane per nesting level (1 = whole sections, 2 = parts inside them, …); each block is an
   * occurrence in its group's colour, the active group's blocks outlined in white.
   */
  private drawLanes(ctx: CanvasRenderingContext2D, m: Rect): void {
    const lanes = this.lanes();
    this.blocks = [];
    if (!lanes.length) return;
    const sec = this.editor.sections;
    const r = this.rect();
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(r.x, r.y, lanes.length * LANE_W + 4, r.h);
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lanes.forEach((_, i) => {
      const x = this.laneX(i);
      ctx.fillStyle = '#181818';
      ctx.fillRect(x, m.y, LANE_W - 2, m.h);
      ctx.fillStyle = '#aaa';
      ctx.fillText(String(i + 1), x + (LANE_W - 2) / 2, r.y - LABEL_H / 2);
    });
    this.blocks = this.layoutLanes(m);
    for (const b of this.blocks) {
      const active = b.group.id === sec.activeId;
      // Deeper parts drawn on their parent's block get a dark edge so they stand apart from it.
      if (sec.depthOf(b.group) >= MAX_LANES) {
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(b.x - 1, b.y, b.w + 2, b.h);
      }
      ctx.globalAlpha = active ? 1 : 0.85;
      ctx.fillStyle = sec.colorOf(b.group);
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
      if (active) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x - 0.5, b.y - 0.5, b.w + 1, b.h + 1);
      }
    }
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
