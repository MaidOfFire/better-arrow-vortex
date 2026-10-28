// Draws the notefield: waveform, beat lines, receptors, notes, tempo boxes and selections.

import { ONSET_BANDS, onsetAt } from '../analysis/onsets';
import { isLong, lowerBoundRow, rowQuant } from '../model/notes';
import { ROWS_PER_BEAT } from '../model/types';
import { SEGMENT_META, formatTime, segKey, type Editor, type Segment } from './editor';
import { IMAGE_SKINS, ImageSkin } from './imageSkin';
import type { Pane } from './sections';
import { Minimap } from './minimap';
import { Noteskin, QUANT_COLORS, bodyFill, roundRect } from './noteskin';
import type { ColumnShape } from '../model/styles';
import { SNAP_CUSTOM, SNAP_ROWS } from './view';

export interface DragBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mode: 'set' | 'add' | 'sub';
}

export interface BoxHit {
  seg: Segment;
  x: number;
  y: number;
  w: number;
  h: number;
}

const FONT = '11px "Segoe UI", system-ui, sans-serif';

interface FieldLayout {
  onsetsOn: boolean;
  waveOn: boolean;
  blockW: number;
  spacing: number;
}
/** Lane colours for the low / mid / high onset bands. */
export const ONSET_COLORS = ['#ff7043', '#66d36e', '#4fb3ff'];

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** Built-in drawn skin; also used for columns an image skin has no art for (pump centre, bars). */
  readonly skin = new Noteskin();
  readonly imageSkins = new Map<string, ImageSkin>();
  readonly minimap: Minimap;
  dpr = 1;
  dragBox: DragBox | null = null;
  /** Tempo box rectangles from the last frame, for mouse hit tests. */
  boxes: BoxHit[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly editor: Editor,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.minimap = new Minimap(editor, () => this.quantColors);
    for (const def of IMAGE_SKINS) this.imageSkins.set(def.id, new ImageSkin(def, () => (editor.needsRender = true)));
  }

  /** The selected image skin once its images have loaded. */
  private get image(): ImageSkin | null {
    const skin = this.imageSkins.get(this.editor.settings.noteskin);
    return skin?.ready ? skin : null;
  }

  get quantColors(): string[] {
    return this.imageSkins.get(this.editor.settings.noteskin)?.def.quantColors ?? QUANT_COLORS;
  }

  /** The image skin if it can draw this column (it only has arrow art). */
  private imageFor(shape: ColumnShape): ImageSkin | null {
    return shape.kind === 'arrow' ? this.image : null;
  }

  private drawHead(shape: ColumnShape, quant: number, x: number, y: number, size: number): void {
    const img = this.imageFor(shape);
    if (img && shape.kind === 'arrow') img.drawNote(this.ctx, shape.angle, quant, x, y, size);
    else this.ctx.drawImage(this.skin.note(shape, quant, size), x - size / 2, y - size / 2, size, size);
  }

  resize(width: number, height: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.skin.dpr = this.dpr;
    for (const skin of this.imageSkins.values()) skin.dpr = this.dpr;
    this.editor.view.width = width;
    this.editor.view.height = height;
    this.editor.needsRender = true;
  }

  /** Screen extent of each compare pane from the last frame, for mouse focus switching. */
  paneRects: { occurrence: number; main: boolean; left: number; right: number }[] = [];
  /** × buttons of the compare side views from the last frame. */
  closeButtons: { occurrence: number; x: number; y: number; w: number; h: number }[] = [];
  /** Horizontal scrollbar of the compare side views from the last frame, if shown. */
  hScroll: { x: number; y: number; w: number; h: number; thumbX: number; thumbW: number; maxScroll: number } | null = null;

  draw(): void {
    const { ctx, editor } = this;
    const view = editor.view;
    const s = editor.settings;
    this.skin.type = s.noteskin === 'bars' ? 'bars' : 'arrows';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, view.width, view.height);

    // Audio strip layout (also widens the notefield strip).
    const onsetsOn = s.showWaveform && s.audioView === 'onsets' && editor.onsets !== null;
    // The waveform also stands in while the onset analysis is still running.
    const waveOn = !onsetsOn && s.showWaveform && editor.waveform !== null;
    const spacing = view.applyZoom(24);
    const blockW = Math.max(16, (view.applyZoom(view.numCols * 64) - spacing * 2) / 2);
    view.waveformHalfWidth = waveOn ? blockW + spacing + 4 : 0;
    // Onsets get their own strip beside the notes so dense charts don't cover them.
    view.audioStripWidth = onsetsOn ? view.applyZoom(ONSET_BANDS.length * 38) : 0;
    view.paneShiftX = 0;
    const panes = editor.isOpen ? editor.sections.panes() : null;
    this.paneRects = [];
    this.closeButtons = [];
    this.hScroll = null;
    if (!panes) {
      this.drawField({ onsetsOn, waveOn, blockW, spacing }, null);
    } else {
      this.drawCompare(panes, { onsetsOn, waveOn, blockW, spacing });
    }
    this.drawDragBox();
    // While comparing, the minimap shows where the main pane is, not the pane being edited.
    if (s.showMinimap && editor.isOpen) view.withPane(view.paneShiftX, editor.sections.mainDelta, () => this.minimap.draw(ctx));
  }

  /**
   * Side views: the main notefield sits at the left with the audio track; the other occurrences
   * of the section the main cursor is in follow as side views, each with a thin progress line
   * and an ×. Switching the edited pane does not move anything. The row scrolls horizontally
   * when it is wider than the screen.
   */
  private drawCompare(panes: Pane[], layout: FieldLayout): void {
    const { ctx, editor } = this;
    const view = editor.view;
    const sec = editor.sections;
    const compare = sec.side;
    const withoutAudio = <T>(fn: () => T): T => {
      const saved = [view.audioStripWidth, view.waveformHalfWidth];
      view.audioStripWidth = 0;
      view.waveformHalfWidth = 0;
      try {
        return fn();
      } finally {
        [view.audioStripWidth, view.waveformHalfWidth] = saved;
      }
    };
    // Field extent relative to the receptor centre, with or without the audio track.
    const extentOf = (audio: boolean) => {
      const get = () => ({ left: view.fieldLeft - view.centerX, right: view.fieldRight - view.centerX });
      return audio ? get() : withoutAudio(get);
    };
    const margin = view.applyZoom(24);
    const mainExt = extentOf(true);
    const sideExt = extentOf(false);
    const mainW = mainExt.right - mainExt.left + margin * 2;
    const sideW = sideExt.right - sideExt.left + margin * 2 + 12;
    const base = view.width / 2 + view.receptorX; // receptor centre without any pane shift
    const shiftFor = (left: number, ext: { left: number }) => left + margin - ext.left - base;

    // One row, main first, scrolling horizontally when it doesn't fit.
    const regionRight = (editor.settings.showMinimap ? this.minimap.rect().x : view.width) - 10;
    const widths = panes.map((p) => (p.main ? mainW : sideW));
    const total = widths.reduce((t, w) => t + w, 0) + 24;
    const maxScroll = Math.max(0, total - regionRight);
    const lefts: number[] = [];
    let x = 24;
    for (const w of widths) {
      lefts.push(x);
      x += w;
    }
    const fi = panes.findIndex((p) => p.focused);
    if (compare.reveal) {
      // Scroll just enough to show the pane that was switched to.
      if (lefts[fi] - compare.scroll < 0) compare.scroll = lefts[fi] - 8;
      else if (lefts[fi] + widths[fi] - compare.scroll > regionRight) compare.scroll = lefts[fi] + widths[fi] - regionRight + 8;
      compare.reveal = false;
    }
    compare.scroll = Math.max(0, Math.min(compare.scroll, maxScroll));
    for (let i = 0; i < lefts.length; ++i) lefts[i] -= compare.scroll;
    const isVisible = (i: number) => lefts[i] + widths[i] > 0 && lefts[i] < regionRight;

    // The edited pane is compared with the main one (or, when editing the main one, with the
    // side view next to it); every other pane is compared with the edited one.
    const reference = (p: Pane): Pane[] => (p.main ? panes.slice(1, 2) : p.focused ? [panes[0]] : [panes[fi]]);
    const drawPane = (p: Pane, i: number) => {
      const audio = p.main;
      const draw = () => {
        this.drawField({ ...layout, onsetsOn: audio && layout.onsetsOn, waveOn: audio && layout.waveOn }, { pane: p, others: reference(p) });
        if (!p.main) this.drawProgressLine(lefts[i] + widths[i] - 10);
      };
      const shift = shiftFor(lefts[i], audio ? mainExt : sideExt);
      if (!p.focused) {
        view.withPane(shift, p.delta, () => (audio ? draw() : withoutAudio(draw)));
        return;
      }
      // The edited pane is drawn last and keeps its layout, so mouse input maps onto it.
      view.paneShiftX = shift;
      if (!audio) {
        view.audioStripWidth = 0;
        view.waveformHalfWidth = 0;
      }
      draw();
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, regionRight, view.height);
    ctx.clip();
    panes.forEach((p, i) => {
      if (!p.focused && isVisible(i)) drawPane(p, i);
    });
    drawPane(panes[fi], fi);
    for (let i = 1; i < panes.length; ++i) {
      ctx.fillStyle = '#444';
      ctx.fillRect(lefts[i] - 1, 0, 1, view.height);
    }
    ctx.restore();
    panes.forEach((p, i) => {
      if (!isVisible(i)) return;
      this.paneRects.push({ occurrence: p.occurrence, main: p.main, left: Math.max(0, lefts[i]), right: Math.min(lefts[i] + widths[i], regionRight) });
      if (!p.main) this.drawCloseButton(p.occurrence, lefts[i] + widths[i] - 24, 4, regionRight);
    });

    if (panes.length === 1) {
      // Not inside a section: say so where the side views would be.
      const x0 = lefts[0] + widths[0] + 16;
      if (x0 < regionRight - 60) {
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#8f8f8f';
        const lines = sec.groups.length
          ? ['Side views', 'Move into a section (coloured brackets)', 'to see its other occurrences here.']
          : ['Side views', 'No similar sections yet:', 'Sections menu (Shift+M) to find or mark them.'];
        lines.forEach((t, i) => ctx.fillText(t, x0, 40 + i * 18));
      }
    }

    // Horizontal scrollbar.
    this.hScroll = null;
    if (maxScroll > 0) {
      const trackX = 8;
      const trackW = regionRight - trackX;
      const thumbW = Math.max(30, (trackW * regionRight) / total);
      const thumbX = trackX + (compare.scroll / maxScroll) * (trackW - thumbW);
      this.hScroll = { x: trackX, y: view.height - 12, w: trackW, h: 10, thumbX, thumbW, maxScroll };
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(trackX, view.height - 10, trackW, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(thumbX, view.height - 10, thumbW, 6);
    }
  }

  /** The × that closes one side view. */
  private drawCloseButton(occurrence: number, x: number, y: number, clipRight: number): void {
    const ctx = this.ctx;
    const size = 18;
    if (x + size > clipRight || x < 0) return;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 5);
    ctx.lineTo(x + size - 5, y + size - 5);
    ctx.moveTo(x + size - 5, y + 5);
    ctx.lineTo(x + 5, y + size - 5);
    ctx.stroke();
    this.closeButtons.push({ occurrence, x, y, w: size, h: size });
  }

  /**
   * A thin white line standing for the whole song, with the part this pane shows drawn thicker
   * and a tick at its current position. Call while the view is set up for the pane.
   */
  private drawProgressLine(x: number): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const top = 28; // below the × button
    const h = v.height - 50;
    const begin = v.rowToOffset(0);
    const end = v.rowToOffset(editor.endRow());
    const yOf = (ofs: number) => {
      let f = end > begin ? (ofs - begin) / (end - begin) : 0;
      f = Math.min(1, Math.max(0, v.reverse ? 1 - f : f));
      return top + f * h;
    };
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x, top, 1, h);
    const ya = yOf(v.yToOffset(0));
    const yb = yOf(v.yToOffset(v.height));
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(x - 1, Math.min(ya, yb), 3, Math.max(2, Math.abs(yb - ya)));
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 4, Math.round(yOf(v.cursorOffset)) - 1, 9, 2);
  }

  /** One notefield: the main one, or a compare pane (`pane` set). */
  private drawField(layout: FieldLayout, compare: { pane: Pane; others: Pane[] } | null): void {
    const { ctx, editor } = this;
    const view = editor.view;
    const s = editor.settings;
    const { onsetsOn, waveOn, blockW, spacing } = layout;
    const focused = !compare || compare.pane.focused;

    if (waveOn) {
      ctx.fillStyle = '#000';
      ctx.fillRect(view.centerX - view.waveformHalfWidth, 0, view.waveformHalfWidth * 2, view.height);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(view.fieldLeft, 0, view.fieldRight - view.fieldLeft, view.height);
    }
    if (onsetsOn) {
      ctx.fillStyle = '#000';
      ctx.fillRect(view.stripLeft, 0, view.audioStripWidth, view.height);
    }

    if (!editor.isOpen) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(view.receptorLeft, view.receptorScreenY, view.receptorRight - view.receptorLeft, 1);
      this.boxes = [];
      return;
    }

    if (s.showBeatLines) this.drawBeatLines();
    if (onsetsOn) this.drawOnsets();
    else if (waveOn) this.drawWaveform(blockW, spacing);
    if (s.showTempoBoxes) this.drawStopsAndWarps();
    this.drawRegion();
    const side = compare && !compare.pane.main;
    if (side) this.drawPaneFrame(compare.pane);
    else if (s.showSections) this.drawSectionBrackets();
    // Outline the pane being edited, but only while that is a side view.
    if (compare && compare.pane.focused && editor.sections.side.focus !== null) this.drawEditOutline();
    this.drawReceptors();
    if (focused) this.drawSnapDiamonds();
    if (compare?.others.length && s.sectionGhosts) this.drawSectionGhosts(compare.pane, compare.others);
    if (editor.chart && s.showNotes) this.drawNotes();
    if (compare?.others.length && s.sectionDiffs) this.drawRhythmDiffs(compare.pane, compare.others);
    if (focused && editor.chart && editor.audio.playing) this.drawReceptorGlow();
    if (focused) this.drawGhostNotes();
    if (s.showTempoBoxes) this.drawTempoBoxes(focused);
    else if (focused) this.boxes = [];
    if (side) this.drawPaneLabel(compare.pane);
  }

  private visibleRows(margin = 64): [number, number] {
    const v = this.editor.view;
    const a = v.yToOffset(-margin);
    const b = v.yToOffset(v.height + margin);
    const ra = v.timeBased ? this.editor.tempo.timeToRow(a) : a;
    const rb = v.timeBased ? this.editor.tempo.timeToRow(b) : b;
    return [Math.floor(Math.min(ra, rb)), Math.ceil(Math.max(ra, rb))];
  }

  // ----------------------------------------------------------------------------------------------

  private drawBeatLines(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const s = editor.settings;
    const [r0, r1] = this.visibleRows();
    const beginBeat = Math.max(0, r0 / ROWS_PER_BEAT);
    const endBeat = Math.min(editor.endRow(), r1) / ROWS_PER_BEAT;
    if (endBeat < beginBeat) return;
    const zoomedIn = v.zoomLevel >= 4;
    const x = v.fieldLeft;
    const w = v.fieldRight - v.fieldLeft;
    const snapStep = s.beatLinesSnap && v.snapType > 0 ? 192 / v.snapQuant : ROWS_PER_BEAT;
    const labels: [number, number][] = [];
    editor.tempo.forEachMeasure(beginBeat, endBeat, (beat, measure, sig) => {
      const row = beat * ROWS_PER_BEAT;
      const y = Math.round(v.rowToY(row));
      ctx.fillStyle = s.beatLinesColor ? this.quantColors[0] : 'rgba(255,255,255,0.7)';
      ctx.fillRect(x, y, w, 1);
      labels.push([measure, y]);
      if (!zoomedIn) return;
      const measureEnd = row + sig.beatsPerMeasure * ROWS_PER_BEAT;
      for (let r = row + snapStep; r < measureEnd - 1e-6; r += snapStep) {
        const rr = Math.round(r);
        if (rr > r1) break;
        ctx.fillStyle = s.beatLinesColor ? hexAlpha(this.quantColors[rowQuant(rr)], 0.5) : 'rgba(255,255,255,0.3)';
        ctx.fillRect(x, Math.round(v.rowToY(rr)), w, 1);
      }
    });
    if (s.beatLinesHover && v.hoverRow >= 0) {
      ctx.fillStyle = s.beatLinesColor ? hexAlpha(this.quantColors[rowQuant(v.hoverRow)], 0.5) : 'rgba(255,255,255,0.5)';
      ctx.fillRect(x, Math.round(v.rowToY(v.hoverRow)) - 1, w, 3);
    }
    ctx.font = zoomedIn ? FONT : '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ddd';
    const lx = x - v.applyZoom(10) - 2;
    for (const [m, y] of labels) ctx.fillText(String(m), lx, y);
  }

  private drawWaveform(blockW: number, spacing: number): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const wf = editor.waveform!;
    const pw = blockW / 2;
    const xl = v.centerX - pw - spacing;
    const xr = v.centerX + pw + spacing;
    const step = 1;
    const pathL = new Path2D();
    const pathR = new Path2D();
    let t0 = v.offsetToTime(v.yToOffset(0));
    for (let y = 0; y < v.height; y += step) {
      const t1 = v.offsetToTime(v.yToOffset(y + step));
      if (Math.max(t0, t1) >= 0 && Math.min(t0, t1) <= wf.duration) {
        const l = Math.min(1, wf.peak(0, t0, t1)) * pw;
        const r = Math.min(1, wf.peak(1, t0, t1)) * pw;
        if (l > 0.25) pathL.rect(xl - l, y, l * 2, step);
        if (r > 0.25) pathR.rect(xr - r, y, r * 2, step);
      }
      t0 = t1;
    }
    ctx.fillStyle = editor.settings.waveFilter === 'none' ? 'rgb(102,153,102)' : 'rgb(204,204,128)';
    ctx.fill(pathL);
    ctx.fill(pathR);
  }

  /** Three lanes (low / mid / high) with a bar wherever that band has an attack. */
  private drawOnsets(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const data = editor.onsets!;
    const gap = 3;
    const laneW = (v.audioStripWidth - gap * (ONSET_BANDS.length + 1)) / ONSET_BANDS.length;
    const left = v.stripLeft + gap;
    const paths = ONSET_BANDS.map(() => new Path2D());
    let t0 = v.offsetToTime(v.yToOffset(0));
    for (let y = 0; y < v.height; ++y) {
      const t1 = v.offsetToTime(v.yToOffset(y + 1));
      for (let b = 0; b < ONSET_BANDS.length; ++b) {
        const w = onsetAt(data, b, t0, t1) * laneW;
        if (w > 0.5) paths[b].rect(left + b * (laneW + gap) + (laneW - w) / 2, y, w, 1);
      }
      t0 = t1;
    }
    ctx.globalAlpha = 0.9;
    paths.forEach((p, b) => {
      ctx.fillStyle = ONSET_COLORS[b];
      ctx.fill(p);
    });
    ctx.globalAlpha = 1;
    // Lane labels along the top edge.
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ONSET_BANDS.forEach((band, b) => {
      ctx.fillStyle = ONSET_COLORS[b];
      ctx.fillText(band.name, left + b * (laneW + gap) + laneW / 2, 4);
    });
  }

  private drawStopsAndWarps(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const x = v.fieldLeft;
    const w = v.fieldRight - v.fieldLeft;
    const fill = (a: number, b: number, color: string) => {
      const ya = v.offsetToY(a);
      const yb = v.offsetToY(b);
      const top = Math.max(0, Math.min(ya, yb));
      const bottom = Math.min(v.height, Math.max(ya, yb));
      if (bottom > top) {
        ctx.fillStyle = color;
        ctx.fillRect(x, top, w, bottom - top);
      }
    };
    if (v.timeBased) {
      for (const p of editor.tempo.points) {
        if (p.hit > p.arrive) fill(p.arrive, p.hit, 'rgba(26,128,128,0.5)');
        if (p.leave > p.hit) fill(p.hit, p.leave, 'rgba(128,128,51,0.5)');
      }
    } else {
      for (const wp of editor.timing.warps) {
        fill(wp.beat * ROWS_PER_BEAT, (wp.beat + wp.length) * ROWS_PER_BEAT, 'rgba(128,26,51,0.5)');
      }
    }
  }

  private drawRegion(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const x = v.receptorLeft;
    const w = v.receptorRight - v.receptorLeft;
    if (editor.regionStart !== null) {
      ctx.fillStyle = 'rgba(153,255,153,0.6)';
      ctx.fillRect(x, Math.round(v.rowToY(editor.regionStart)) - 1, w, 2);
    } else if (editor.region) {
      const ya = v.rowToY(editor.region.begin);
      const yb = v.rowToY(editor.region.end);
      ctx.fillStyle = 'rgba(153,255,153,0.35)';
      ctx.fillRect(x, Math.min(ya, yb), w, Math.abs(yb - ya));
      ctx.strokeStyle = 'rgba(153,255,153,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, Math.min(ya, yb) + 0.5, w - 1, Math.abs(yb - ya) - 1);
    }
  }

  private drawReceptors(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const y = v.receptorScreenY;
    if (!editor.chart) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(v.receptorLeft, y, v.receptorRight - v.receptorLeft, 1);
      return;
    }
    const size = v.colWidth;
    const beat = editor.tempo.timeToBeat(v.cursorTime);
    const frac = beat - Math.floor(beat);
    const pulse = Math.min(1, Math.max(0, 2 - frac * 4));
    const cols = editor.style.columns;
    for (let c = 0; c < cols.length; ++c) {
      const x = v.colX(c);
      const shape = cols[c];
      const img = this.imageFor(shape);
      if (img && shape.kind === 'arrow') {
        img.drawReceptor(ctx, shape.angle, x, y, size, beat);
        continue;
      }
      ctx.drawImage(this.skin.receptor(shape, size, false), x - size / 2, y - size / 2, size, size);
      if (pulse > 0) {
        ctx.globalAlpha = pulse;
        ctx.drawImage(this.skin.receptor(shape, size, true), x - size / 2, y - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawSnapDiamonds(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const y = v.receptorScreenY;
    const r = v.applyZoom(12);
    const rows = SNAP_ROWS[v.snapType];
    const colors = this.quantColors;
    const color = v.snapType === 0 ? '#666' : v.snapType === SNAP_CUSTOM || rows < 3 ? colors[8] : colors[rowQuant(rows)];
    const leftX = v.audioStripWidth ? v.stripLeft - v.applyZoom(16) : v.receptorLeft - v.applyZoom(20);
    for (const x of [leftX, v.receptorRight + v.applyZoom(20)]) {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (v.snapType !== 0) {
        ctx.font = `bold ${v.zoomLevel >= 4 ? 11 : 9}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        const text = String(v.snapQuant);
        ctx.strokeText(text, x, y + 0.5);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x, y + 0.5);
      }
    }
  }

  private drawNotes(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const notes = editor.notes;
    const size = v.colWidth;
    const half = size / 2;
    const cols = editor.style.columns;
    const [r0, r1] = this.visibleRows(size);
    // Holds that start above the screen: scan back by the longest hold.
    const startIdx = lowerBoundRow(notes, r0 - editor.maxHold);
    const first = lowerBoundRow(notes, r0);
    const visible: number[] = [];
    for (let i = startIdx; i < first; ++i) if (notes[i].endRow >= r0) visible.push(i);
    for (let i = first; i < notes.length && notes[i].row <= r1; ++i) visible.push(i);

    const selected = editor.selection;
    const bodyW = size * 0.56;
    // Pass 1: hold and roll bodies.
    for (const i of visible) {
      const n = notes[i];
      if (!isLong(n) || (n.type !== 'hold' && n.type !== 'roll')) continue;
      const x = v.colX(n.col);
      const y = v.rowToY(n.row);
      const ey = v.rowToY(n.endRow);
      const isSel = selected.has(n.row * 64 + n.col);
      const img = this.imageFor(cols[n.col] ?? cols[0]);
      if (img) {
        img.drawBody(ctx, n.type, x, y, ey, size, editor.settings.boldHolds);
        if (isSel) this.drawBodySelection(x, y, ey, bodyW);
      } else {
        this.drawBody(n.type, x, y, ey, bodyW, size, isSel);
      }
    }
    // Pass 2: heads.
    ctx.font = `bold ${Math.round(size * 0.3)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const i of visible) {
      const n = notes[i];
      if (n.row < r0 - 2) continue;
      const x = v.colX(n.col);
      const y = v.rowToY(n.row);
      const warped = editor.tempo.isWarped(n.row / ROWS_PER_BEAT);
      if (n.type === 'fake' || warped) ctx.globalAlpha = 0.45;
      const shape = cols[n.col] ?? cols[0];
      if (n.type === 'mine') {
        if (this.image) this.image.drawMine(ctx, x, y, size, v.cursorBeat);
        else ctx.drawImage(this.skin.mine(size), x - half, y - half, size, size);
      } else {
        this.drawHead(shape, rowQuant(n.row), x, y, size);
        if (n.type === 'lift' || n.type === 'fake') {
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#000';
          ctx.strokeText(n.type === 'lift' ? 'L' : 'F', x, y);
          ctx.fillStyle = '#fff';
          ctx.fillText(n.type === 'lift' ? 'L' : 'F', x, y);
        }
      }
      ctx.globalAlpha = 1;
      if (selected.has(n.row * 64 + n.col)) {
        const img = n.type === 'mine' ? null : this.imageFor(shape);
        if (img && shape.kind === 'arrow') img.drawSelection(ctx, shape.angle, rowQuant(n.row), x, y, size);
        else ctx.drawImage(this.skin.selection(n.type === 'mine' ? 'mine' : shape, size), x - half, y - half, size, size);
      }
    }
  }

  private drawBody(type: 'hold' | 'roll', x: number, y: number, ey: number, bodyW: number, size: number, selected: boolean): void {
    const ctx = this.ctx;
    const half = bodyW / 2;
    const dir = ey >= y ? 1 : -1;
    const capH = half * 0.8;
    // Body from the head centre to the tail, closed with a rounded cap.
    const path = new Path2D();
    path.moveTo(x - half, y);
    path.lineTo(x - half, ey);
    path.ellipse(x, ey, half, capH, 0, Math.PI, 0, dir > 0);
    path.lineTo(x + half, y);
    path.closePath();
    ctx.fillStyle = bodyFill(ctx, type, x, bodyW, selected);
    ctx.fill(path);
    if (type === 'roll') {
      // Diagonal stripes.
      ctx.save();
      ctx.clip(path);
      ctx.strokeStyle = 'rgba(20,20,60,0.35)';
      ctx.lineWidth = size * 0.07;
      const top = Math.min(y, ey) - capH;
      const bottom = Math.max(y, ey) + capH;
      for (let sy = top - bodyW; sy < bottom + bodyW; sy += size * 0.32) {
        ctx.beginPath();
        ctx.moveTo(x - half, sy);
        ctx.lineTo(x + half, sy + bodyW * 0.55);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.lineWidth = selected ? 2 : 1.5;
    ctx.strokeStyle = selected ? '#fff' : 'rgba(0,0,0,0.8)';
    ctx.stroke(path);
  }

  /** White outline around a selected image-skin hold body. */
  private drawBodySelection(x: number, y: number, ey: number, bodyW: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x - bodyW / 2, Math.min(y, ey), bodyW, Math.abs(ey - y));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - bodyW / 2, Math.min(y, ey), bodyW, Math.abs(ey - y));
  }

  private drawReceptorGlow(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const notes = editor.notes;
    const time = v.cursorTime;
    const size = v.colWidth;
    const cols = editor.style.columns;
    const lastEnd: number[] = new Array(cols.length).fill(-Infinity);
    const r1 = v.cursorRow + 1;
    for (let i = lowerBoundRow(notes, r1 - ROWS_PER_BEAT * 16); i < notes.length && notes[i].row <= r1; ++i) {
      const n = notes[i];
      if (n.type === 'mine' || n.type === 'fake' || n.col >= cols.length) continue;
      const t = editor.tempo.rowToTime(n.row);
      if (t > time) continue;
      lastEnd[n.col] = Math.max(lastEnd[n.col], isLong(n) ? editor.tempo.rowToTime(n.endRow) : t);
    }
    for (let c = 0; c < cols.length; ++c) {
      const lum = 1.5 - (time - lastEnd[c]) * 6;
      if (lum <= 0) continue;
      ctx.globalAlpha = Math.min(1, lum);
      const shape = cols[c];
      const img = this.imageFor(shape);
      if (img && shape.kind === 'arrow') img.drawGlow(ctx, shape.angle, v.colX(c), v.receptorScreenY, size);
      else ctx.drawImage(this.skin.glow(shape, size), v.colX(c) - size / 2, v.receptorScreenY - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawGhostNotes(): void {
    const { ctx, editor } = this;
    if (!editor.placing.size || !editor.chart) return;
    const v = editor.view;
    const size = v.colWidth;
    const cols = editor.style.columns;
    const cur = v.snapRow(v.cursorRow, 'closest');
    ctx.globalAlpha = 0.6;
    for (const [col, p] of editor.placing) {
      if (p.mode === 'afterRemove' && p.startRow === cur) continue;
      const row = Math.min(p.startRow, cur);
      const end = Math.max(p.startRow, cur);
      const x = v.colX(col);
      const img = this.imageFor(cols[col]);
      if (end > row) {
        if (img) img.drawBody(ctx, 'hold', x, v.rowToY(row), v.rowToY(end), size, editor.settings.boldHolds);
        else this.drawBody('hold', x, v.rowToY(row), v.rowToY(end), size * 0.56, size, false);
      }
      this.drawHead(cols[col], rowQuant(row), x, v.rowToY(row), size);
    }
    ctx.globalAlpha = 1;
  }

  private drawTempoBoxes(record: boolean): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const [r0, r1] = this.visibleRows(32);
    if (record) this.boxes = [];
    if (v.scaleLevel < 2) return;
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const h = 16;
    const stacks = new Map<string, number>();
    for (const seg of editor.segments()) {
      const row = seg.beat * ROWS_PER_BEAT;
      if (row < r0 || row > r1) continue;
      const meta = SEGMENT_META[seg.type];
      const y = Math.round(v.rowToY(row));
      const text = seg.text;
      const w = Math.ceil(ctx.measureText(text).width) + 12;
      const stackKey = `${meta.side}:${row}`;
      const offset = stacks.get(stackKey) ?? 2;
      stacks.set(stackKey, offset + w + 2);
      const leftEdge = v.audioStripWidth ? v.stripLeft - 2 : v.receptorLeft;
      const x = meta.side === 'left' ? leftEdge - offset - w : v.receptorRight + offset;
      const selected = editor.selectedSegments.has(segKey(seg.type, seg.beat));
      ctx.beginPath();
      roundRect(ctx, x, y - h / 2, w, h, 3);
      ctx.fillStyle = meta.color;
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = selected ? '#fff' : 'rgba(255,255,255,0.35)';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(text, x + w / 2, y + 0.5);
      if (record) this.boxes.push({ seg, x, y: y - h / 2, w, h });
    }
  }

  /** Coloured bars beside the field marking every occurrence of every section group. */
  private drawSectionBrackets(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const sec = editor.sections;
    if (!sec.groups.length) return;
    const [r0, r1] = this.visibleRows();
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // One column per nesting level: whole sections outermost, parts further in.
    sec.ordered.forEach(({ group: g, depth }) => {
      const color = sec.colorOf(g);
      const active = g.id === sec.activeId;
      const x = v.fieldLeft + 2 + Math.min(depth, 3) * 6;
      g.starts.forEach((start, k) => {
        const end = start + g.length;
        if (end < r0 || start > r1) return;
        const ya = v.rowToY(start);
        const yb = v.rowToY(end);
        ctx.fillStyle = color;
        ctx.globalAlpha = active ? 1 : 0.7;
        ctx.fillRect(x, Math.min(ya, yb), active ? 4 : 3, Math.abs(yb - ya));
        ctx.fillRect(x, ya - 1, 10, 2);
        ctx.globalAlpha = 1;
        // Nested parts often start on the same row as their parent: stagger the labels.
        const dy = 8 + Math.min(depth, 3) * 11;
        ctx.fillText(sec.occurrenceLabel(g, k), x + 6, ya + (v.reverse ? -dy : dy));
      });
    });
  }

  /** Dims rows outside the pane's occurrence and labels the pane. */
  private drawPaneFrame(pane: Pane): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const sec = editor.sections;
    const g = sec.shownGroup!;
    const color = sec.colorOf(g);
    const x = v.fieldLeft;
    const w = v.fieldRight - v.fieldLeft;
    const ya = v.rowToY(pane.start);
    const yb = v.rowToY(pane.start + g.length);
    const top = Math.min(ya, yb);
    const bottom = Math.max(ya, yb);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    if (top > 0) ctx.fillRect(x, 0, w, Math.min(v.height, top));
    if (bottom < v.height) ctx.fillRect(x, Math.max(0, bottom), w, v.height - Math.max(0, bottom));
    ctx.fillStyle = color;
    ctx.fillRect(x, ya - 1, w, 2);
    ctx.fillRect(x, yb - 1, w, 2);
  }

  private drawEditOutline(): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const g = editor.sections.shownGroup;
    ctx.strokeStyle = g ? editor.sections.colorOf(g) : '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(v.fieldLeft + 1, 1, v.fieldRight - v.fieldLeft - 2, v.height - 2);
  }

  /** "A2 · m129" tag at the top of a compare pane, drawn above the notes. */
  private drawPaneLabel(pane: Pane): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const sec = editor.sections;
    const g = sec.shownGroup!;
    const color = sec.colorOf(g);
    const time = formatTime(editor.tempo.rowToTime(pane.start)).replace(/\.\d+$/, '');
    const label = `${sec.occurrenceLabel(g, pane.occurrence)} · ${sec.measureLabel(pane.start)} · ${time}${pane.focused ? ' (editing)' : ''}`;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(v.centerX - tw / 2, 18, tw, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, v.centerX, 21);
  }


  /** Faint copies of the other occurrences' notes, so rhythm can be matched while re-patterning. */
  private drawSectionGhosts(pane: Pane, others: Pane[]): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const g = editor.sections.shownGroup!;
    const [r0, r1] = this.visibleRows();
    const rel0 = Math.max(0, r0 - pane.start);
    const rel1 = Math.min(g.length, r1 - pane.start + 1);
    if (rel1 <= rel0) return;
    const size = v.colWidth;
    const cols = editor.style.columns;
    const seen = new Set<number>();
    ctx.globalAlpha = 0.3;
    for (const other of others.map((p) => p.start)) {
      for (const n of editor.sections.notesIn(other + rel0, rel1 - rel0)) {
        if (n.type === 'fake' || n.col >= cols.length) continue;
        const row = pane.start + (n.row - other);
        const key = row * 64 + n.col;
        if (seen.has(key)) continue;
        seen.add(key);
        const x = v.colX(n.col);
        const y = v.rowToY(row);
        if (n.type === 'mine') {
          if (this.image) this.image.drawMine(ctx, x, y, size, v.cursorBeat);
          else ctx.drawImage(this.skin.mine(size), x - size / 2, y - size / 2, size, size);
        } else {
          this.drawHead(cols[n.col], rowQuant(row), x, y, size);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Ticks beside the receptors on rows where this occurrence's rhythm differs from the others.
   * Red where the audio there is also similar (probably an inconsistency), grey where the
   * music itself differs (probably intended).
   */
  private drawRhythmDiffs(pane: Pane, others: Pane[]): void {
    const { ctx, editor } = this;
    const v = editor.view;
    const sec = editor.sections;
    const g = sec.shownGroup!;
    const [r0, r1] = this.visibleRows();
    const rel0 = Math.max(0, r0 - pane.start);
    const rel1 = Math.min(g.length, r1 - pane.start + 1);
    if (rel1 <= rel0) return;
    const rowsOf = (start: number) => {
      const set = new Set<number>();
      for (const n of sec.notesIn(start + rel0, rel1 - rel0)) if (n.type !== 'mine' && n.type !== 'fake') set.add(n.row - start);
      return set;
    };
    const mine = rowsOf(pane.start);
    const x = v.receptorLeft - v.applyZoom(11);
    const w = v.applyZoom(8);
    for (const other of others.map((p) => p.start)) {
      const theirs = rowsOf(other);
      const diff = [...mine].filter((r) => !theirs.has(r)).concat([...theirs].filter((r) => !mine.has(r)));
      for (const rel of diff) {
        const sim = sec.similarityAt(pane.start + rel, other + rel);
        ctx.fillStyle = sim === null ? '#ffb74d' : sim > 0.45 ? '#ff5252' : '#8a8a8a';
        ctx.fillRect(x, Math.round(v.rowToY(pane.start + rel)) - 1, w, 3);
      }
    }
  }

  private drawDragBox(): void {
    const b = this.dragBox;
    if (!b) return;
    const { ctx } = this;
    const x = Math.min(b.x0, b.x1);
    const y = Math.min(b.y0, b.y1);
    const w = Math.abs(b.x1 - b.x0);
    const h = Math.abs(b.y1 - b.y0);
    ctx.fillStyle = 'rgba(255,191,128,0.35)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,191,128,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    if (b.mode !== 'set') {
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.mode === 'add' ? '+' : '−', b.x0, b.y0 - 10);
    }
  }
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
