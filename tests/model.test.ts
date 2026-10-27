import { describe, expect, it } from 'vitest';
import { applyNoteEdit, rowQuant } from '../src/model/notes';
import { loadSm, loadSsc, parseMsd, saveSm, saveSsc } from '../src/model/simfileIO';
import { TempoMap } from '../src/model/timing';
import { emptyTiming } from '../src/model/types';

const SM = `#TITLE:Re\\:Test;
#ARTIST:Someone;
#MUSIC:song.ogg;
#OFFSET:-0.100;
#BPMS:0.000=120.000,
8.000=240.000;
#STOPS:4.000=0.500;
#BGCHANGES:;

//---------------dance-single - me----------------
#NOTES:
     dance-single:
     me:
     Challenge:
     12:
     0.000,0.000,0.000,0.000,0.000:
1000
0100
0010
0001
,
2000
0000
3000
0M00
,  // comment
0000
00000
;
`;

describe('parseMsd', () => {
  it('splits params and strips comments', () => {
    const tags = parseMsd('#A:b:c;\n// x\n#D:e // trailing\n;', true);
    expect(tags).toEqual([
      { key: 'A', params: ['b', 'c'] },
      { key: 'D', params: ['e \n'] },
    ]);
  });
  it('recovers from a missing semicolon', () => {
    const tags = parseMsd('#A:b\n#C:d;', true);
    expect(tags.map((t) => [t.key, t.params[0]])).toEqual([
      ['A', 'b'],
      ['C', 'd'],
    ]);
  });
});

describe('sm round trip', () => {
  it('loads metadata, timing and notes', () => {
    const sim = loadSm(SM);
    expect(sim.meta.TITLE).toBe('Re:Test');
    expect(sim.timing.offset).toBeCloseTo(-0.1);
    expect(sim.timing.bpms).toEqual([
      { beat: 0, bpm: 120 },
      { beat: 8, bpm: 240 },
    ]);
    expect(sim.charts).toHaveLength(1);
    const c = sim.charts[0];
    expect(c.meter).toBe(12);
    expect(c.notes).toEqual([
      { row: 0, col: 0, type: 'tap', endRow: 0 },
      { row: 48, col: 1, type: 'tap', endRow: 48 },
      { row: 96, col: 2, type: 'tap', endRow: 96 },
      { row: 144, col: 3, type: 'tap', endRow: 144 },
      { row: 192, col: 0, type: 'hold', endRow: 288 },
      { row: 336, col: 1, type: 'mine', endRow: 336 },
    ]);
  });

  it('writes what it reads', () => {
    const sim = loadSm(SM);
    const again = loadSm(saveSm(sim).text);
    expect(again.charts[0].notes).toEqual(sim.charts[0].notes);
    expect(again.timing).toEqual(sim.timing);
    expect(again.meta).toEqual(sim.meta);
    const ssc = loadSsc(saveSsc(sim).text);
    expect(ssc.charts[0].notes).toEqual(sim.charts[0].notes);
    expect(ssc.meta.TITLE).toBe('Re:Test');
  });

  it('turns negative BPMs into warps and back', () => {
    const sim = loadSm('#BPMS:0=120,4=-120,6=120;');
    expect(sim.timing.warps).toHaveLength(1);
    expect(sim.timing.warps[0].beat).toBe(4);
    expect(sim.timing.warps[0].length).toBeCloseTo(4);
    const again = loadSm(saveSm(sim).text);
    expect(again.timing.warps[0].length).toBeCloseTo(4);
  });
});

describe('TempoMap', () => {
  it('handles offset, bpm changes and stops', () => {
    const t = emptyTiming();
    t.offset = -0.1;
    t.bpms = [
      { beat: 0, bpm: 120 },
      { beat: 8, bpm: 240 },
    ];
    t.stops = [{ beat: 4, seconds: 0.5 }];
    const m = new TempoMap(t);
    expect(m.beatToTime(0)).toBeCloseTo(0.1);
    expect(m.beatToTime(4)).toBeCloseTo(2.1); // note on a stop is hit before it
    expect(m.beatToTime(5)).toBeCloseTo(3.1);
    expect(m.beatToTime(8)).toBeCloseTo(4.6);
    expect(m.beatToTime(10)).toBeCloseTo(5.1);
    for (const b of [0, 1.5, 3.99, 5, 7.25, 9, 20]) expect(m.timeToBeat(m.beatToTime(b))).toBeCloseTo(b);
    expect(m.timeToBeat(2.3)).toBeCloseTo(4); // inside the stop
  });

  it('skips warped beats', () => {
    const t = emptyTiming();
    t.warps = [{ beat: 4, length: 2 }];
    const m = new TempoMap(t);
    expect(m.beatToTime(5)).toBeCloseTo(2);
    expect(m.beatToTime(6)).toBeCloseTo(2);
    expect(m.beatToTime(7)).toBeCloseTo(2.5);
    expect(m.timeToBeat(2.5)).toBeCloseTo(7);
  });

  it('counts measures with time signatures', () => {
    const t = emptyTiming();
    t.timeSigs = [{ beat: 8, num: 3, den: 4 }];
    const m = new TempoMap(t);
    const starts: number[] = [];
    m.forEachMeasure(0, 16, (beat) => starts.push(beat));
    expect(starts).toEqual([0, 4, 8, 11, 14]);
    expect(m.beatToMeasure(11)).toBeCloseTo(3);
  });
});

describe('notes', () => {
  it('replaces overlapped notes when adding a hold', () => {
    const notes = [
      { row: 0, col: 0, type: 'tap' as const, endRow: 0 },
      { row: 24, col: 0, type: 'tap' as const, endRow: 24 },
      { row: 24, col: 1, type: 'tap' as const, endRow: 24 },
      { row: 96, col: 0, type: 'tap' as const, endRow: 96 },
    ];
    const out = applyNoteEdit(notes, [], [{ row: 0, col: 0, type: 'hold', endRow: 48 }]);
    expect(out).toEqual([
      { row: 0, col: 0, type: 'hold', endRow: 48 },
      { row: 24, col: 1, type: 'tap', endRow: 24 },
      { row: 96, col: 0, type: 'tap', endRow: 96 },
    ]);
  });
  it('colours rows by quantization', () => {
    expect([0, 24, 16, 12, 8, 6, 4, 3, 1].map(rowQuant)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
