// Similar sections: groups of equally long stretches of the song that sound alike, found
// automatically from the audio or marked by hand, plus the side-by-side compare state.

import { analyzeOnsets, analyzeStructure } from '../analysis/detect';
import { beatSimilarity, rankMatches, type BeatFeatures } from '../analysis/structure';
import { lowerBoundRow } from '../model/notes';
import { ROWS_PER_BEAT, type Note, type Simfile } from '../model/types';
import type { Editor, MirrorMode } from './editor';

export interface SectionGroup {
  id: number;
  /** Length of every occurrence, in rows. */
  length: number;
  /** Start row of each occurrence, ascending. */
  starts: number[];
  auto: boolean;
  /** Mean audio similarity (auto groups). */
  score?: number;
}

export interface Pane {
  /** Occurrence index in the shown group (-1: the main pane outside any section). */
  occurrence: number;
  /** First row of the occurrence (the main pane outside a section: its cursor row). */
  start: number;
  /** Rows from the edit cursor to this pane's position. */
  delta: number;
  /** The pane being edited (holds the cursor). */
  focused: boolean;
  /** The main notefield (leftmost). */
  main: boolean;
}

interface SectionTree {
  parent: Map<number, SectionGroup | null>;
  depth: Map<number, number>;
  names: Map<number, string>;
  /** Parents before their parts, siblings by position in the song. */
  order: SectionGroup[];
}

export const SECTION_COLORS = ['#f2b134', '#4fc3f7', '#ef6f9b', '#9ccc65', '#b39ddb', '#ff8a65', '#4db6ac', '#e0e0e0'];

export type CopyTransform = 'none' | MirrorMode;

export class SectionManager {
  groups: SectionGroup[] = [];
  /** Group the dialog and "add cursor position" act on. */
  activeId: number | null = null;
  features: BeatFeatures | null = null;
  status: 'idle' | 'analyzing' | 'ready' | 'error' = 'idle';
  /**
   * What the side views show while they are on: the group whose occurrence holds the main
   * cursor (`occ`), the side occurrence being edited (`focus`, null = the main pane), the
   * horizontal scroll, and side views closed with × (per group, until side views are turned off).
   */
  side: { groupId: number | null; occ: number; focus: number | null; scroll: number; reveal: boolean } = {
    groupId: null,
    occ: -1,
    focus: null,
    scroll: 0,
    reveal: false,
  };
  private hidden = new Map<number, Set<number>>();
  /** Bumped when groups change, so the side views re-check what they show. */
  private version = 0;
  private followed = { row: -1, version: -1 };
  /** Results of the last "find similar to selection", shown in the dialog. */
  candidates: { begin: number; length: number; groupId: number | null; list: { start: number; score: number }[] } | null = null;
  private nextId = 1;
  private songKey = '';
  /** Timing the features were computed with; analysis is redone when it changes. */
  private featuresTiming = '';

  constructor(private readonly ed: Editor) {}

  colorOf(g: SectionGroup): string {
    const i = this.tree().order.indexOf(g);
    return SECTION_COLORS[(i + SECTION_COLORS.length) % SECTION_COLORS.length];
  }

  /** Tree name: top-level groups A, B, …; parts inside D are Da, Db, …; inside Da: Da1, Da2, … */
  nameOf(g: SectionGroup): string {
    return this.tree().names.get(g.id) ?? '?';
  }

  /** "Dc1#4": the 4th occurrence of group Dc1 (with a #, since group names can end in digits). */
  occurrenceLabel(g: SectionGroup, k: number): string {
    return `${this.nameOf(g)}#${k + 1}`;
  }

  /** 0 for top-level groups, 1 for parts inside them, and so on. */
  depthOf(g: SectionGroup): number {
    return this.tree().depth.get(g.id) ?? 0;
  }

  parentOf(g: SectionGroup): SectionGroup | null {
    return this.tree().parent.get(g.id) ?? null;
  }

  /** Groups in tree order (each parent followed by its parts), with depths. */
  get ordered(): { group: SectionGroup; depth: number }[] {
    const t = this.tree();
    return t.order.map((group) => ({ group, depth: t.depth.get(group.id) ?? 0 }));
  }

  get maxDepth(): number {
    let d = 0;
    for (const v of this.tree().depth.values()) d = Math.max(d, v);
    return d;
  }

  private treeCache: { version: number; groups: SectionGroup[]; value: SectionTree } | null = null;

  /**
   * The nesting of groups, derived from their occurrences: a group's parent is the smallest
   * group at least 1.5 times as long that contains the most of its occurrences.
   */
  private tree(): SectionTree {
    const c = this.treeCache;
    if (c && c.version === this.version && c.groups === this.groups) return c.value;
    const groups = this.groups;
    const inside = (child: SectionGroup, start: number, parent: SectionGroup) =>
      parent.starts.some((p) => Math.min(start + child.length, p + parent.length) - Math.max(start, p) >= 0.9 * child.length);
    const parent = new Map<number, SectionGroup | null>();
    for (const g of groups) {
      let best: SectionGroup | null = null;
      let bestCount = 0;
      for (const p of groups) {
        if (p === g || p.length < 1.5 * g.length) continue;
        const count = g.starts.filter((st) => inside(g, st, p)).length;
        if (count > bestCount || (count === bestCount && count > 0 && best && p.length < best.length)) {
          best = p;
          bestCount = count;
        }
      }
      parent.set(g.id, best);
    }
    const children = new Map<number | null, SectionGroup[]>();
    for (const g of groups) {
      const key = parent.get(g.id)?.id ?? null;
      let list = children.get(key);
      if (!list) children.set(key, (list = []));
      list.push(g);
    }
    for (const list of children.values()) list.sort((a, b) => a.starts[0] - b.starts[0] || b.length - a.length);
    const depth = new Map<number, number>();
    const names = new Map<number, string>();
    const order: SectionGroup[] = [];
    const visit = (g: SectionGroup, d: number, name: string) => {
      depth.set(g.id, d);
      names.set(g.id, name);
      order.push(g);
      (children.get(g.id) ?? []).forEach((child, i) => {
        // Letters and digits alternate by depth: D → Da → Da1 → Da1a …
        const suffix = d % 2 === 0 ? String.fromCharCode(97 + (i % 26)) : String(i + 1);
        visit(child, d + 1, name + suffix);
      });
    };
    (children.get(null) ?? []).forEach((g, i) => visit(g, 0, i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`));
    const value: SectionTree = { parent, depth, names, order };
    this.treeCache = { version: this.version, groups, value };
    return value;
  }

  get active(): SectionGroup | null {
    return this.groups.find((g) => g.id === this.activeId) ?? null;
  }

  measureLabel(row: number): string {
    return `m${Math.floor(this.ed.tempo.beatToMeasure(row / ROWS_PER_BEAT) + 1e-6)}`;
  }

  // ----------------------------------------------------------------------------------------------
  // Lifecycle and persistence (per song, in localStorage).

  /** Called when a simfile is opened or closed. Groups come from the file, else from the browser. */
  reset(): void {
    this.groups = [];
    this.features = null;
    this.status = 'idle';
    this.clearSide();
    this.activeId = null;
    this.candidates = null;
    const sim = this.ed.sim;
    this.songKey = sim ? `better-arrow-vortex.sections:${sim.meta.TITLE}|${sim.meta.ARTIST}|${sim.meta.MUSIC}` : '';
    if (!this.songKey) return;
    const fromFile = sim?.editor?.sections;
    if (fromFile?.length) {
      this.groups = fromFile.map((s) => ({
        id: this.nextId++,
        length: Math.round(s.length * ROWS_PER_BEAT),
        starts: s.starts.map((b) => Math.round(b * ROWS_PER_BEAT)).sort((a, b) => a - b),
        auto: !!s.auto,
        score: s.score,
      }));
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(this.songKey) ?? 'null') as SectionGroup[] | null;
      if (Array.isArray(saved)) {
        this.groups = saved;
        this.nextId = Math.max(0, ...saved.map((g) => g.id)) + 1;
      }
    } catch {
      // ignore unreadable storage
    }
  }

  /** Puts the groups into the simfile's editor data (or removes them), before saving. */
  storeInto(sim: Simfile, enabled: boolean): void {
    const sections = enabled
      ? this.groups.map((g) => ({
          length: g.length / ROWS_PER_BEAT,
          starts: g.starts.map((r) => r / ROWS_PER_BEAT),
          auto: g.auto,
          score: g.score,
        }))
      : [];
    sim.editor = { ...(sim.editor ?? {}), sections };
  }

  private save(): void {
    if (!this.songKey) return;
    try {
      localStorage.setItem(this.songKey, JSON.stringify(this.groups));
    } catch {
      // storage unavailable
    }
  }

  /** `byUser`: the groups were edited (not just auto-detected on load), so the file needs saving. */
  private changed(byUser = true): void {
    ++this.version;
    this.save();
    if (byUser && this.ed.settings.sectionsInFile) this.ed.metaDirty = true;
    this.ed.changed();
  }

  // ----------------------------------------------------------------------------------------------
  // Analysis.

  private beatTimes(): Float64Array {
    const tempo = this.ed.tempo;
    const dur = this.ed.audio.duration;
    const times: number[] = [];
    for (let b = 0; times.length < 100000; ++b) {
      const t = tempo.beatToTime(b);
      if (t > dur) break;
      times.push(t);
    }
    return Float64Array.from(times);
  }

  /**
   * Computes beat features for the current beat grid. With `replaceAuto`, the automatically
   * found groups are replaced (manual groups are kept); otherwise auto groups are only added
   * when the song has no saved groups yet.
   */
  async analyze(replaceAuto: boolean): Promise<void> {
    const ed = this.ed;
    const buffer = ed.audio.buffer;
    if (!buffer) {
      ed.hud('Load the music first.', 'warning');
      return;
    }
    this.status = 'analyzing';
    ed.changed();
    try {
      const onsets = ed.onsets ?? (await analyzeOnsets(buffer));
      const timing = JSON.stringify(ed.timing);
      const { features, groups } = await analyzeStructure(buffer, this.beatTimes(), onsets);
      if (ed.audio.buffer !== buffer) return; // another song was loaded meanwhile
      this.features = features;
      this.featuresTiming = timing;
      this.status = 'ready';
      // Automatic groups are refreshed (detection may have improved); hand-made ones are kept.
      if (replaceAuto || this.groups.every((g) => g.auto)) {
        this.groups = this.groups.filter((g) => !g.auto);
        for (const r of groups) {
          this.groups.push({
            id: this.nextId++,
            length: r.length * ROWS_PER_BEAT,
            starts: r.starts.map((s) => s * ROWS_PER_BEAT),
            auto: true,
            score: r.score,
          });
        }
        this.sortGroups();
        if (replaceAuto || groups.length) ed.hud(`Found ${groups.length} group(s) of similar sections.`);
      }
      this.changed(replaceAuto);
    } catch (e) {
      this.status = 'error';
      ed.hud(`Section analysis failed: ${(e as Error).message}`, 'warning');
      ed.changed();
    }
  }

  /** Features matching the current timing, recomputing them if the beat grid changed. */
  private async currentFeatures(): Promise<BeatFeatures | null> {
    if (!this.features || this.featuresTiming !== JSON.stringify(this.ed.timing)) await this.analyze(false);
    return this.features;
  }

  /** Audio similarity of the beats at two rows (null when unknown). */
  similarityAt(rowA: number, rowB: number): number | null {
    if (!this.features || this.featuresTiming !== JSON.stringify(this.ed.timing)) return null;
    return beatSimilarity(this.features, Math.floor(rowA / ROWS_PER_BEAT), Math.floor(rowB / ROWS_PER_BEAT));
  }

  // ----------------------------------------------------------------------------------------------
  // Editing groups.

  private sortGroups(): void {
    for (const g of this.groups) g.starts.sort((a, b) => a - b);
    this.groups.sort((a, b) => a.starts[0] - b.starts[0]);
  }

  private overlapsOccurrence(g: SectionGroup, start: number): boolean {
    return g.starts.some((s) => start < s + g.length && s < start + g.length);
  }

  /** New manual group from the selected region (Tab). */
  newGroupFromRegion(): SectionGroup | null {
    const r = this.ed.region;
    if (!r) {
      this.ed.hud('Select a region first (Tab at the start, Tab at the end).');
      return null;
    }
    const g: SectionGroup = { id: this.nextId++, length: r.end - r.begin, starts: [r.begin], auto: false };
    this.groups.push(g);
    this.sortGroups();
    this.activeId = g.id;
    this.ed.hud(`New section group ${this.nameOf(g)} (${this.measureLabel(r.begin)}). Add similar places with "Add cursor position".`);
    this.changed();
    return g;
  }

  /** Adds an occurrence of the active group starting at the cursor (snapped to the current snap). */
  addOccurrenceAtCursor(): void {
    const g = this.active;
    if (!g) return this.ed.hud('Choose a section group first (Sections dialog, Shift+M).');
    const start = this.ed.view.snapRow(this.ed.view.cursorRow, 'closest');
    this.addOccurrence(g, start);
  }

  addOccurrence(g: SectionGroup, start: number): void {
    if (this.overlapsOccurrence(g, start)) return this.ed.hud('That overlaps an occurrence already in the group.');
    this.groupEdited(g);
    g.starts.push(start);
    g.auto = false; // edited by hand: keep it when detection runs again
    this.sortGroups();
    this.ed.hud(`Added ${this.measureLabel(start)} to group ${this.nameOf(g)}.`);
    this.changed();
  }

  removeOccurrence(g: SectionGroup, index: number): void {
    g.starts.splice(index, 1);
    g.auto = false;
    this.groupEdited(g);
    if (g.starts.length === 0) this.removeGroup(g);
    else this.changed();
  }

  removeGroup(g: SectionGroup): void {
    this.groups = this.groups.filter((x) => x !== g);
    this.groupEdited(g);
    if (this.activeId === g.id) this.activeId = null;
    this.changed();
  }

  setActive(g: SectionGroup | null): void {
    this.activeId = g?.id ?? null;
    this.ed.changed();
  }

  /** Finds places that sound like the selected region (best first) and keeps them in `candidates`. */
  async findSimilarToRegion(): Promise<void> {
    const r = this.ed.region;
    if (!r) return this.ed.hud('Select a region first (Tab at the start, Tab at the end).');
    const f = await this.currentFeatures();
    if (!f) return;
    const start = Math.round(r.begin / ROWS_PER_BEAT);
    const len = Math.max(1, Math.round((r.end - r.begin) / ROWS_PER_BEAT));
    const offset = r.begin - start * ROWS_PER_BEAT; // keep the region's position inside the beat
    const list = rankMatches(f, start, len).map((m) => ({ start: m.start * ROWS_PER_BEAT + offset, score: m.score }));
    this.candidates = { begin: r.begin, length: r.end - r.begin, groupId: null, list };
    this.ed.hud(list.length ? `Found ${list.length} similar place(s); add them in the Sections dialog.` : 'No similar places found.');
    this.ed.changed();
  }

  /** Adds a find-similar result, creating the group for the searched region on first use. */
  addCandidate(start: number): void {
    const c = this.candidates;
    if (!c) return;
    let g = this.groups.find((x) => x.id === c.groupId);
    if (!g) {
      g = { id: this.nextId++, length: c.length, starts: [c.begin], auto: false };
      this.groups.push(g);
      c.groupId = g.id;
      this.activeId = g.id;
    }
    this.addOccurrence(g, start);
  }

  // ----------------------------------------------------------------------------------------------
  // Copying between occurrences.

  notesIn(start: number, length: number): Note[] {
    const notes = this.ed.notes;
    const out: Note[] = [];
    for (let i = lowerBoundRow(notes, start); i < notes.length && notes[i].row < start + length; ++i) out.push(notes[i]);
    return out;
  }

  /** Replaces the notes of occurrence `to` with those of `from`, optionally mirrored. */
  copy(g: SectionGroup, from: number, to: number, transform: CopyTransform): void {
    if (from === to) return;
    const src = g.starts[from];
    const dst = g.starts[to];
    const map = transform === 'none' ? null : this.ed.mirrorMap(transform);
    const add = this.notesIn(src, g.length).map((n): Note => {
      // Holds running past the end of the section are cut at its last row.
      const end = Math.max(n.row, Math.min(n.endRow, src + g.length - 1));
      const type = end === n.row && (n.type === 'hold' || n.type === 'roll') ? 'tap' : n.type;
      return { row: n.row - src + dst, endRow: end - src + dst, col: map ? map[n.col] : n.col, type };
    });
    const remove = this.notesIn(dst, g.length);
    this.ed.editNotes(remove, add, `Copy section ${this.measureLabel(src)} to ${this.measureLabel(dst)}`);
    this.ed.hud(`Copied ${add.length} note(s) from ${this.measureLabel(src)} to ${this.measureLabel(dst)}${map ? ` (${transform})` : ''}.`);
  }

  // ----------------------------------------------------------------------------------------------
  // Side views: while on, the other occurrences of the section the main cursor is in are shown
  // next to the main notefield, in lockstep. They follow the main cursor from section to section.

  get sideViewsOn(): boolean {
    return this.ed.settings.sideViews;
  }

  toggleSideViews(): void {
    if (this.sideViewsOn) {
      this.focusMain();
      this.clearSide();
      this.ed.settings.sideViews = false;
    } else {
      this.ed.settings.sideViews = true;
      this.followed.row = -1;
      this.follow();
      const g = this.shownGroup;
      if (!g) this.ed.hud('Side views on. They show the other occurrences of the section you are in.');
    }
    this.ed.saveSettings();
    this.ed.changed();
  }

  private clearSide(): void {
    this.side = { groupId: null, occ: -1, focus: null, scroll: 0, reveal: false };
    this.hidden.clear();
  }

  /** Group edited: occurrence indices may change, so edit the main pane and re-check. */
  private groupEdited(g: SectionGroup): void {
    if (this.side.groupId !== g.id) return;
    this.focusMain();
    this.side.groupId = null;
    this.hidden.delete(g.id);
  }

  occurrenceAt(g: SectionGroup, row: number): number {
    return g.starts.findIndex((s) => row >= s && row < s + g.length);
  }

  /** Groups with an occurrence at `row`, outermost first (one chain from the tree when possible). */
  pathAt(row: number): SectionGroup[] {
    const inside = this.groups.filter((g) => this.occurrenceAt(g, row) >= 0);
    return inside.sort((a, b) => this.depthOf(a) - this.depthOf(b) || b.length - a.length);
  }

  /**
   * The group the side views show at `row`: the one at the chosen level (`sideDepth`) if the
   * row is in one, else the nearest coarser one, else the coarsest available.
   */
  groupAt(row: number): SectionGroup | null {
    const path = this.pathAt(row).filter((g) => g.starts.length >= 2);
    if (!path.length) return null;
    const want = this.ed.settings.sideDepth;
    const atOrAbove = path.filter((g) => this.depthOf(g) <= want);
    const pick = atOrAbove.length ? atOrAbove : path;
    const depth = atOrAbove.length ? Math.max(...atOrAbove.map((g) => this.depthOf(g))) : this.depthOf(path[0]);
    const same = pick.filter((g) => this.depthOf(g) === depth);
    return same.find((g) => g.id === this.activeId) ?? [...same].sort((a, b) => a.length - b.length)[0];
  }

  /** `{` / `}`: side views follow coarser or finer sections. */
  changeSideDepth(step: number): void {
    const s = this.ed.settings;
    const next = Math.max(0, Math.min(this.maxDepth, s.sideDepth + step));
    if (next === s.sideDepth) {
      this.ed.hud(step < 0 ? 'Already at the coarsest level.' : 'No finer level here.');
      return;
    }
    s.sideDepth = next;
    this.ed.saveSettings();
    this.focusMain();
    this.side.groupId = null; // choose again at the new level
    this.followed.row = -1;
    this.follow();
    this.ed.hud(`Side views follow level ${next + 1} of ${this.maxDepth + 1}${next === 0 ? ' (whole sections)' : ' (parts inside sections)'}.`);
    this.ed.changed();
  }

  get shownGroup(): SectionGroup | null {
    return this.groups.find((g) => g.id === this.side.groupId) ?? null;
  }

  /** Rows from the edit cursor to the main pane's position (0 when editing the main pane). */
  get mainDelta(): number {
    const g = this.shownGroup;
    const f = this.side.focus;
    return g && f !== null && this.side.occ >= 0 ? g.starts[this.side.occ] - g.starts[f] : 0;
  }

  /** Row of the main pane's cursor. */
  get mainRow(): number {
    return this.ed.view.cursorRow + this.mainDelta;
  }

  /**
   * Called every frame: keeps the side views on the section the main cursor is in. Staying in
   * the shown group keeps it (moving to another of its occurrences just changes which ones are
   * at the side); leaving it switches to the section the cursor entered, or to none.
   */
  follow(): void {
    if (!this.sideViewsOn || !this.ed.isOpen) return;
    const row = this.mainRow;
    if (row === this.followed.row && this.version === this.followed.version) return;
    this.followed = { row, version: this.version };
    const current = this.shownGroup;
    const target = this.groupAt(row);
    const occ = current ? this.occurrenceAt(current, row) : -1;
    if (current && occ >= 0 && (!target || this.depthOf(target) === this.depthOf(current))) {
      if (occ !== this.side.occ) {
        // Into another occurrence of the same group (e.g. back-to-back repeats).
        if (this.side.focus === occ) this.focusMain();
        this.side.occ = occ;
        this.ed.changed();
      }
      return;
    }
    const next = target;
    if ((next?.id ?? null) === this.side.groupId) return;
    this.focusMain();
    const mainRow = this.ed.view.cursorRow;
    this.side = { groupId: next?.id ?? null, occ: next ? this.occurrenceAt(next, mainRow) : -1, focus: null, scroll: 0, reveal: false };
    if (next) this.activeId = next.id;
    this.followed = { row: mainRow, version: this.version };
    this.ed.changed();
  }

  /** The panes to draw left to right: the main notefield, then the side views (null when off). */
  panes(): Pane[] | null {
    if (!this.sideViewsOn) return null;
    const g = this.shownGroup;
    const { occ, focus } = this.side;
    const mainDelta = this.mainDelta;
    const main: Pane = { occurrence: g ? occ : -1, start: g && occ >= 0 ? g.starts[occ] : this.mainRow, delta: mainDelta, focused: focus === null, main: true };
    if (!g || occ < 0) return [main];
    const hidden = this.hidden.get(g.id);
    const sides = g.starts
      .map((start, i) => ({ start, i }))
      .filter(({ i }) => i !== occ && !hidden?.has(i))
      .map(({ start, i }): Pane => ({ occurrence: i, start, delta: start - g.starts[occ] + mainDelta, focused: focus === i, main: false }));
    return [main, ...sides];
  }

  scrollBy(dx: number): void {
    this.side.scroll = Math.max(0, this.side.scroll + dx);
    this.ed.needsRender = true;
  }

  /** Edits a side view (`index`) or the main pane (null); the position inside the section is kept. */
  focusPane(index: number | null): void {
    const g = this.shownGroup;
    if (index === this.side.focus || (index !== null && (!g || index < 0 || index >= g.starts.length || index === this.side.occ))) return;
    const from = this.mainDelta; // edit cursor -> main
    this.side.focus = index;
    const to = this.mainDelta;
    this.side.reveal = index !== null;
    this.ed.placing.clear();
    this.ed.setCursorRow(this.ed.view.cursorRow + from - to);
    this.followed.row = this.mainRow; // the main cursor did not move
    this.ed.changed();
  }

  focusMain(): void {
    if (this.side.focus !== null) this.focusPane(null);
  }

  /** [ and ]: edit the pane to the left / right. */
  focusNext(step: number): void {
    const panes = this.panes();
    if (!panes) return;
    const at = panes.findIndex((p) => p.focused);
    const next = panes[at + step];
    if (next) this.focusPane(next.main ? null : next.occurrence);
  }

  /** × on a side view: hides it until side views are turned off. */
  closeSideView(index: number): void {
    const g = this.shownGroup;
    if (!g) return;
    if (this.side.focus === index) this.focusMain();
    let set = this.hidden.get(g.id);
    if (!set) this.hidden.set(g.id, (set = new Set()));
    set.add(index);
    this.ed.changed();
  }
}
