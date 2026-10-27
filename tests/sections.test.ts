import { beforeEach, describe, expect, it } from 'vitest';
import { findRepeats, rankMatches, type BeatFeatures } from '../src/analysis/structure';
import { Editor } from '../src/editor/editor';
import { FileSource } from '../src/editor/files';
import { loadSm } from '../src/model/simfileIO';

// Node has no localStorage; groups are persisted through it.
if (!('localStorage' in globalThis)) {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

/** Random unit vectors per beat, with beats [from, from+len) copied to `to`. */
function features(beats: number, from: number, len: number, to: number): BeatFeatures {
  const dims = 36;
  const data = new Float32Array(beats * dims);
  let seed = 5;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b < beats; ++b) {
    let norm = 0;
    for (let d = 0; d < dims; ++d) norm += (data[b * dims + d] = rand()) ** 2;
    for (let d = 0; d < dims; ++d) data[b * dims + d] /= Math.sqrt(norm);
  }
  data.copyWithin(to * dims, from * dims, (from + len) * dims);
  return { beats, dims, data };
}

describe('section detection', () => {
  const f = features(240, 12, 48, 112);

  it('finds a planted repeat', () => {
    const groups = findRepeats(f);
    expect(groups).toHaveLength(1);
    expect(groups[0].starts).toEqual([12, 112]);
    expect(groups[0].length).toBe(48);
  });

  it('ranks the repeat first for find-similar', () => {
    expect(rankMatches(f, 20, 16)[0].start).toBe(120);
  });
});

const SM = `#TITLE:Sections test;#OFFSET:0;#BPMS:0=120;
#NOTES:dance-single:me:Challenge:10::
1000
0100
0010
0001
,
0000
,
0000
;`;

const notes = (ed: Editor) => ed.notes.map((n) => `${n.row}:${n.col}`);

describe('SectionManager', () => {
  let ed: Editor;
  beforeEach(() => {
    localStorage.clear();
    ed = new Editor();
    ed.setSimfile(loadSm(SM), 'test.sm', new FileSource());
  });

  it('makes a group from the selected region and adds the cursor position', () => {
    ed.setRegion(0, 192);
    const g = ed.sections.newGroupFromRegion()!;
    expect(g.starts).toEqual([0]);
    expect(g.length).toBe(192);
    ed.view.setSnapType(1);
    ed.setCursorRow(96);
    ed.sections.addOccurrenceAtCursor(); // overlaps measure 0: rejected
    expect(g.starts).toEqual([0]);
    ed.setCursorRow(384);
    ed.sections.addOccurrenceAtCursor();
    expect(g.starts).toEqual([0, 384]);
  });

  it('copies one occurrence onto another with a mirror, as one undo step', () => {
    ed.setRegion(0, 192);
    const g = ed.sections.newGroupFromRegion()!;
    ed.sections.addOccurrence(g, 192);
    ed.sections.copy(g, 0, 1, 'both');
    expect(notes(ed)).toEqual(['0:0', '48:1', '96:2', '144:3', '192:3', '240:2', '288:1', '336:0']);
    ed.undo();
    expect(notes(ed)).toEqual(['0:0', '48:1', '96:2', '144:3']);
  });

  it('remembers groups per song', () => {
    ed.setRegion(0, 192);
    ed.sections.newGroupFromRegion();
    const again = new Editor();
    again.setSimfile(loadSm(SM), 'test.sm', new FileSource());
    expect(again.sections.groups.map((g) => g.starts)).toEqual([[0]]);
  });
});

describe('sections in the simfile', () => {
  it('round-trips through a comment line placed between tags', async () => {
    const { parseMsd, saveSm, saveSsc, loadSsc } = await import('../src/model/simfileIO');
    const sim = loadSm(SM);
    const plain = saveSm(sim).text;
    sim.editor = { sections: [{ length: 4, starts: [0, 8.5], auto: true, score: 0.61234 }] };
    const text = saveSm(sim).text;
    // The game sees exactly the same tags with or without the metadata.
    expect(parseMsd(text, true)).toEqual(parseMsd(plain, true));
    // It sits on its own line between tags (Etterna only skips comments outside tag values).
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith('//@better-arrow-vortex '));
    const before = lines.slice(0, i).filter((l) => l.trim() && !l.startsWith('//')).pop()!;
    expect(before.trimEnd().endsWith(';')).toBe(true);
    expect(loadSm(text).editor).toEqual({ sections: [{ length: 4, starts: [0, 8.5], auto: true, score: 0.61 }] });
    expect(loadSsc(saveSsc(sim).text).editor?.sections?.[0].starts).toEqual([0, 8.5]);
  });

  it('loads groups from the file and marks edits as unsaved', () => {
    const sim = loadSm(SM);
    sim.editor = { sections: [{ length: 4, starts: [0, 8] }] };
    const ed = new Editor();
    ed.setSimfile(sim, 'test.sm', new FileSource());
    expect(ed.sections.groups.map((g) => [g.length, g.starts])).toEqual([[192, [0, 384]]]);
    expect(ed.isDirty).toBe(false);
    ed.sections.removeOccurrence(ed.sections.groups[0], 1);
    expect(ed.isDirty).toBe(true);
    ed.sections.storeInto(ed.sim!, true);
    expect(ed.sim!.editor).toEqual({ sections: [{ length: 4, starts: [0], auto: false, score: undefined }] });
  });
});

describe('side views', () => {
  let ed: Editor;
  const layout = () => ed.sections.panes()?.map((p) => `${p.main ? 'main' : 'side'}:${p.occurrence}${p.focused ? '*' : ''}@${p.delta}`);
  const at = (row: number) => {
    ed.setCursorRow(row);
    ed.sections.follow();
    return layout();
  };
  beforeEach(() => {
    localStorage.clear();
    ed = new Editor();
    ed.setSimfile(loadSm(SM), 'test.sm', new FileSource());
    ed.setRegion(0, 192); // group A: m0 and m2
    ed.sections.addOccurrence(ed.sections.newGroupFromRegion()!, 384);
    ed.setRegion(192, 288); // group B: first half of m1 and of m3
    ed.sections.addOccurrence(ed.sections.newGroupFromRegion()!, 576);
    ed.clearSelection();
    ed.sections.setActive(null);
    ed.setCursorRow(48);
    ed.sections.toggleSideViews();
  });

  it('follow the section the main cursor is in', () => {
    expect(layout()).toEqual(['main:0*@0', 'side:1@384']);
    expect(at(400)).toEqual(['main:1*@0', 'side:0@-384']); // other occurrence of the same group
    expect(at(240)).toEqual(['main:0*@0', 'side:1@384']); // entered group B
    expect(ed.sections.nameOf(ed.sections.shownGroup!)).toBe('B');
    expect(at(300)).toEqual(['main:-1*@0']); // outside every section
  });

  it('edit a side view while the main cursor stays put, and return to it', () => {
    ed.sections.focusPane(1);
    expect(ed.view.cursorRow).toBe(432);
    expect(ed.sections.mainRow).toBe(48);
    expect(layout()).toEqual(['main:0@-384', 'side:1*@0']);
    ed.setCursorRow(456);
    ed.sections.follow();
    expect(ed.sections.mainRow).toBe(72);
    ed.sections.toggleSideViews(); // off: back to the main cursor
    expect(ed.view.cursorRow).toBe(72);
    expect(ed.sections.panes()).toBeNull();
  });

  it('return editing to the main pane when the main cursor enters another section', () => {
    ed.sections.focusPane(1);
    ed.setCursorRow(432 + 192); // main cursor now at 240, inside group B
    ed.sections.follow();
    expect(ed.view.cursorRow).toBe(240);
    expect(ed.sections.nameOf(ed.sections.shownGroup!)).toBe('B');
    expect(layout()).toEqual(['main:0*@0', 'side:1@384']);
  });

  it('close single side views with ×', () => {
    ed.sections.focusPane(1);
    ed.sections.closeSideView(1);
    expect(ed.view.cursorRow).toBe(48);
    expect(layout()).toEqual(['main:0*@0']);
  });
});
