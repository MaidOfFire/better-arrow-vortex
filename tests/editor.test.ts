import { beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { FileSource } from '../src/editor/files';
import { loadSm, saveSm } from '../src/model/simfileIO';

const SM = `#TITLE:T;#OFFSET:0;#BPMS:0=120;
#NOTES:dance-single:me:Challenge:10::
1000
0100
0010
0001
,
0000
0000
0000
0000
;`;

const notes = (ed: Editor) => ed.notes.map((n) => `${n.row}:${n.col}:${n.type}${n.endRow > n.row ? `-${n.endRow}` : ''}`);

describe('Editor', () => {
  let ed: Editor;
  beforeEach(() => {
    ed = new Editor();
    ed.setSimfile(loadSm(SM), 'test.sm', new FileSource());
    ed.view.setSnapType(4); // 16th
  });

  it('places and removes taps with number keys', () => {
    ed.setCursorRow(96);
    ed.placeKeyDown(0, false);
    ed.placeKeyUp(0);
    expect(notes(ed)).toContain('96:0:tap');
    ed.placeKeyDown(0, false);
    ed.placeKeyUp(0);
    expect(notes(ed)).not.toContain('96:0:tap');
    expect(ed.isDirty).toBe(true);
  });

  it('places a hold by moving the cursor while the key is held', () => {
    ed.setCursorRow(192);
    ed.placeKeyDown(1, false);
    for (let i = 0; i < 4; ++i) ed.moveCursorSnap('down');
    ed.placeKeyUp(1);
    expect(notes(ed)).toContain('192:1:hold-240');
  });

  it('places mines with shift and undoes/redoes', () => {
    ed.setCursorRow(24);
    ed.placeKeyDown(3, true);
    ed.placeKeyUp(3);
    expect(notes(ed)).toContain('24:3:mine');
    ed.undo();
    expect(notes(ed)).not.toContain('24:3:mine');
    ed.redo();
    expect(notes(ed)).toContain('24:3:mine');
  });

  it('mirrors dance-single columns', () => {
    expect(ed.mirrorMap('horizontal')).toEqual([3, 1, 2, 0]);
    expect(ed.mirrorMap('vertical')).toEqual([0, 2, 1, 3]);
    expect(ed.mirrorMap('both')).toEqual([3, 2, 1, 0]);
    ed.selectAll();
    ed.mirror('both');
    expect(notes(ed)).toEqual(['0:3:tap', '48:2:tap', '96:1:tap', '144:0:tap']);
  });

  it('copies and pastes at the cursor', () => {
    ed.setRegion(0, 96);
    ed.copy(false);
    ed.setCursorRow(192);
    ed.paste(false);
    expect(notes(ed)).toEqual(['0:0:tap', '48:1:tap', '96:2:tap', '144:3:tap', '192:0:tap', '240:1:tap', '288:2:tap']);
  });

  it('inserts beats, shifting notes and tempo changes', () => {
    ed.setSegment('bpm', 2, '180');
    ed.setCursorRow(48);
    ed.insertBeats(1, false);
    expect(notes(ed)).toEqual(['0:0:tap', '96:1:tap', '144:2:tap', '192:3:tap']);
    expect(ed.timing.bpms).toEqual([
      { beat: 0, bpm: 120 },
      { beat: 3, bpm: 180 },
    ]);
    ed.undo();
    expect(notes(ed)).toEqual(['0:0:tap', '48:1:tap', '96:2:tap', '144:3:tap']);
    expect(ed.timing.bpms[1].beat).toBe(2);
  });

  it('edits and removes tempo changes', () => {
    ed.setSegment('stop', 1, '0.5');
    expect(ed.tempo.beatToTime(2)).toBeCloseTo(1.5);
    ed.setSegment('stop', 1, null);
    expect(ed.tempo.beatToTime(2)).toBeCloseTo(1);
    ed.setOffset(-0.25);
    expect(ed.tempo.beatToTime(0)).toBeCloseTo(0.25);
  });

  it('converts holds to rolls and back', () => {
    ed.editNotes([], [{ row: 192, col: 0, type: 'hold', endRow: 240 }], 'add');
    ed.selectWhere((n) => n.type === 'hold', 'hold');
    ed.toggleHoldsRolls();
    expect(notes(ed)).toContain('192:0:roll-240');
    ed.toggleHoldsRolls();
    expect(notes(ed)).toContain('192:0:hold-240');
  });

  it('scales and requantizes selected notes', () => {
    ed.selectAll();
    ed.scaleNotes(1, 2);
    expect(notes(ed)).toEqual(['0:0:tap', '24:1:tap', '48:2:tap', '72:3:tap']);
    ed.view.setSnapType(1); // 4ths
    ed.selectAll();
    ed.requantize();
    expect(notes(ed).map((s) => s.split(':')[0])).toEqual(['0', '48', '48', '96']);
  });

  it('saves the edited chart', () => {
    ed.setCursorRow(192);
    ed.placeKeyDown(0, false);
    ed.placeKeyUp(0);
    const again = loadSm(saveSm(ed.sim!).text);
    expect(again.charts[0].notes.map((n) => `${n.row}:${n.col}`)).toContain('192:0');
  });

  it('adds and deletes charts with undo', () => {
    ed.addChart('dance-double', 'Hard', 9, 'x');
    expect(ed.sim!.charts.length).toBe(2);
    expect(ed.numCols).toBe(8);
    ed.deleteChart();
    expect(ed.sim!.charts.length).toBe(1);
    ed.undo();
    expect(ed.sim!.charts.length).toBe(2);
  });
});
