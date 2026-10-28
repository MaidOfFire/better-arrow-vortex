// Wires the editor, renderer and UI together and handles keyboard and mouse input.

import { Editor, segKey, type SegmentType } from '../editor/editor';
import {
  AUDIO_EXTS,
  FileSource,
  SIMFILE_EXTS,
  pickDirectory,
  pickFiles,
  resolveSource,
  sourceFromDrop,
} from '../editor/files';
import { Renderer } from '../editor/renderer';
import { loadSimfile } from '../model/simfileIO';
import { ROWS_PER_BEAT } from '../model/types';
import { ChordGraph } from '../ui/chordGraph';
import { Dialog, SegmentDialog, createDialog, type DialogHost } from '../ui/dialogs';
import { button, h } from '../ui/dom';
import { Hud } from '../ui/hud';
import { Menubar } from '../ui/menubar';
import { Statusbar } from '../ui/statusbar';
import { createActions, eventToShortcut, type Action, type ActionHost, type DialogId } from './actions';
import { makeDemo } from './demo';

export const APP_NAME = 'Better Arrow Vortex';

type Drag =
  | { kind: 'select'; x0: number; ofs0: number; mode: 'set' | 'add' | 'sub'; x1: number; y1: number }
  | { kind: 'receptors'; dx: number; dy: number }
  | { kind: 'minimap' }
  | { kind: 'hscroll'; grab: number };

export class App implements ActionHost, DialogHost {
  readonly editor = new Editor();
  readonly actions: Map<string, Action>;
  readonly layer: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly menubar: Menubar;
  private readonly statusbar: Statusbar;
  private readonly chordGraph: ChordGraph;
  private readonly hudView = new Hud();
  private readonly welcome: HTMLElement;
  private readonly sideViewsButton: HTMLButtonElement;
  private sideViewsState = '';
  private readonly dialogs = new Map<string, Dialog>();
  private readonly shortcuts = new Map<string, Action>();
  private readonly heldColumns = new Map<string, number>();
  private drag: Drag | null = null;
  private wheelAcc = 0;

  constructor(root: HTMLElement) {
    const ed = this.editor;
    ed.hud = (text, kind) => this.hudView.show(text, kind);
    this.actions = createActions(this);
    for (const a of this.actions.values()) for (const k of a.keys) this.shortcuts.set(k, a);

    this.menubar = new Menubar(this.actions, (a) => this.run(a));
    this.sideViewsButton = button('Side views', () => this.run(this.actions.get('sections.compare')!));
    this.sideViewsButton.className = 'toolbar-btn';
    this.menubar.el.append(h('div', { class: 'menu-spacer' }), this.sideViewsButton);
    this.statusbar = new Statusbar(ed);
    this.canvas = h('canvas', { class: 'notefield', tabindex: 0 });
    this.chordGraph = new ChordGraph(ed, () => this.canvas.focus());
    this.layer = h('div', { class: 'dialog-layer' });
    this.welcome = h(
      'div',
      { class: 'welcome' },
      h('h1', {}, APP_NAME),
      h('p', {}, 'Open a simfile folder (with its .sm/.ssc and music), drop files or a folder here, or start from a music file.'),
      h(
        'div',
        { class: 'welcome-buttons' },
        button('Open folder…', () => void this.openSimfile()),
        button('Open files…', () => void this.openFilesFallback()),
        button('Try a demo chart', () => void this.openDemo()),
      ),
      h('p', { class: 'hint' }, 'Press F1 for shortcuts. Number keys place notes, arrow keys move the cursor and change the snap, space plays.'),
    );
    const main = h('div', { class: 'main' }, this.canvas, this.hudView.el, this.welcome, this.layer);
    root.append(this.menubar.el, main, this.chordGraph.el, this.statusbar.el);
    this.renderer = new Renderer(this.canvas, ed);

    new ResizeObserver(() => this.renderer.resize(main.clientWidth, main.clientHeight)).observe(main);
    this.bindKeyboard();
    this.bindMouse();
    this.bindDrop(main);
    window.addEventListener('beforeunload', (e) => {
      if (ed.isDirty) e.preventDefault();
    });
    ed.onChange(() => this.onEditorChange());
    this.onEditorChange();
    requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------------------------------------
  // ActionHost / DialogHost.

  run(a: Action): void {
    if (a.enabled && !a.enabled()) return;
    a.run();
    this.editor.needsRender = true;
  }

  openDialog(id: DialogId): void {
    const existing = this.dialogs.get(id);
    if (existing) {
      this.layer.append(existing.el);
      return;
    }
    const d = createDialog(id, this);
    d.build();
    this.dialogs.set(id, d);
    this.layer.append(d.el);
  }

  closeDialog(d: Dialog): void {
    d.el.remove();
    if (this.dialogs.get(d.id) === d) this.dialogs.delete(d.id);
    this.canvas.focus();
  }

  editSegmentAtCursor(type: SegmentType): void {
    this.openSegmentDialog(type, this.editor.view.cursorRow / ROWS_PER_BEAT);
  }

  private openSegmentDialog(type: SegmentType, beat: number): void {
    const old = this.dialogs.get('segment');
    if (old) this.closeDialog(old);
    const d = new SegmentDialog(this, type, beat);
    d.build();
    this.dialogs.set('segment', d);
    this.layer.append(d.el);
  }

  setCustomSnap(): void {
    const v = prompt('Custom snap (4 to 192 notes per measure):', String(this.editor.view.snapQuant));
    if (!v) return;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return;
    this.editor.view.setCustomSnap(n);
    this.editor.hud(`Snap: ${this.editor.view.snapName}`);
    this.editor.saveSettings();
    this.editor.changed();
  }

  private confirmDiscard(): boolean {
    return !this.editor.isDirty || confirm('The simfile has unsaved changes. Discard them?');
  }

  async openSimfile(): Promise<void> {
    if (!window.showDirectoryPicker) return this.openFilesFallback();
    if (!this.confirmDiscard()) return;
    const source = await pickDirectory();
    if (source) await this.openSource(source);
  }

  async openFilesFallback(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const files = await pickFiles([...SIMFILE_EXTS, ...AUDIO_EXTS, 'audio/*'].join(','));
    if (files.length) await this.openSource(FileSource.fromFiles(files));
  }

  private async openSource(source: FileSource): Promise<void> {
    const ed = this.editor;
    try {
      const res = await resolveSource(source);
      if (!res) return ed.hud('No .sm, .ssc or music file found.', 'warning');
      if (res.simfileName && res.simfileText !== null) {
        const sim = loadSimfile(res.simfileText, res.simfileName);
        ed.setSimfile(sim, res.simfileName, source);
        ed.hud(`Opened "${res.simfileName}" (${sim.charts.length} chart${sim.charts.length === 1 ? '' : 's'}).`);
        await ed.loadMusicFromSource();
      } else if (res.musicName) {
        const file = await source.get(res.musicName);
        if (file) ed.newFromMusic(file, source);
      }
    } catch (e) {
      ed.hud(`Could not open: ${(e as Error).message}`, 'error');
    }
  }

  async loadMusic(): Promise<void> {
    const [file] = await pickFiles([...AUDIO_EXTS, 'audio/*'].join(','), false);
    if (!file) return;
    this.editor.source.files.set(file.name.toLowerCase(), file);
    if (this.editor.sim && this.editor.sim.meta.MUSIC !== file.name) this.editor.setMeta('MUSIC', file.name);
    await this.editor.loadMusic(file);
  }

  closeSimfile(): void {
    if (this.confirmDiscard()) this.editor.close();
  }

  private async openDemo(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const { sm, wav } = makeDemo();
    await this.openSource(FileSource.fromFiles([new File([sm], 'demo.sm'), new File([wav], 'demo.wav')]));
  }

  // ----------------------------------------------------------------------------------------------
  // Frame loop and change handling.

  private frame = () => {
    const ed = this.editor;
    ed.tick();
    ed.sections.follow();
    if (ed.needsRender) {
      ed.needsRender = false;
      this.renderer.draw();
      this.chordGraph.update();
      this.statusbar.update();
      this.updateSideViewsButton();
    }
    requestAnimationFrame(this.frame);
  };

  /** Side views toggle: pressed while on, and names the section being followed. */
  private updateSideViewsButton(): void {
    const sec = this.editor.sections;
    const on = sec.sideViewsOn;
    const g = on ? sec.shownGroup : null;
    const levels = sec.maxDepth + 1;
    const level = levels > 1 ? ` · level ${Math.min(this.editor.settings.sideDepth, sec.maxDepth) + 1}/${levels}` : '';
    const label = !on ? 'Side views' : g ? `Side views: ${sec.nameOf(g)}${sec.side.occ + 1}${level}` : `Side views: —${level}`;
    const title = on
      ? 'Showing the other occurrences of the section the cursor is in. { and } switch between whole sections and the parts inside them. Click to turn off (Shift+V).'
      : 'Show the other occurrences of the section the cursor is in, next to it (Shift+V).';
    const state = `${label}|${on}|${this.editor.isOpen}`;
    if (state === this.sideViewsState) return;
    this.sideViewsState = state;
    const b = this.sideViewsButton;
    b.textContent = label;
    b.title = title;
    b.disabled = !this.editor.isOpen;
    b.classList.toggle('pressed', on);
  }

  private onEditorChange(): void {
    const ed = this.editor;
    document.title = `${ed.isDirty ? '*' : ''}${ed.isOpen ? `${ed.fileName || 'untitled'} — ` : ''}${APP_NAME}`;
    this.welcome.style.display = ed.isOpen ? 'none' : '';
    for (const d of this.dialogs.values()) d.refresh();
  }

  // ----------------------------------------------------------------------------------------------
  // Keyboard.

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
      if (this.menubar.isOpen && e.key === 'Escape') {
        this.menubar.close();
        return;
      }
      const ed = this.editor;
      // Number keys place notes.
      const digit = /^(Digit|Numpad)(\d)$/.exec(e.code);
      if (digit && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (e.repeat || !ed.chart) return;
        const d = parseInt(digit[2], 10);
        let col = d === 0 ? 9 : d - 1;
        if (e.altKey) col += Math.floor(ed.numCols / 2);
        if (col >= ed.numCols) return;
        this.heldColumns.set(e.code, col);
        ed.placeKeyDown(col, e.shiftKey);
        return;
      }
      const action = this.shortcuts.get(eventToShortcut(e));
      if (!action) return;
      e.preventDefault();
      if (e.repeat && !action.repeat) return;
      this.run(action);
    });
    window.addEventListener('keyup', (e) => {
      const col = this.heldColumns.get(e.code);
      if (col === undefined) return;
      this.heldColumns.delete(e.code);
      this.editor.placeKeyUp(col);
    });
    window.addEventListener('blur', () => {
      for (const col of this.heldColumns.values()) this.editor.placeKeyUp(col);
      this.heldColumns.clear();
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Mouse.

  private pos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private overReceptors(x: number, y: number): boolean {
    const v = this.editor.view;
    const dy = v.applyZoom(this.editor.chart ? 32 : 8);
    return x >= v.receptorLeft && x < v.receptorRight && Math.abs(y - v.receptorScreenY) <= dy;
  }

  private bindMouse(): void {
    const c = this.canvas;
    const ed = this.editor;
    const r = this.renderer;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => {
      c.focus();
      const { x, y } = this.pos(e);
      if (!ed.isOpen) return;
      if (e.button === 2) {
        ed.clearSelection();
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
        ed.setCursorRow(ed.view.snapRow(ed.view.yToRow(y), 'closest'));
        return;
      }
      if (e.button !== 0) return;
      const close = r.closeButtons.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      if (close) {
        ed.sections.closeSideView(close.occurrence);
        return;
      }
      const hs = r.hScroll;
      if (hs && x >= hs.x && x < hs.x + hs.w && y >= hs.y - 4 && y < hs.y + hs.h + 4) {
        const onThumb = x >= hs.thumbX && x < hs.thumbX + hs.thumbW;
        const grab = onThumb ? x - hs.thumbX : hs.thumbW / 2;
        this.drag = { kind: 'hscroll', grab };
        this.dragScrollbar(x, grab);
        return;
      }
      // The minimap only moves the main pane: editing returns to it first.
      const lane = r.minimap.laneAt(x, y);
      if (lane) {
        const sec = ed.sections;
        sec.focusMain();
        sec.setActive(lane.group);
        ed.setCursorRow(lane.group.starts[lane.index]);
        ed.hud(`${sec.nameOf(lane.group)}${lane.index + 1}: ${sec.measureLabel(lane.group.starts[lane.index])}`);
        return;
      }
      if (r.minimap.contains(x, y)) {
        ed.sections.focusMain();
        this.drag = { kind: 'minimap' };
        ed.setCursorOffset(r.minimap.yToOffset(y));
        return;
      }
      // Clicking another pane edits it (the main notefield or a side view).
      const pane = r.paneRects.find((p) => x >= p.left && x < p.right);
      const target = pane ? (pane.main ? null : pane.occurrence) : undefined;
      if (target !== undefined && target !== ed.sections.side.focus) {
        ed.sections.focusPane(target);
        return;
      }
      const box = r.boxes.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      if (box) {
        const key = segKey(box.seg.type, box.seg.beat);
        if (e.shiftKey) {
          if (ed.selectedSegments.has(key)) ed.selectedSegments.delete(key);
          else ed.selectedSegments.add(key);
        } else {
          ed.selectedSegments = new Set([key]);
          ed.selection.clear();
          this.openSegmentDialog(box.seg.type, box.seg.beat);
        }
        ed.changed();
        return;
      }
      if (this.overReceptors(x, y)) {
        const v = ed.view;
        this.drag = { kind: 'receptors', dx: x - v.centerX, dy: y - v.receptorScreenY };
        return;
      }
      const mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : 'set';
      this.drag = { kind: 'select', x0: x, ofs0: ed.view.yToOffset(y), mode, x1: x, y1: y };
    });
    window.addEventListener('mousemove', (e) => {
      const { x, y } = this.pos(e);
      const v = ed.view;
      const inField = x >= v.fieldLeft && x <= v.fieldRight && y >= 0 && y < v.height;
      const hover = inField && ed.isOpen ? v.snapRow(Math.max(0, v.yToRow(y)), 'closest') : -1;
      if (hover !== v.hoverRow) {
        v.hoverRow = hover;
        if (ed.settings.beatLinesHover || ed.settings.status.hover) ed.needsRender = true;
      }
      const d = this.drag;
      if (!d) {
        c.style.cursor = ed.isOpen && this.overReceptors(x, y) ? 'move' : '';
        return;
      }
      if (d.kind === 'hscroll') {
        this.dragScrollbar(x, d.grab);
      } else if (d.kind === 'minimap') {
        ed.setCursorOffset(r.minimap.yToOffset(y));
      } else if (d.kind === 'receptors') {
        v.receptorX = Math.round(Math.min(v.width / 2, Math.max(-v.width / 2, x - d.dx - v.width / 2)));
        const sy = Math.min(v.height, Math.max(0, y - d.dy));
        v.receptorY = Math.round(v.reverse ? v.height - sy : sy);
      } else {
        d.x1 = x;
        d.y1 = y;
        r.dragBox = { x0: d.x0, y0: v.offsetToY(d.ofs0), x1: x, y1: y, mode: d.mode };
      }
      ed.needsRender = true;
    });
    window.addEventListener('mouseup', (e) => {
      const d = this.drag;
      if (!d || e.button !== 0) return;
      this.drag = null;
      r.dragBox = null;
      if (d.kind === 'receptors') ed.saveSettings();
      if (d.kind === 'select') this.finishBoxSelect(d, e);
      ed.needsRender = true;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!ed.isOpen) return;
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        // Horizontal wheel / trackpad, or Shift+wheel, scrolls the compare side views.
        if (ed.sections.sideViewsOn && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
          ed.sections.scrollBy((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit);
          return;
        }
        const px = e.deltaY * unit;
        const v = ed.view;
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl && v.snapType === 0) {
          // Free scrolling moves by pixels.
          const ofs = px / Math.abs(v.pixPerOfs);
          if (v.timeBased) ed.setCursorTime(v.cursorTime + ofs * Math.sign(v.pixPerOfs));
          else ed.setCursorRow(v.cursorRow + ofs * Math.sign(v.pixPerOfs));
          return;
        }
        // One step per wheel notch; small trackpad deltas accumulate.
        let steps: number;
        if (Math.abs(px) >= 50) {
          steps = Math.sign(px);
          this.wheelAcc = 0;
        } else {
          this.wheelAcc += px;
          steps = Math.trunc(this.wheelAcc / 50);
          this.wheelAcc -= steps * 50;
        }
        for (let i = 0; i < Math.abs(steps); ++i) {
          const up = steps < 0;
          if (ctrl && e.altKey) v.setScale(v.scaleLevel + (up ? 0.25 : -0.25));
          else if (ctrl) v.setZoom(v.zoomLevel + (up ? 0.25 : -0.25));
          else ed.moveCursorSnap(up ? 'up' : 'down');
        }
        if (ctrl && steps) ed.saveSettings();
        ed.needsRender = true;
      },
      { passive: false },
    );
  }

  /** Moves the side-view scrollbar thumb so that `grab` px into it sits under x. */
  private dragScrollbar(x: number, grab?: number): void {
    const hs = this.renderer.hScroll;
    const compare = this.editor.sections.side;
    if (!hs) return;
    const g = grab ?? hs.thumbW / 2;
    const f = Math.min(1, Math.max(0, (x - g - hs.x) / Math.max(1, hs.w - hs.thumbW)));
    compare.scroll = f * hs.maxScroll;
    this.editor.needsRender = true;
  }

  private finishBoxSelect(d: Extract<Drag, { kind: 'select' }>, e: MouseEvent): void {
    const ed = this.editor;
    const v = ed.view;
    const y0 = v.offsetToY(d.ofs0);
    const { x, y } = this.pos(e);
    const click = Math.abs(x - d.x0) < 4 && Math.abs(y - y0) < 4;
    let count: number;
    if (click) {
      const note = ed.noteAt(x, y);
      count = note ? ed.selectBox(d.mode, 0, 0, 0, 0, note) : 0;
      if (!note && d.mode === 'set') {
        ed.clearSelection();
        return;
      }
    } else {
      const xl = Math.min(x, d.x0);
      const xr = Math.max(x, d.x0);
      let c0 = 0;
      while (c0 < v.numCols && v.colX(c0) < xl) ++c0;
      let c1 = c0;
      while (c1 < v.numCols && v.colX(c1) <= xr) ++c1;
      const rowA = v.yToRow(Math.min(y, y0));
      const rowB = v.yToRow(Math.max(y, y0));
      count = c1 > c0 ? ed.selectBox(d.mode, rowA, rowB, c0, c1 - 1, null) : 0;
      if (c1 <= c0 && d.mode === 'set') ed.selection.clear();
      // Tempo boxes inside the rectangle.
      const top = Math.min(y, y0);
      const bottom = Math.max(y, y0);
      const hits = this.renderer.boxes.filter((b) => b.x < xr && b.x + b.w > xl && b.y < bottom && b.y + b.h > top);
      if (d.mode === 'set') ed.selectedSegments.clear();
      for (const b of hits) {
        const key = segKey(b.seg.type, b.seg.beat);
        if (d.mode === 'sub') ed.selectedSegments.delete(key);
        else ed.selectedSegments.add(key);
      }
      if (hits.length) ed.hud(`Selected ${hits.length} tempo change(s).`);
    }
    if (count) ed.hud(`${d.mode === 'sub' ? 'Deselected' : 'Selected'} ${count} note${count === 1 ? '' : 's'}.`);
    ed.changed();
  }

  private bindDrop(target: HTMLElement): void {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      target.classList.add('drop-hover');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-hover'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('drop-hover');
      if (!e.dataTransfer || !this.confirmDiscard()) return;
      void sourceFromDrop(e.dataTransfer).then((s) => this.openSource(s));
    });
  }
}
