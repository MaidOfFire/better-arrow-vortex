// Editor state and every editing operation. UI code calls into this; it never touches the DOM.

import {
  applyNoteEdit,
  findNote,
  findNoteCovering,
  isLong,
  keyOf,
  lowerBoundRow,
  maxHoldLength,
  rowQuant,
} from '../model/notes';
import { findStyle, type GameStyle } from '../model/styles';
import { normalizeTiming, saveSimfile, writeNoteData } from '../model/simfileIO';
import { TempoMap } from '../model/timing';
import {
  ROWS_PER_BEAT,
  ROWS_PER_MEASURE,
  cloneTiming,
  emptyTiming,
  newChart,
  newSimfile,
  type Chart,
  type Difficulty,
  type MetaTag,
  type Note,
  type NoteType,
  type Simfile,
  type TimingData,
} from '../model/types';
import { analyzeOnsets } from '../analysis/detect';
import type { OnsetData } from '../analysis/onsets';
import { AudioPlayer } from './audio';
import { FileSource, baseName, downloadText, ensureWritable, ext, pickSaveHandle, writeHandle } from './files';
import { History, type HistoryEntry } from './history';
import { SectionManager } from './sections';
import { loadSettings, saveSettings, type Settings } from './settings';
import { View } from './view';
import { WaveformData } from './waveform';

export type HudKind = 'note' | 'info' | 'warning' | 'error';

export type SegmentType = 'bpm' | 'stop' | 'delay' | 'warp' | 'timesig' | 'label';

export interface Segment {
  type: SegmentType;
  beat: number;
  text: string;
}

export const SEGMENT_META: Record<SegmentType, { name: string; color: string; side: 'left' | 'right' }> = {
  bpm: { name: 'BPM', color: 'rgb(128,26,26)', side: 'right' },
  stop: { name: 'Stop', color: 'rgb(128,128,51)', side: 'left' },
  delay: { name: 'Delay', color: 'rgb(26,128,128)', side: 'left' },
  warp: { name: 'Warp', color: 'rgb(128,26,51)', side: 'right' },
  timesig: { name: 'Time sig.', color: 'rgb(128,102,26)', side: 'left' },
  label: { name: 'Label', color: 'rgb(102,51,51)', side: 'right' },
};

export const segKey = (type: SegmentType, beat: number) => `${type}@${beat}`;

interface PlacingNote {
  startRow: number;
  mode: 'new' | 'afterRemove';
}

export type MirrorMode = 'horizontal' | 'vertical' | 'both';

export class Editor {
  sim: Simfile | null = null;
  fileName = '';
  source = new FileSource();
  chartIndex = -1;
  musicName = '';

  readonly settings: Settings = loadSettings();
  readonly history = new History();
  readonly audio = new AudioPlayer();
  tempo: TempoMap = new TempoMap(emptyTiming());
  readonly view: View;
  waveform: WaveformData | null = null;
  /** Per-band onset strength of the music, computed in the background after loading. */
  onsets: OnsetData | null = null;
  readonly sections = new SectionManager(this);

  /** Keys (see noteKey) of the selected notes. */
  selection = new Set<number>();
  region: { begin: number; end: number } | null = null;
  /** Start row while a region is being selected with Tab. */
  regionStart: number | null = null;
  selectedSegments = new Set<string>();
  clipboard: { notes: Note[]; length: number } | null = null;
  readonly placing = new Map<number, PlacingNote>();
  /** Longest hold in the current chart, in rows (for range queries). */
  maxHold = 0;
  private endRowCache = -1;

  /** Editor data in the file (section groups) changed since the last save. */
  metaDirty = false;

  /** Called for HUD messages; set by the UI. */
  hud: (text: string, kind?: HudKind) => void = () => {};
  /** Set whenever something visible changed; the render loop clears it. */
  needsRender = true;
  private listeners = new Set<() => void>();

  constructor() {
    this.view = new View(this.tempo, () => this.endRow());
    const s = this.settings;
    Object.assign(this.view, {
      zoomLevel: s.zoomLevel,
      scaleLevel: s.scaleLevel,
      timeBased: s.timeBased,
      reverse: s.reverse,
      receptorX: s.receptorX,
      receptorY: s.receptorY,
    });
    this.view.setCustomSnap(s.customSnap);
    this.view.setSnapType(s.snapType);
    this.audio.setVolume(s.volume);
    this.audio.speed = s.speed;
  }

  // ----------------------------------------------------------------------------------------------
  // Change notification.

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.needsRender = true;
    for (const fn of this.listeners) fn();
  }

  saveSettings(): void {
    const v = this.view;
    Object.assign(this.settings, {
      zoomLevel: v.zoomLevel,
      scaleLevel: v.scaleLevel,
      timeBased: v.timeBased,
      reverse: v.reverse,
      receptorX: v.receptorX,
      receptorY: v.receptorY,
      snapType: v.snapType,
      customSnap: v.customSnap,
      volume: this.audio.volume,
      speed: this.audio.speed,
    });
    saveSettings(this.settings);
  }

  // ----------------------------------------------------------------------------------------------
  // Accessors.

  get chart(): Chart | null {
    return this.sim?.charts[this.chartIndex] ?? null;
  }

  get style(): GameStyle {
    return findStyle(this.chart?.stepsType ?? 'dance-single');
  }

  get numCols(): number {
    return this.style.columns.length;
  }

  get notes(): readonly Note[] {
    return this.chart?.notes ?? [];
  }

  /** The timing in effect: the chart's own (split timing) or the song's. */
  get timing(): TimingData {
    return this.chart?.timing ?? this.sim?.timing ?? this.tempo.data;
  }

  get isOpen(): boolean {
    return this.sim !== null;
  }

  get isDirty(): boolean {
    return this.history.isDirty || this.metaDirty;
  }

  /** Last row the cursor can reach: the end of the music or the last note, whichever is later. */
  endRow(): number {
    if (this.endRowCache < 0) {
      let row = ROWS_PER_MEASURE * 4;
      for (const c of this.sim?.charts ?? []) for (const n of c.notes) row = Math.max(row, n.endRow);
      if (this.audio.duration > 0) row = Math.max(row, Math.ceil(this.tempo.timeToRow(this.audio.duration)));
      this.endRowCache = row;
    }
    return this.endRowCache;
  }

  chartName(c: Chart | null = this.chart): string {
    if (!c) return 'No chart';
    const style = findStyle(c.stepsType);
    return `${style.name} ${c.difficulty} ${c.meter}${c.description ? ` (${c.description})` : ''}`;
  }

  // ----------------------------------------------------------------------------------------------
  // Simfile lifecycle.

  setSimfile(sim: Simfile | null, fileName: string, source: FileSource): void {
    this.audio.unload();
    this.waveform = null;
    this.onsets = null;
    this.musicName = '';
    this.sim = sim;
    this.fileName = fileName;
    this.source = source;
    this.history.clear();
    this.metaDirty = false;
    this.selection.clear();
    this.selectedSegments.clear();
    this.region = null;
    this.regionStart = null;
    this.placing.clear();
    this.chartIndex = sim && sim.charts.length ? this.preferredChart(sim) : -1;
    this.sections.reset();
    this.timingChanged();
    this.notesChanged();
    this.view.setCursorRow(0);
    this.changed();
  }

  /** Opens the hardest dance-single chart by default, like most editors do. */
  private preferredChart(sim: Simfile): number {
    let best = 0;
    sim.charts.forEach((c, i) => {
      const b = sim.charts[best];
      const score = (x: Chart) => (x.stepsType === 'dance-single' ? 1000 : 0) + x.meter;
      if (score(c) > score(b)) best = i;
    });
    return best;
  }

  newFromMusic(file: File, source: FileSource): void {
    const sim = newSimfile();
    const name = file.name.replace(/\.[^.]+$/, '');
    sim.meta.TITLE = name;
    sim.meta.MUSIC = file.name;
    this.setSimfile(sim, `${name}.sm`, source);
    void this.loadMusic(file);
    this.hud(`Created a new simfile for "${file.name}". Add a chart with Chart > New chart (Shift+N).`, 'info');
  }

  async loadMusicFromSource(): Promise<void> {
    if (!this.sim) return;
    let name = this.sim.meta.MUSIC;
    let file = await this.source.get(name);
    if (!file) {
      // Fall back to any audio file next to the simfile.
      const names = await this.source.listNames();
      const audio = names.find((n) => ['.ogg', '.mp3', '.wav', '.flac', '.opus', '.m4a'].includes(ext(n)));
      if (audio) {
        file = await this.source.get(audio);
        if (file) this.hud(`Music "${name}" not found, using "${audio}" instead.`, 'warning');
        name = audio;
      }
    }
    if (!file) {
      this.hud(name ? `Could not find the music file "${name}". Open it with Audio > Load music.` : 'The simfile has no music file.', 'warning');
      return;
    }
    await this.loadMusic(file);
  }

  async loadMusic(file: File): Promise<void> {
    try {
      this.hud(`Loading "${file.name}"...`);
      await this.audio.load(await file.arrayBuffer());
      this.musicName = file.name;
      this.endRowCache = -1;
      this.rebuildWaveform();
      this.hud(`Loaded "${file.name}" (${formatTime(this.audio.duration)}).`);
      void this.analyzeMusic();
    } catch (e) {
      this.hud(`Could not decode "${file.name}": ${(e as Error).message}`, 'error');
    }
    this.changed();
  }

  private async analyzeMusic(): Promise<void> {
    const buffer = this.audio.buffer;
    if (!buffer) return;
    this.onsets = null;
    try {
      const data = await analyzeOnsets(buffer);
      if (this.audio.buffer === buffer) {
        this.onsets = data;
        this.needsRender = true;
        void this.sections.analyze(false);
      }
    } catch (e) {
      this.hud(`Onset analysis failed: ${(e as Error).message}`, 'warning');
    }
  }

  rebuildWaveform(): void {
    const buf = this.audio.buffer;
    this.waveform = buf ? new WaveformData(buf, this.settings.waveFilter, this.settings.waveFilterCutoff) : null;
    this.needsRender = true;
  }

  close(): void {
    this.setSimfile(null, '', new FileSource());
  }

  async save(saveAs = false): Promise<boolean> {
    if (!this.sim) return false;
    let name = this.fileName || `${this.sim.meta.TITLE || 'untitled'}.sm`;
    let handle: FileSystemFileHandle | null = saveAs ? null : this.source.file;
    if (!handle && !saveAs && this.source.dir) {
      try {
        handle = await this.source.dir.getFileHandle(name, { create: true });
        this.source.file = handle;
      } catch {
        handle = null;
      }
    }
    if (saveAs) {
      handle = await pickSaveHandle(name);
      if (handle) {
        name = handle.name;
        this.source.file = handle;
      } else if (window.showSaveFilePicker) {
        return false; // picker cancelled
      } else {
        const entered = prompt('Save as (.sm or .ssc):', name);
        if (!entered) return false;
        name = entered;
      }
    }
    if (!['.sm', '.ssc'].includes(ext(name))) name += '.sm';
    this.sections.storeInto(this.sim, this.settings.sectionsInFile);
    const { text, warnings } = saveSimfile(this.sim, name);
    for (const w of warnings) this.hud(w, 'warning');
    try {
      if (handle) {
        if (!(await ensureWritable(handle))) throw new Error('write permission denied');
        await writeHandle(handle, text);
        this.hud(`Saved "${name}".`);
      } else {
        downloadText(baseName(name), text);
        this.hud(`Downloaded "${name}". (Use Chrome or Edge and open a folder to save in place.)`, 'info');
      }
    } catch (e) {
      this.hud(`Saving failed: ${(e as Error).message}`, 'error');
      return false;
    }
    this.fileName = name;
    this.history.markSaved();
    this.metaDirty = false;
    this.changed();
    return true;
  }

  // ----------------------------------------------------------------------------------------------
  // Derived data refresh.

  private timingChanged(): void {
    this.tempo = new TempoMap(this.timing);
    this.view.tempo = this.tempo;
    this.endRowCache = -1;
    this.view.refreshCursor();
    this.needsRender = true;
  }

  private notesChanged(): void {
    this.maxHold = maxHoldLength(this.notes);
    this.endRowCache = -1;
    this.view.numCols = this.numCols;
    // Drop selection keys that no longer exist.
    if (this.selection.size) {
      const keys = new Set(this.notes.map(keyOf));
      for (const k of this.selection) if (!keys.has(k)) this.selection.delete(k);
    }
    this.needsRender = true;
  }

  // ----------------------------------------------------------------------------------------------
  // Charts.

  openChart(index: number): void {
    if (!this.sim || index < 0 || index >= this.sim.charts.length) return;
    const hadOwnTiming = this.chart?.timing;
    this.chartIndex = index;
    this.selection.clear();
    this.placing.clear();
    this.notesChanged();
    if (hadOwnTiming || this.chart?.timing) this.timingChanged();
    this.hud(`Opened chart: ${this.chartName()}`);
    this.changed();
  }

  nextChart(delta: number): void {
    if (!this.sim || !this.sim.charts.length) return;
    const n = this.sim.charts.length;
    this.openChart((this.chartIndex + delta + n) % n);
  }

  addChart(stepsType: string, difficulty: Difficulty, meter: number, description: string): void {
    if (!this.sim) return;
    const sim = this.sim;
    const chart = newChart(stepsType, difficulty, meter);
    chart.description = description;
    const prevIndex = this.chartIndex;
    this.history.push({
      description: 'New chart',
      apply: () => {
        sim.charts.push(chart);
        this.openChart(sim.charts.length - 1);
      },
      revert: () => {
        sim.charts.splice(sim.charts.indexOf(chart), 1);
        this.chartIndex = Math.min(prevIndex, sim.charts.length - 1);
        this.notesChanged();
        this.changed();
      },
    });
  }

  deleteChart(): void {
    const sim = this.sim;
    const chart = this.chart;
    if (!sim || !chart) return;
    const index = this.chartIndex;
    this.history.push({
      description: 'Delete chart',
      apply: () => {
        sim.charts.splice(index, 1);
        this.chartIndex = Math.min(index, sim.charts.length - 1);
        this.notesChanged();
        this.changed();
      },
      revert: () => {
        sim.charts.splice(index, 0, chart);
        this.openChart(index);
      },
    });
    this.hud('Deleted chart.');
  }

  editChart(patch: Partial<Pick<Chart, 'stepsType' | 'description' | 'difficulty' | 'meter' | 'credit' | 'chartName'>>): void {
    const chart = this.chart;
    if (!chart) return;
    const before = { ...chart };
    const after = { ...chart, ...patch };
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.every((f) => before[f] === after[f])) return;
    const assign = (src: Chart) => {
      for (const f of fields) (chart as unknown as Record<string, unknown>)[f] = src[f];
      this.notesChanged();
      this.changed();
    };
    this.history.push({ description: 'Chart properties', apply: () => assign(after), revert: () => assign(before) });
  }

  setMeta(tag: MetaTag, value: string): void {
    const sim = this.sim;
    if (!sim || sim.meta[tag] === value) return;
    const before = sim.meta[tag];
    this.history.push({
      description: `Set ${tag}`,
      apply: () => {
        sim.meta[tag] = value;
        this.changed();
      },
      revert: () => {
        sim.meta[tag] = before;
        this.changed();
      },
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Undo / redo.

  undo(): void {
    this.placing.clear();
    const e = this.history.undo();
    if (!e) return this.hud('Nothing to undo.');
    this.afterHistoryJump(e);
    this.hud(`Undo: ${e.description}`);
  }

  redo(): void {
    this.placing.clear();
    const e = this.history.redo();
    if (!e) return this.hud('Nothing to redo.');
    this.afterHistoryJump(e);
    this.hud(`Redo: ${e.description}`);
  }

  private afterHistoryJump(e: HistoryEntry): void {
    if (this.settings.undoRedoJump && e.row !== undefined && !this.audio.playing) this.setCursorRow(e.row);
    this.changed();
  }

  // ----------------------------------------------------------------------------------------------
  // Note editing.

  /** Removes and adds notes on the current chart as one undoable step. */
  editNotes(remove: readonly Note[], add: readonly Note[], description: string, select = false): void {
    const chart = this.chart;
    if (!chart || (!remove.length && !add.length)) return;
    const before = chart.notes;
    const after = applyNoteEdit(before, remove, add);
    const row = add[0]?.row ?? remove[0]?.row;
    this.history.push({
      description,
      row,
      apply: () => this.setChartNotes(chart, after),
      revert: () => this.setChartNotes(chart, before),
    });
    if (select) this.selection = new Set(add.map(keyOf));
    this.changed();
  }

  private setChartNotes(chart: Chart, notes: Note[]): void {
    if (this.chart !== chart && this.sim) {
      const i = this.sim.charts.indexOf(chart);
      if (i >= 0) this.chartIndex = i;
    }
    chart.notes = notes;
    this.notesChanged();
    this.changed();
  }

  /** Number key pressed: start placing (or remove) a note in the column. */
  placeKeyDown(col: number, mine: boolean): void {
    if (!this.chart || col < 0 || col >= this.numCols) return;
    const playing = this.audio.playing;
    const row = this.view.snapRow(this.view.cursorRow, 'closest');
    if (!playing) this.setCursorRow(row);
    const existing = findNote(this.notes, row, col);
    if (existing) {
      if (!playing) this.placing.set(col, { startRow: row, mode: 'afterRemove' });
      this.editNotes([existing], [], 'Remove note');
      return;
    }
    const tap: Note = { row, col, type: mine ? 'mine' : 'tap', endRow: row };
    if (mine || playing) this.editNotes([], [tap], mine ? 'Add mine' : 'Add note');
    else this.placing.set(col, { startRow: row, mode: 'new' });
    this.needsRender = true;
  }

  /** Number key released: finish placing a note or hold. */
  placeKeyUp(col: number): void {
    const p = this.placing.get(col);
    if (!p) return;
    this.placing.delete(col);
    const endRow = this.view.snapRow(this.view.cursorRow, 'closest');
    if (p.mode === 'new' || p.startRow !== endRow) {
      let row = Math.min(p.startRow, endRow);
      const end = Math.max(p.startRow, endRow);
      // A hold dragged upwards into another hold merges with it.
      if (endRow < p.startRow) {
        const hold = findNoteCovering(this.notes, row, col, this.maxHold);
        if (hold && isLong(hold) && row > hold.row && end > hold.endRow) row = hold.row;
      }
      this.editNotes([], [{ row, col, type: end > row ? 'hold' : 'tap', endRow: end }], end > row ? 'Add hold' : 'Add note');
    }
    if (this.settings.jumpToNextNote && !this.audio.playing && this.placing.size === 0 && this.view.snapType !== 0) {
      this.setCursorRow(this.view.snapRow(this.view.cursorRow, this.view.reverse ? 'up' : 'down'));
    }
    this.needsRender = true;
  }

  /** Notes the operations act on: the selection, or everything inside the region. */
  selectedNotes(): Note[] {
    if (this.selection.size) return this.notes.filter((n) => this.selection.has(keyOf(n)));
    return [];
  }

  deleteSelection(): void {
    const notes = this.selectedNotes();
    const segs = this.selectedSegmentList();
    if (!notes.length && !segs.length) return this.hud('Nothing selected.');
    this.history.startChain();
    if (notes.length) this.editNotes(notes, [], 'Delete notes');
    if (segs.length) this.removeSegments(segs);
    this.history.finishChain('Delete selection');
    this.selection.clear();
    this.selectedSegments.clear();
    this.hud(`Deleted ${notes.length} note(s)${segs.length ? ` and ${segs.length} tempo change(s)` : ''}.`);
    this.changed();
  }

  copy(cut: boolean): void {
    const notes = this.selectedNotes();
    if (!notes.length) return this.hud('There are no notes selected.');
    const base = this.region ? Math.min(this.region.begin, notes[0].row) : notes[0].row;
    const shifted = notes.map((n) => ({ ...n, row: n.row - base, endRow: n.endRow - base }));
    const length = this.region ? this.region.end - this.region.begin : Math.max(...shifted.map((n) => n.endRow)) + 1;
    this.clipboard = { notes: shifted, length };
    void navigator.clipboard?.writeText(writeNoteData(shifted, this.numCols)).catch(() => {});
    if (cut) {
      this.editNotes(notes, [], 'Cut notes');
      this.selection.clear();
    }
    this.hud(`${cut ? 'Cut' : 'Copied'} ${notes.length} note(s).`);
    this.changed();
  }

  paste(insert: boolean): void {
    if (!this.clipboard || !this.chart) return this.hud('The clipboard is empty.');
    const at = this.view.snapRow(this.view.cursorRow, 'closest');
    const add = this.clipboard.notes
      .filter((n) => n.col < this.numCols)
      .map((n) => ({ ...n, row: n.row + at, endRow: n.endRow + at }));
    if (insert) {
      this.history.startChain();
      this.shiftRows(at, this.clipboard.length, false);
      this.editNotes([], add, 'Paste notes', true);
      this.history.finishChain('Insert paste');
    } else {
      this.editNotes([], add, 'Paste notes', true);
    }
    this.hud(`Pasted ${add.length} note(s).`);
  }

  /** Inserts (rows > 0) or deletes (rows < 0) empty rows at `at` in the current chart (and timing). */
  shiftRows(at: number, rows: number, withTiming: boolean, allCharts = false): void {
    if (!this.sim || rows === 0) return;
    const charts = allCharts ? this.sim.charts : this.chart ? [this.chart] : [];
    for (const chart of charts) {
      const before = chart.notes;
      const after: Note[] = [];
      for (const n of before) {
        if (rows < 0 && n.row >= at && n.row < at - rows) continue; // deleted region
        if (n.row >= at) after.push({ ...n, row: n.row + rows, endRow: n.endRow + rows });
        else if (n.endRow >= at) after.push({ ...n, endRow: Math.max(n.row, n.endRow + rows) });
        else after.push(n);
      }
      this.history.push({
        description: 'Shift notes',
        row: at,
        apply: () => this.setChartNotes(chart, after),
        revert: () => this.setChartNotes(chart, before),
      });
    }
    if (withTiming) {
      const atBeat = at / ROWS_PER_BEAT;
      const delta = rows / ROWS_PER_BEAT;
      this.editTiming((t) => {
        const shift = <T extends { beat: number }>(list: T[]) =>
          list
            .filter((s) => delta > 0 || s.beat < atBeat || s.beat >= atBeat - delta || s.beat === 0)
            .map((s) => (s.beat >= atBeat && s.beat !== 0 ? { ...s, beat: s.beat + delta } : s));
        t.bpms = shift(t.bpms);
        t.stops = shift(t.stops);
        t.delays = shift(t.delays);
        t.warps = shift(t.warps);
        t.timeSigs = shift(t.timeSigs);
        t.labels = shift(t.labels);
      }, 'Shift tempo changes');
    }
  }

  insertBeats(beats: number, allCharts: boolean): void {
    const rows = Math.round(beats * ROWS_PER_BEAT);
    if (!rows) return;
    this.history.startChain();
    this.shiftRows(this.view.cursorRow, rows, true, allCharts);
    this.history.finishChain(rows > 0 ? 'Insert beats' : 'Delete beats');
    this.hud(`${rows > 0 ? 'Inserted' : 'Deleted'} ${Math.abs(beats)} beat(s) at the cursor.`);
    this.changed();
  }

  /** Replaces the selected notes with modified copies, keeping them selected. */
  private transformSelection(fn: (n: Note) => Note | null, description: string, emptyMessage = 'There are no notes selected.'): number {
    const notes = this.selectedNotes();
    if (!notes.length) {
      this.hud(emptyMessage);
      return 0;
    }
    const add: Note[] = [];
    const remove: Note[] = [];
    for (const n of notes) {
      const m = fn(n);
      if (!m) continue;
      remove.push(n);
      add.push(m);
    }
    if (!add.length) {
      this.hud(emptyMessage);
      return 0;
    }
    this.editNotes(remove, add, description, true);
    // Re-select untouched notes too.
    for (const n of notes) if (!remove.includes(n)) this.selection.add(keyOf(n));
    return add.length;
  }

  convertNotes(from: NoteType | 'holdroll', to: NoteType): void {
    const n = this.transformSelection(
      (x) => {
        if (from === 'holdroll' ? !isLong(x) : x.type !== from || (from === 'hold' && !isLong(x))) return null;
        const long = to === 'hold' || to === 'roll';
        return { ...x, type: to, endRow: long ? x.endRow : x.row };
      },
      `Convert ${from} to ${to}`,
      `There are no ${from === 'holdroll' ? 'holds/rolls' : `${from}s`} selected.`,
    );
    if (n) this.hud(`Converted ${n} note(s) to ${to}s.`);
  }

  toggleHoldsRolls(): void {
    const n = this.transformSelection(
      (x) => (isLong(x) ? { ...x, type: x.type === 'roll' ? 'hold' : 'roll' } : null),
      'Convert holds/rolls',
      'There are no holds/rolls selected.',
    );
    if (n) this.hud(`Converted ${n} hold(s)/roll(s).`);
  }

  mirrorMap(mode: MirrorMode): number[] {
    const cols = this.style.columns;
    const n = cols.length;
    const angleOf = (c: number) => {
      const s = cols[c];
      return s.kind === 'arrow' ? s.angle : s.kind === 'center' ? 'c' : 'b';
    };
    const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
    return cols.map((_, c) => {
      const a = angleOf(c);
      const flipH = mode !== 'vertical';
      const flipV = mode !== 'horizontal';
      if (a === 'b') return flipH ? n - 1 - c : c;
      let want: number | 'c' = a;
      if (typeof a === 'number') {
        let x = a;
        if (flipH) x = -x;
        if (flipV) x = 180 - x;
        want = norm(x);
      }
      const targetPos = flipH ? n - 1 - c : c;
      let best = c;
      let bestDist = Infinity;
      for (let d = 0; d < n; ++d) {
        const ad = angleOf(d);
        if (typeof ad === 'number' && typeof want === 'number' ? norm(ad) !== want : ad !== want) continue;
        const dist = Math.abs(d - targetPos);
        if (dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      return best;
    });
  }

  mirror(mode: MirrorMode): void {
    const map = this.mirrorMap(mode);
    const n = this.transformSelection((x) => ({ ...x, col: map[x.col] }), `Mirror ${mode}`);
    if (n) this.hud(`Mirrored ${n} note(s).`);
  }

  /** Scales the distance between selected notes by num/den, anchored at the first one. */
  scaleNotes(num: number, den: number): void {
    const notes = this.selectedNotes();
    if (!notes.length) return this.hud('There are no notes selected.');
    const base = this.region ? this.region.begin : notes[0].row;
    const scale = (r: number) => base + Math.round(((r - base) * num) / den);
    this.transformSelection((x) => ({ ...x, row: scale(x.row), endRow: Math.max(scale(x.row), scale(x.endRow)) }), `Scale notes ${num}:${den}`);
  }

  requantize(): void {
    if (this.view.snapType === 0) return this.hud('Choose a snap first (left/right arrow keys).');
    const snap = (r: number) => this.view.snapRow(r, 'closest');
    const n = this.transformSelection((x) => ({ ...x, row: snap(x.row), endRow: Math.max(snap(x.row), snap(x.endRow)) }), 'Requantize notes');
    if (n) this.hud(`Requantized ${n} note(s) to ${this.view.snapName}.`);
  }

  // ----------------------------------------------------------------------------------------------
  // Selection.

  private inRegion(row: number): boolean {
    return !this.region || (row >= this.region.begin && row <= this.region.end);
  }

  private reportSelection(count: number, what = 'note'): void {
    this.hud(count ? `Selected ${count} ${what}${count === 1 ? '' : 's'}.` : `There are no ${what}s to select.`);
    this.changed();
  }

  selectAll(): void {
    this.selection = new Set(this.notes.filter((n) => this.inRegion(n.row)).map(keyOf));
    this.reportSelection(this.selection.size);
  }

  selectAllSegments(): void {
    this.selectedSegments = new Set(this.segments().map((s) => segKey(s.type, s.beat)));
    this.hud(`Selected ${this.selectedSegments.size} tempo change(s).`);
    this.changed();
  }

  clearSelection(): void {
    this.selection.clear();
    this.selectedSegments.clear();
    this.region = null;
    this.regionStart = null;
    this.changed();
  }

  selectWhere(pred: (n: Note) => boolean, what: string): void {
    this.selection = new Set(this.notes.filter((n) => this.inRegion(n.row) && pred(n)).map(keyOf));
    this.reportSelection(this.selection.size, what);
  }

  selectQuant(q: number): void {
    this.selectWhere((n) => rowQuant(n.row) === q, 'note');
  }

  /** Tab: first press marks the start row, second press selects up to the cursor. */
  toggleRegionSelect(): void {
    const row = this.view.cursorRow;
    if (this.regionStart === null) {
      this.regionStart = row;
      this.region = null;
      this.hud('Region start set. Move the cursor and press Tab again.');
    } else {
      this.setRegion(this.regionStart, row);
      this.regionStart = null;
    }
    this.changed();
  }

  setRegion(a: number, b: number): void {
    const begin = Math.min(a, b);
    const end = Math.max(a, b);
    if (begin === end) {
      this.region = null;
      return;
    }
    this.region = { begin, end };
    this.selection = new Set(this.notes.filter((n) => n.row >= begin && n.row <= end).map(keyOf));
    const m1 = this.tempo.beatToMeasure(begin / ROWS_PER_BEAT);
    const m2 = this.tempo.beatToMeasure(end / ROWS_PER_BEAT);
    this.hud(`Selected measure ${m1.toFixed(2)} to ${m2.toFixed(2)} (${(m2 - m1).toFixed(2)} measures).`);
    this.changed();
  }

  selectBeforeCursor(): void {
    this.setRegion(0, this.view.cursorRow);
  }

  selectAfterCursor(): void {
    this.setRegion(this.view.cursorRow, this.endRow());
  }

  /** Box selection from the mouse. Rows/cols are inclusive ranges. */
  selectBox(mode: 'set' | 'add' | 'sub', rowA: number, rowB: number, colA: number, colB: number, single: Note | null): number {
    const r0 = Math.min(rowA, rowB);
    const r1 = Math.max(rowA, rowB);
    const c0 = Math.min(colA, colB);
    const c1 = Math.max(colA, colB);
    const hits = single
      ? [single]
      : this.notes.filter((n) => n.col >= c0 && n.col <= c1 && n.row <= r1 && n.endRow >= r0 && n.row >= r0 - this.maxHold);
    if (mode === 'set') this.selection = new Set();
    for (const n of hits) {
      if (mode === 'sub') this.selection.delete(keyOf(n));
      else this.selection.add(keyOf(n));
    }
    if (mode === 'set') this.region = null;
    this.changed();
    return hits.length;
  }

  /** The note closest to a screen point, within the note size. */
  noteAt(x: number, y: number): Note | null {
    const v = this.view;
    const maxDist = v.applyZoom(32);
    const ra = v.yToRow(y - maxDist * 2);
    const rb = v.yToRow(y + maxDist * 2);
    const r0 = Math.min(ra, rb) - this.maxHold;
    const r1 = Math.max(ra, rb);
    let best: Note | null = null;
    let bestDist = maxDist * maxDist;
    for (let i = lowerBoundRow(this.notes, r0); i < this.notes.length && this.notes[i].row <= r1; ++i) {
      const n = this.notes[i];
      const dx = x - v.colX(n.col);
      const ny = v.rowToY(n.row);
      const ey = v.rowToY(n.endRow);
      const dy = y < Math.min(ny, ey) ? Math.min(ny, ey) - y : y > Math.max(ny, ey) ? y - Math.max(ny, ey) : 0;
      const d = dx * dx + dy * dy;
      if (Math.abs(dx) <= maxDist && d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  // ----------------------------------------------------------------------------------------------
  // Timing.

  segments(): Segment[] {
    const t = this.timing;
    const out: Segment[] = [];
    for (const b of t.bpms) out.push({ type: 'bpm', beat: b.beat, text: fmtNum(b.bpm, 3) });
    for (const s of t.stops) out.push({ type: 'stop', beat: s.beat, text: fmtNum(s.seconds, 3) });
    for (const s of t.delays) out.push({ type: 'delay', beat: s.beat, text: fmtNum(s.seconds, 3) });
    for (const w of t.warps) out.push({ type: 'warp', beat: w.beat, text: fmtNum(w.length, 3) });
    for (const s of t.timeSigs) out.push({ type: 'timesig', beat: s.beat, text: `${s.num}/${s.den}` });
    for (const l of t.labels) out.push({ type: 'label', beat: l.beat, text: l.text });
    return out.sort((a, b) => a.beat - b.beat);
  }

  selectedSegmentList(): Segment[] {
    return this.segments().filter((s) => this.selectedSegments.has(segKey(s.type, s.beat)));
  }

  /** Applies a change to the active timing data as one undoable step. */
  editTiming(mutate: (t: TimingData) => void, description: string): void {
    const target = this.timing;
    const before = cloneTiming(target);
    const after = cloneTiming(target);
    mutate(after);
    normalizeTiming(after);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const assign = (src: TimingData) => {
      Object.assign(target, cloneTiming(src));
      this.timingChanged();
      this.changed();
    };
    this.history.push({ description, row: this.view.cursorRow, apply: () => assign(after), revert: () => assign(before) });
  }

  segmentValue(type: SegmentType, beat: number): string | null {
    const t = this.timing;
    const at = <T extends { beat: number }>(list: T[]) => list.find((s) => Math.abs(s.beat - beat) < 1e-6);
    switch (type) {
      case 'bpm':
        return at(t.bpms) ? String(at(t.bpms)!.bpm) : null;
      case 'stop':
        return at(t.stops) ? String(at(t.stops)!.seconds) : null;
      case 'delay':
        return at(t.delays) ? String(at(t.delays)!.seconds) : null;
      case 'warp':
        return at(t.warps) ? String(at(t.warps)!.length) : null;
      case 'timesig': {
        const s = at(t.timeSigs);
        return s ? `${s.num}/${s.den}` : null;
      }
      case 'label':
        return at(t.labels)?.text ?? null;
    }
  }

  /** Sets (value) or removes (null) a tempo change at a beat. */
  setSegment(type: SegmentType, beat: number, value: string | null): void {
    const same = (s: { beat: number }) => Math.abs(s.beat - beat) < 1e-6;
    const num = value === null ? NaN : parseFloat(value);
    if (value !== null && type !== 'label' && type !== 'timesig' && !Number.isFinite(num)) {
      return this.hud(`"${value}" is not a number.`, 'warning');
    }
    this.editTiming((t) => {
      switch (type) {
        case 'bpm':
          t.bpms = t.bpms.filter((s) => !same(s));
          if (value !== null && num > 0) t.bpms.push({ beat, bpm: num });
          if (!t.bpms.length) t.bpms.push({ beat: 0, bpm: num > 0 ? num : 120 });
          if (!t.bpms.some((b) => b.beat <= 0)) t.bpms.unshift({ beat: 0, bpm: t.bpms[0].bpm });
          break;
        case 'stop':
          t.stops = t.stops.filter((s) => !same(s));
          if (value !== null && num !== 0) t.stops.push({ beat, seconds: num });
          break;
        case 'delay':
          t.delays = t.delays.filter((s) => !same(s));
          if (value !== null && num !== 0) t.delays.push({ beat, seconds: num });
          break;
        case 'warp':
          t.warps = t.warps.filter((s) => !same(s));
          if (value !== null && num > 0) t.warps.push({ beat, length: num });
          break;
        case 'timesig': {
          t.timeSigs = t.timeSigs.filter((s) => !same(s));
          if (value !== null) {
            const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value);
            if (m) t.timeSigs.push({ beat, num: +m[1], den: +m[2] });
          }
          break;
        }
        case 'label':
          t.labels = t.labels.filter((s) => !same(s));
          if (value) t.labels.push({ beat, text: value });
          break;
      }
    }, `${value === null ? 'Remove' : 'Set'} ${SEGMENT_META[type].name}`);
  }

  removeSegments(segs: Segment[]): void {
    const has = (type: SegmentType, beat: number) => segs.some((s) => s.type === type && Math.abs(s.beat - beat) < 1e-6);
    this.editTiming((t) => {
      t.bpms = t.bpms.filter((s) => !has('bpm', s.beat) || s.beat === 0);
      t.stops = t.stops.filter((s) => !has('stop', s.beat));
      t.delays = t.delays.filter((s) => !has('delay', s.beat));
      t.warps = t.warps.filter((s) => !has('warp', s.beat));
      t.timeSigs = t.timeSigs.filter((s) => !has('timesig', s.beat));
      t.labels = t.labels.filter((s) => !has('label', s.beat));
    }, 'Remove tempo changes');
  }

  setOffset(offset: number): void {
    this.editTiming((t) => (t.offset = Math.round(offset * 1e6) / 1e6), 'Change offset');
  }

  setInitialBpm(bpm: number): void {
    if (!(bpm > 0)) return;
    this.editTiming((t) => {
      if (t.bpms.length && t.bpms[0].beat <= 0) t.bpms[0].bpm = bpm;
      else t.bpms.unshift({ beat: 0, bpm });
    }, 'Change BPM');
  }

  /**
   * Moves the whole grid (every BPM marker together, by changing the offset) so that a beat lands
   * at `time`, keeping every BPM: syncing a chart whose tempo is already marked. The move is less
   * than a beat, so no note changes its beat. `bpm` is the tempo `time` was found at; half or
   * double the grid's tempo there is fine. Returns the move in seconds (later is positive).
   */
  alignGridTo(time: number, bpm: number): number {
    const beat = Math.round(this.tempo.timeToBeat(time));
    // Nearest point of whichever grid is finer: a double-tempo estimate can sit on a half beat.
    const period = Math.min(60 / bpm, 60 / this.tempo.bpmAt(beat));
    let shift = time - this.tempo.beatToTime(beat);
    shift -= Math.round(shift / period) * period;
    this.setOffset(this.timing.offset - shift);
    return shift;
  }

  /** Sets the offset and every BPM marker's value at once (their beats stay), as one undo step. */
  setOffsetAndBpms(offset: number, bpms: readonly number[], description = 'Fix sync'): void {
    this.editTiming((t) => {
      t.offset = Math.round(offset * 1e6) / 1e6;
      t.bpms.forEach((b, i) => {
        if (bpms[i] > 0) b.bpm = Math.round(bpms[i] * 1e6) / 1e6;
      });
    }, description);
  }

  /** Moves the music so that beat 0 shifts by `beats` (keeps the first BPM). */
  shiftOffsetByBeats(beats: number): void {
    this.setOffset(this.timing.offset + (beats * 60) / this.tempo.firstBpm);
  }

  /** Converts the selected region into a stop of the same duration. */
  regionToStop(): void {
    if (!this.region) return this.hud('Select a region first (Tab).');
    const { begin, end } = this.region;
    const seconds = this.tempo.rowToTime(end) - this.tempo.rowToTime(begin);
    this.history.startChain();
    this.shiftRows(begin, begin - end, true);
    this.setSegment('stop', begin / ROWS_PER_BEAT, String(Math.round(seconds * 1e6) / 1e6));
    this.history.finishChain('Region to stop');
    this.region = null;
    this.changed();
  }

  // ----------------------------------------------------------------------------------------------
  // Cursor and playback.

  setCursorRow(row: number): void {
    this.view.setCursorRow(row);
    if (this.audio.playing) this.audio.seek(this.view.cursorTime);
    this.needsRender = true;
  }

  setCursorTime(time: number): void {
    this.view.setCursorTime(time);
    if (this.audio.playing) this.audio.seek(this.view.cursorTime);
    this.needsRender = true;
  }

  setCursorOffset(ofs: number): void {
    this.view.setCursorOffset(ofs);
    if (this.audio.playing) this.audio.seek(this.view.cursorTime);
    this.needsRender = true;
  }

  moveCursorSnap(dir: 'up' | 'down'): void {
    const v = this.view;
    if (v.snapType > 0) {
      this.setCursorRow(v.snapRow(v.cursorRow, dir));
    } else {
      const delta = (dir === 'up' ? -128 : 128) / Math.abs(v.pixPerOfs);
      if (v.timeBased) this.setCursorTime(v.cursorTime + delta);
      else this.setCursorRow(v.cursorRow + delta);
    }
  }

  /** Moves to the next multiple of `rows` in the given direction. */
  moveCursorInterval(rows: number): void {
    if (this.view.reverse) rows = -rows;
    const size = Math.abs(rows);
    const row = this.view.cursorRow;
    if (rows < 0) {
      let delta = row % size;
      if (delta === 0 || (delta < size / 2 && this.audio.playing)) delta += size;
      this.setCursorRow(row - delta);
    } else {
      this.setCursorRow(row + size - (row % size));
    }
  }

  moveCursorToStream(top: boolean): void {
    const notes = this.notes;
    if (notes.length < 2) return;
    if (this.view.reverse) top = !top;
    const rows = [...new Set(notes.map((n) => n.row))];
    const cur = this.view.cursorRow;
    let i: number;
    if (top) {
      i = rows.findIndex((r) => r >= cur);
      if (i < 0) i = rows.length - 1;
      if (i > 0) {
        const interval = rows[i] - rows[i - 1];
        while (i > 0 && rows[i] - rows[i - 1] === interval) --i;
      }
    } else {
      i = 0;
      while (i < rows.length - 1 && rows[i + 1] <= cur) ++i;
      if (i < rows.length - 1) {
        const interval = rows[i + 1] - rows[i];
        while (i < rows.length - 1 && rows[i + 1] - rows[i] === interval) ++i;
      }
    }
    this.setCursorRow(rows[i]);
  }

  moveCursorToSelection(top: boolean): void {
    if (this.view.reverse) top = !top;
    if (this.region) return this.setCursorRow(top ? this.region.begin : this.region.end);
    const notes = this.selectedNotes();
    if (notes.length) this.setCursorRow(top ? notes[0].row : notes[notes.length - 1].row);
  }

  moveCursorToChartEdge(start: boolean): void {
    if (this.view.reverse) start = !start;
    if (start) this.setCursorRow(0);
    else {
      const last = this.notes.reduce((m, n) => Math.max(m, n.endRow), 0);
      this.setCursorRow(last || this.endRow());
    }
  }

  togglePlay(): void {
    if (this.audio.playing) {
      this.audio.pause();
      // Snap the cursor back onto a row so editing continues from a clean position.
      this.view.setCursorTime(this.view.cursorTime);
    } else {
      if (!this.audio.buffer) this.hud('No music loaded; playing silently.', 'note');
      this.audio.play(this.view.cursorTime);
    }
    this.changed();
  }

  /** Called every animation frame. */
  tick(): void {
    if (!this.audio.playing) return;
    const v = this.view;
    const t = this.audio.time;
    if (t >= v.endTime) {
      this.audio.pause();
      v.setCursorTime(v.endTime);
      this.changed();
      return;
    }
    v.setCursorTime(Math.max(t, v.beginTime));
    this.audio.scheduleTicks(
      this.settings.beatTick,
      this.settings.noteTick,
      (t0, t1) => {
        const out: number[] = [];
        for (let b = Math.ceil(this.tempo.timeToBeat(t0) - 1e-9); ; ++b) {
          const time = this.tempo.beatToTime(b);
          if (time >= t1) break;
          if (time >= t0) out.push(time);
          if (b > 1e6) break;
        }
        return out;
      },
      (t0, t1) => {
        const out: number[] = [];
        const r0 = Math.floor(this.tempo.timeToRow(t0)) - 1;
        let lastRow = -1;
        for (let i = lowerBoundRow(this.notes, r0); i < this.notes.length; ++i) {
          const n = this.notes[i];
          if (n.row === lastRow || n.type === 'mine' || n.type === 'fake') continue;
          const time = this.tempo.rowToTime(n.row);
          if (time >= t1) break;
          if (time >= t0) {
            out.push(time);
            lastRow = n.row;
          }
        }
        return out;
      },
    );
    this.needsRender = true;
  }

  setSpeed(speed: number): void {
    this.audio.setSpeed(Math.round(speed * 100) / 100);
    this.hud(`Speed: ${Math.round(this.audio.speed * 100)}%`);
    this.saveSettings();
    this.changed();
  }

  setVolume(volume: number): void {
    this.audio.setVolume(Math.round(volume * 100) / 100);
    this.hud(`Volume: ${Math.round(this.audio.volume * 100)}%`);
    this.saveSettings();
    this.changed();
  }

  // ----------------------------------------------------------------------------------------------
  // Statistics (used by chart properties and the status bar).

  noteStats(chart: Chart | null = this.chart) {
    const notes = chart?.notes ?? [];
    const rows = new Map<number, number>();
    let mines = 0;
    let holds = 0;
    let rolls = 0;
    let lifts = 0;
    let fakes = 0;
    for (const n of notes) {
      if (n.type === 'mine') ++mines;
      else if (n.type === 'fake') ++fakes;
      else {
        rows.set(n.row, (rows.get(n.row) ?? 0) + 1);
        if (n.type === 'hold' && isLong(n)) ++holds;
        if (n.type === 'roll' && isLong(n)) ++rolls;
        if (n.type === 'lift') ++lifts;
      }
    }
    let jumps = 0;
    let hands = 0;
    let quads = 0;
    let taps = 0;
    for (const c of rows.values()) {
      taps += c;
      if (c === 2) ++jumps;
      if (c === 3) ++hands;
      if (c >= 4) ++quads;
    }
    const tapRows = [...rows.keys()].sort((a, b) => a - b);
    let duration = 0;
    if (tapRows.length > 1) duration = this.tempo.rowToTime(tapRows[tapRows.length - 1]) - this.tempo.rowToTime(tapRows[0]);
    // Peak NPS: the most notes inside any one-second window.
    let peak = 0;
    for (let i = 0, j = 0; i < tapRows.length; ++i) {
      const ti = this.tempo.rowToTime(tapRows[i]);
      while (this.tempo.rowToTime(tapRows[j]) < ti - 1) ++j;
      let count = 0;
      for (let k = j; k <= i; ++k) count += rows.get(tapRows[k]) ?? 0;
      peak = Math.max(peak, count);
    }
    return {
      notes: taps,
      steps: tapRows.length,
      jumps,
      hands,
      quads,
      holds,
      rolls,
      mines,
      lifts,
      fakes,
      avgNps: duration > 0 ? taps / duration : 0,
      peakNps: peak,
      duration,
    };
  }
}

export function fmtNum(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

export function formatTime(t: number): string {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}
