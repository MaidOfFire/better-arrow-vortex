// Floating tool windows (ArrowVortex-style dialogs). Each dialog rebuilds or refreshes its
// controls when the editor reports a change.

import { detectTempo } from '../analysis/detect';
import type { TempoEstimate } from '../analysis/findTempo';
import { MENU, displayShortcut, type Action, type DialogId, type MenuEntry } from '../app/actions';
import { SEGMENT_META, fmtNum, formatTime, type Editor, type SegmentType } from '../editor/editor';
import type { CopyTransform, SectionGroup } from '../editor/sections';
import { GAME_STYLES, findStyle } from '../model/styles';
import { DIFFICULTIES, ROWS_PER_BEAT, ROWS_PER_MEASURE, type Difficulty, type MetaTag } from '../model/types';
import { button, field, h, numberInput, select, setIfIdle, textInput } from './dom';

export interface DialogHost {
  editor: Editor;
  actions: Map<string, Action>;
  layer: HTMLElement;
  closeDialog(d: Dialog): void;
  loadMusic(): Promise<void>;
}

let cascade = 0;

export abstract class Dialog {
  readonly el: HTMLElement;
  protected readonly body: HTMLElement;
  protected readonly ed: Editor;

  constructor(
    readonly id: string,
    title: string,
    protected readonly host: DialogHost,
    width = 300,
  ) {
    this.ed = host.editor;
    const close = h('button', { class: 'dlg-close', title: 'Close', type: 'button' }, '×');
    const titleBar = h('div', { class: 'dlg-title' }, h('span', {}, title), close);
    this.body = h('div', { class: 'dlg-body' });
    this.el = h('div', { class: 'dialog', style: `width:${width}px` }, titleBar, this.body);
    const offset = (cascade++ % 6) * 24;
    this.el.style.left = `${12 + offset}px`;
    this.el.style.top = `${12 + offset}px`;
    close.addEventListener('click', () => host.closeDialog(this));
    makeDraggable(this.el, titleBar);
    this.el.addEventListener('mousedown', () => {
      if (host.layer.lastElementChild !== this.el) host.layer.append(this.el); // bring to front
    });
    // Keys typed into dialog fields must not trigger editor shortcuts; Escape closes the dialog.
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        host.closeDialog(this);
        e.stopPropagation();
      } else if ((e.target as Element).closest('input, select, textarea')) {
        e.stopPropagation();
      }
    });
  }

  /** Builds the controls. Called once when shown and whenever `rebuildOnChange` says so. */
  abstract build(): void;

  /** Called after every editor change. Default: rebuild. */
  refresh(): void {
    if (this.el.contains(document.activeElement) && document.activeElement !== document.body) return;
    this.body.replaceChildren();
    this.build();
  }
}

function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const sx = e.clientX - el.offsetLeft;
    const sy = e.clientY - el.offsetTop;
    const move = (m: MouseEvent) => {
      const parent = el.parentElement!.getBoundingClientRect();
      el.style.left = `${Math.min(parent.width - 60, Math.max(0, m.clientX - sx))}px`;
      el.style.top = `${Math.min(parent.height - 30, Math.max(0, m.clientY - sy))}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

const section = (title: string) => h('div', { class: 'dlg-section' }, title);
const row = (...children: (Node | string)[]) => h('div', { class: 'dlg-row' }, ...children);

// ------------------------------------------------------------------------------------------------

class SongPropertiesDialog extends Dialog {
  constructor(host: DialogHost) {
    super('songProperties', 'Simfile properties', host, 340);
  }

  build(): void {
    const sim = this.ed.sim;
    if (!sim) {
      this.body.append(h('p', {}, 'No simfile open.'));
      return;
    }
    const text = (label: string, tag: MetaTag, title?: string) =>
      field(label, textInput(sim.meta[tag], (v) => this.ed.setMeta(tag, v.trim())), title);
    this.body.append(
      section('Metadata'),
      text('Title', 'TITLE'),
      text('Subtitle', 'SUBTITLE'),
      text('Artist', 'ARTIST'),
      text('Genre', 'GENRE'),
      text('Credit', 'CREDIT', 'Author of the simfile'),
      section('Transliteration'),
      text('Title', 'TITLETRANSLIT', 'Romanised title (#TITLETRANSLIT)'),
      text('Subtitle', 'SUBTITLETRANSLIT'),
      text('Artist', 'ARTISTTRANSLIT'),
      section('Files'),
      field('Music', h('div', { class: 'inline' }, textInput(sim.meta.MUSIC, (v) => this.ed.setMeta('MUSIC', v.trim())), button('…', () => void this.host.loadMusic(), 'Load a music file'))),
      text('Background', 'BACKGROUND'),
      text('Banner', 'BANNER'),
      text('CD title', 'CDTITLE'),
      text('Lyrics', 'LYRICSPATH'),
      section('Preview'),
      field('Start', numberInput(parseFloat(sim.meta.SAMPLESTART) || 0, (v) => this.ed.setMeta('SAMPLESTART', v.toFixed(3)), { step: 0.1 })),
      field('Length', numberInput(parseFloat(sim.meta.SAMPLELENGTH) || 0, (v) => this.ed.setMeta('SAMPLELENGTH', v.toFixed(3)), { step: 0.1 })),
      row(
        button('Set region', () => {
          const r = this.ed.region;
          if (!r) return this.ed.hud('Select a region first (Tab).');
          const t0 = this.ed.tempo.rowToTime(r.begin);
          const t1 = this.ed.tempo.rowToTime(r.end);
          this.ed.history.startChain();
          this.ed.setMeta('SAMPLESTART', t0.toFixed(3));
          this.ed.setMeta('SAMPLELENGTH', (t1 - t0).toFixed(3));
          this.ed.history.finishChain('Set preview');
        }, 'Use the selected region as the music preview'),
        button('Play', () => {
          const start = parseFloat(sim.meta.SAMPLESTART) || 0;
          this.ed.audio.play(start);
          const len = parseFloat(sim.meta.SAMPLELENGTH) || 10;
          setTimeout(() => this.ed.audio.playing && this.ed.audio.pause(), len * 1000);
        }, 'Play the music preview'),
      ),
      section('Display BPM'),
      field('Disp. BPM', textInput(sim.meta.DISPLAYBPM, (v) => this.ed.setMeta('DISPLAYBPM', v.trim()), { placeholder: 'empty = actual, 150, 120:180 or *' })),
      field('Selectable', select(['YES', 'NO'] as const, sim.meta.SELECTABLE === 'NO' ? 'NO' : 'YES', (v) => this.ed.setMeta('SELECTABLE', v))),
    );
  }
}

// ------------------------------------------------------------------------------------------------

function streamBreakdown(ed: Editor): { text: string; total: number; measures: number } {
  const notes = ed.notes;
  if (!notes.length) return { text: '', total: 0, measures: 0 };
  const lastMeasure = Math.floor(notes[notes.length - 1].row / ROWS_PER_MEASURE);
  const rows: Set<number>[] = Array.from({ length: lastMeasure + 1 }, () => new Set());
  for (const n of notes) if (n.type !== 'mine' && n.type !== 'fake') rows[Math.floor(n.row / ROWS_PER_MEASURE)].add(n.row);
  const isStream = rows.map((r) => r.size >= 16);
  const parts: string[] = [];
  let total = 0;
  let i = 0;
  while (i <= lastMeasure && !isStream[i]) ++i;
  while (i <= lastMeasure) {
    let run = 0;
    while (i <= lastMeasure && isStream[i]) {
      ++run;
      ++i;
    }
    total += run;
    parts.push(String(run));
    let gap = 0;
    while (i <= lastMeasure && !isStream[i]) {
      ++gap;
      ++i;
    }
    if (i > lastMeasure) break;
    parts.push(gap === 1 ? '-' : `(${gap})`);
  }
  return { text: parts.join(' ').replace(/ - /g, '-'), total, measures: lastMeasure + 1 };
}

class ChartPropertiesDialog extends Dialog {
  constructor(host: DialogHost) {
    super('chartProperties', 'Chart properties', host, 320);
  }

  build(): void {
    const ed = this.ed;
    const c = ed.chart;
    if (!c) {
      this.body.append(h('p', {}, 'No chart open. Create one with Chart > New chart.'));
      return;
    }
    const st = ed.noteStats();
    const stream = streamBreakdown(ed);
    const stat = (k: string, v: string | number) => h('tr', {}, h('td', {}, k), h('td', {}, String(v)));
    const info = [
      `${ed.sim?.meta.TITLE ?? ''} - ${ed.chartName()}`,
      `Notes: ${st.notes}, jumps: ${st.jumps}, hands: ${st.hands}, quads: ${st.quads}, holds: ${st.holds}, rolls: ${st.rolls}, mines: ${st.mines}`,
      `Avg NPS: ${st.avgNps.toFixed(2)}, peak NPS: ${st.peakNps}`,
      stream.text ? `Stream: ${stream.text}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.body.append(
      field('Chart type', select(GAME_STYLES.map((s) => [s.id, s.name] as [string, string]), c.stepsType, (v) => ed.editChart({ stepsType: v }))),
      field('Difficulty', select(DIFFICULTIES, c.difficulty, (v) => ed.editChart({ difficulty: v as Difficulty }))),
      field('Meter', numberInput(c.meter, (v) => ed.editChart({ meter: Math.max(1, Math.round(v)) }), { min: 1, step: 1 })),
      field('Step artist', textInput(c.description, (v) => ed.editChart({ description: v.trim() }), { title: 'Description / author of the chart' })),
      field('Chart name', textInput(c.chartName, (v) => ed.editChart({ chartName: v.trim() }), { title: '.ssc only' })),
      field('Credit', textInput(c.credit, (v) => ed.editChart({ credit: v.trim() }), { title: '.ssc only' })),
      section('Note information'),
      h(
        'table',
        { class: 'stats' },
        stat('Notes', st.notes),
        stat('Steps', st.steps),
        stat('Jumps / hands / quads', `${st.jumps} / ${st.hands} / ${st.quads}`),
        stat('Holds / rolls', `${st.holds} / ${st.rolls}`),
        stat('Mines', st.mines),
        stat('Lifts / fakes', `${st.lifts} / ${st.fakes}`),
        stat('Avg density', `${st.avgNps.toFixed(2)} NPS`),
        stat('Peak density', `${st.peakNps} NPS`),
        stat('Length', formatTime(st.duration)),
        stat('Total stream', stream.measures ? `${stream.total} (${Math.round((stream.total / stream.measures) * 100)}%)` : '0'),
      ),
      stream.text ? h('div', { class: 'breakdown', title: 'Measures of 16th stream; (n) = n-measure break, - = 1-measure break' }, stream.text) : '',
      row(
        button('Copy info', () => {
          void navigator.clipboard?.writeText(info).then(
            () => ed.hud('Note info copied to clipboard.'),
            () => ed.hud('Could not access the clipboard.', 'warning'),
          );
        }),
        button('Steps', () => this.host.actions.get('notes.selectSteps')?.run()),
        button('Jumps', () => this.host.actions.get('notes.selectJumps')?.run()),
        button('Mines', () => this.host.actions.get('notes.selectMines')?.run()),
        button('Holds', () => this.host.actions.get('notes.selectHolds')?.run()),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------

class ChartListDialog extends Dialog {
  constructor(host: DialogHost) {
    super('chartList', 'List of charts', host, 360);
  }

  build(): void {
    const sim = this.ed.sim;
    if (!sim || !sim.charts.length) {
      this.body.append(h('p', {}, 'No charts yet.'), button('New chart...', () => this.host.actions.get('chart.new')?.run()));
      return;
    }
    const table = h('table', { class: 'chart-list' });
    sim.charts.forEach((c, i) => {
      const tr = h(
        'tr',
        { class: i === this.ed.chartIndex ? 'current' : '', title: 'Open this chart in the editor' },
        h('td', {}, findStyle(c.stepsType).name),
        h('td', { class: `diff diff-${c.difficulty.toLowerCase()}` }, c.difficulty),
        h('td', { class: 'num' }, String(c.meter)),
        h('td', {}, c.description),
        h('td', { class: 'num' }, String(c.notes.filter((n) => n.type !== 'mine').length)),
      );
      tr.addEventListener('click', () => this.ed.openChart(i));
      table.append(tr);
    });
    this.body.append(table);
  }
}

// ------------------------------------------------------------------------------------------------

class NewChartDialog extends Dialog {
  private stepsType = 'dance-single';
  private difficulty: Difficulty = 'Challenge';
  private meter = 10;
  private author = '';

  constructor(host: DialogHost) {
    super('newChart', 'New chart', host, 300);
    const c = this.ed.chart;
    if (c) this.stepsType = c.stepsType;
  }

  build(): void {
    this.body.append(
      field('Chart type', select(GAME_STYLES.map((s) => [s.id, s.name] as [string, string]), this.stepsType, (v) => (this.stepsType = v))),
      field('Difficulty', select(DIFFICULTIES, this.difficulty, (v) => (this.difficulty = v as Difficulty))),
      field('Meter', numberInput(this.meter, (v) => (this.meter = Math.max(1, Math.round(v))), { min: 1 })),
      field('Step artist', textInput(this.author, (v) => (this.author = v.trim()))),
      row(
        button('Create', () => {
          if (!this.ed.isOpen) return this.ed.hud('Open a simfile or music file first.', 'warning');
          // Pick up values still being typed.
          this.body.querySelectorAll('input').forEach((i) => i.dispatchEvent(new Event('change')));
          this.ed.addChart(this.stepsType, this.difficulty, this.meter, this.author);
          this.host.closeDialog(this);
        }),
      ),
    );
  }

  refresh(): void {}
}

// ------------------------------------------------------------------------------------------------

class AdjustSyncDialog extends Dialog {
  private estimates: TempoEstimate[] = [];
  private chosen = 0;
  private busy = false;
  private offsetInput!: HTMLInputElement;
  private bpmInput!: HTMLInputElement;

  constructor(host: DialogHost) {
    super('adjustSync', 'Adjust sync', host, 320);
  }

  build(): void {
    const ed = this.ed;
    const t = ed.timing;
    this.offsetInput = numberInput(t.offset, (v) => ed.setOffset(v), { step: 0.001, title: 'Music start time relative to the first beat, in seconds' });
    this.bpmInput = numberInput(ed.tempo.firstBpm, (v) => ed.setInitialBpm(v), { step: 0.001, title: 'Music tempo at the first beat' });
    const tweakOffset = (d: number) => () => ed.setOffset(ed.timing.offset + d);
    const tweakBpm = (d: number) => () => ed.setInitialBpm(Math.round((ed.tempo.firstBpm + d) * 1000) / 1000);
    this.body.append(
      field('Music offset', this.offsetInput),
      row(button('−10ms', tweakOffset(-0.01)), button('−1ms', tweakOffset(-0.001)), button('+1ms', tweakOffset(0.001)), button('+10ms', tweakOffset(0.01))),
      field('Initial BPM', this.bpmInput),
      row(button('−0.1', tweakBpm(-0.1)), button('−0.01', tweakBpm(-0.01)), button('+0.01', tweakBpm(0.01)), button('+0.1', tweakBpm(0.1))),
      section('Move first beat'),
      row(
        button('+1 beat', () => ed.shiftOffsetByBeats(1), 'Increase the music offset by one beat'),
        button('+½', () => ed.shiftOffsetByBeats(0.5), 'Increase the music offset by half a beat'),
        button('−½', () => ed.shiftOffsetByBeats(-0.5), 'Decrease the music offset by half a beat'),
        button('−1 beat', () => ed.shiftOffsetByBeats(-1), 'Decrease the music offset by one beat'),
      ),
      section('Automatic BPM detection'),
    );
    const list = h('div', { class: 'estimates' });
    if (this.busy) list.append(h('p', {}, 'Analyzing the music...'));
    this.estimates.forEach((e, i) => {
      const radio = h('input', { type: 'radio', name: 'bpm-estimate', checked: i === this.chosen });
      radio.addEventListener('change', () => (this.chosen = i));
      list.append(
        h(
          'label',
          { class: 'estimate' },
          radio,
          h('span', { class: 'est-bpm' }, `${fmtNum(e.bpm, 3)} BPM`),
          h('span', { class: 'est-bar' }, h('span', { style: `width:${Math.round(e.fitness * 100)}%` })),
        ),
      );
    });
    this.body.append(
      list,
      row(
        button('Find BPM', () => void this.detect(), 'Estimate the music BPM by analyzing the audio'),
        button('Apply BPM', () => this.apply(), 'Apply the selected BPM estimate and align beat 0 with it'),
      ),
    );
  }

  refresh(): void {
    if (!this.offsetInput) return;
    setIfIdle(this.offsetInput, String(this.ed.timing.offset));
    setIfIdle(this.bpmInput, String(this.ed.tempo.firstBpm));
  }

  private rebuild(): void {
    this.body.replaceChildren();
    this.build();
  }

  private async detect(): Promise<void> {
    const buf = this.ed.audio.buffer;
    if (!buf) return this.ed.hud('Load the music first.', 'warning');
    this.busy = true;
    this.estimates = [];
    this.rebuild();
    try {
      this.estimates = await detectTempo(buf);
      this.chosen = 0;
      if (!this.estimates.length) this.ed.hud('Could not find a tempo.', 'warning');
    } catch (e) {
      this.ed.hud(`BPM detection failed: ${(e as Error).message}`, 'error');
    }
    this.busy = false;
    this.rebuild();
  }

  private apply(): void {
    const e = this.estimates[this.chosen];
    if (!e) return this.ed.hud('Run "Find BPM" first.');
    const ed = this.ed;
    ed.history.startChain();
    ed.setInitialBpm(e.bpm);
    ed.setOffset(-e.beatTime);
    ed.history.finishChain('Apply BPM estimate');
    ed.hud(`Changed BPM to ${fmtNum(e.bpm, 3)} and offset to ${(-e.beatTime).toFixed(3)}.`);
  }
}

// ------------------------------------------------------------------------------------------------

class AdjustTempoDialog extends Dialog {
  private beats = 1;
  private allCharts = false;
  private bpmInput!: HTMLInputElement;
  private stopInput!: HTMLInputElement;

  constructor(host: DialogHost) {
    super('adjustTempo', 'Adjust tempo', host, 320);
  }

  private get cursorBeat(): number {
    return this.ed.view.cursorRow / ROWS_PER_BEAT;
  }

  build(): void {
    const ed = this.ed;
    this.bpmInput = numberInput(ed.tempo.bpmAt(this.cursorBeat), (v) => ed.setSegment('bpm', this.cursorBeat, String(v)), {
      step: 0.001,
      title: 'Music tempo at the current beat',
    });
    this.stopInput = numberInput(parseFloat(ed.segmentValue('stop', this.cursorBeat) ?? '0'), (v) => ed.setSegment('stop', this.cursorBeat, v ? String(v) : null), {
      step: 0.001,
      title: 'Stop length at the current beat, in seconds',
    });
    const scaleBpm = (f: number) => () => ed.setSegment('bpm', this.cursorBeat, String(ed.tempo.bpmAt(this.cursorBeat) * f));
    this.body.append(
      field('BPM', this.bpmInput),
      row(button('Halve', scaleBpm(0.5), 'Halve the current BPM'), button('Double', scaleBpm(2), 'Double the current BPM')),
      field('Stop', this.stopInput),
      row(button('Region → stop', () => ed.regionToStop(), 'Convert the selected region to a stop')),
      section('Insert / delete beats at the cursor'),
      field('Beats', numberInput(this.beats, (v) => (this.beats = Math.abs(v)), { min: 0, step: 0.25, title: 'Number of beats to insert or remove' })),
      field('Apply to', select([['chart', 'This chart'], ['all', 'All charts']] as const, this.allCharts ? 'all' : 'chart', (v) => (this.allCharts = v === 'all'))),
      row(
        button('Insert beats', () => ed.insertBeats(this.beats, this.allCharts), 'Insert the above number of beats at the cursor position'),
        button('Delete beats', () => ed.insertBeats(-this.beats, this.allCharts), 'Notes and tempo changes in the deleted region will be removed'),
      ),
    );
  }

  refresh(): void {
    if (!this.bpmInput) return;
    setIfIdle(this.bpmInput, fmtNum(this.ed.tempo.bpmAt(this.cursorBeat), 3));
    setIfIdle(this.stopInput, this.ed.segmentValue('stop', this.cursorBeat) ?? '0');
  }
}

// ------------------------------------------------------------------------------------------------

class TempoBreakdownDialog extends Dialog {
  constructor(host: DialogHost) {
    super('tempoBreakdown', 'Tempo breakdown', host, 340);
  }

  build(): void {
    const ed = this.ed;
    const table = h('table', { class: 'chart-list' }, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Beat'), h('th', {}, 'Time'), h('th', {}, 'Value')));
    for (const seg of ed.segments()) {
      const tr = h(
        'tr',
        { title: 'Go to this tempo change' },
        h('td', {}, h('span', { class: 'swatch', style: `background:${SEGMENT_META[seg.type].color}` }), SEGMENT_META[seg.type].name),
        h('td', { class: 'num' }, fmtNum(seg.beat, 3)),
        h('td', { class: 'num' }, formatTime(ed.tempo.beatToTime(seg.beat))),
        h('td', { class: 'num' }, seg.text),
      );
      tr.addEventListener('click', () => ed.setCursorRow(Math.round(seg.beat * ROWS_PER_BEAT)));
      table.append(tr);
    }
    const bpms = ed.timing.bpms.map((b) => b.bpm);
    this.body.append(
      h('p', {}, `Offset ${ed.timing.offset.toFixed(3)} s · BPM range ${fmtNum(Math.min(...bpms), 3)}–${fmtNum(Math.max(...bpms), 3)}`),
      h('div', { class: 'scroll' }, table),
    );
  }
}

// ------------------------------------------------------------------------------------------------

export class SegmentDialog extends Dialog {
  constructor(
    host: DialogHost,
    private readonly type: SegmentType,
    private readonly beat: number,
  ) {
    super(`segment`, `${SEGMENT_META[type].name} at beat ${fmtNum(beat, 3)}`, host, 260);
  }

  build(): void {
    const ed = this.ed;
    const current = ed.segmentValue(this.type, this.beat);
    const fallback: Record<SegmentType, string> = {
      bpm: fmtNum(ed.tempo.bpmAt(this.beat), 3),
      stop: '0.5',
      delay: '0.5',
      warp: '1',
      timesig: '4/4',
      label: '',
    };
    const hints: Record<SegmentType, string> = {
      bpm: 'Beats per minute',
      stop: 'Seconds (notes on this beat are hit before the stop)',
      delay: 'Seconds (notes on this beat are hit after the delay)',
      warp: 'Length in beats',
      timesig: 'e.g. 3/4 or 7/8',
      label: 'Text',
    };
    const input = h('input', { type: 'text', value: current ?? fallback[this.type] });
    const apply = () => {
      ed.setSegment(this.type, this.beat, input.value.trim());
      this.host.closeDialog(this);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
    this.body.append(
      field('Value', input, hints[this.type]),
      h('p', { class: 'hint' }, hints[this.type]),
      row(
        button(current === null ? 'Add' : 'Apply', apply),
        current !== null
          ? button('Remove', () => {
              ed.setSegment(this.type, this.beat, null);
              this.host.closeDialog(this);
            })
          : '',
      ),
    );
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  refresh(): void {}
}

// ------------------------------------------------------------------------------------------------

class WaveformDialog extends Dialog {
  constructor(host: DialogHost) {
    super('waveform', 'Audio view', host, 300);
  }

  build(): void {
    const ed = this.ed;
    const s = ed.settings;
    const show = h('input', { type: 'checkbox', checked: s.showWaveform });
    show.addEventListener('change', () => {
      s.showWaveform = show.checked;
      ed.saveSettings();
      ed.changed();
    });
    this.body.append(
      field('Show', show),
      field(
        'Shows',
        select([['onsets', 'Onsets per band'], ['waveform', 'Waveform']] as const, s.audioView, (v) => {
          s.audioView = v;
          ed.saveSettings();
          ed.changed();
        }),
      ),
      h(
        'p',
        { class: 'hint' },
        'Onsets: a bar wherever the music has an attack, split into low (kick, bass), mid (guitars, vocals) and high (snare crack, cymbals, picking) lanes. Usually a much better guide for note placement than the waveform.',
      ),
      section('Waveform'),
      field(
        'Filter',
        select([['none', 'None'], ['lowpass', 'Low pass (kicks, bass)'], ['highpass', 'High pass (hats, snares)']] as const, s.waveFilter, (v) => {
          s.waveFilter = v;
          ed.saveSettings();
          ed.rebuildWaveform();
          ed.changed();
        }),
      ),
      field(
        'Cutoff (Hz)',
        numberInput(s.waveFilterCutoff, (v) => {
          s.waveFilterCutoff = Math.min(10000, Math.max(20, v));
          ed.saveSettings();
          ed.rebuildWaveform();
          ed.changed();
        }, { min: 20, max: 10000, step: 10 }),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------

class ShortcutsDialog extends Dialog {
  constructor(host: DialogHost) {
    super('shortcuts', 'Shortcuts', host, 420);
  }

  build(): void {
    const table = h('table', { class: 'shortcuts' });
    const add = (label: string, keys: string) => table.append(h('tr', {}, h('td', {}, label), h('td', { class: 'keys' }, keys)));
    const head = (label: string) => table.append(h('tr', {}, h('th', { colspan: 2 }, label)));
    head('Placing notes');
    add('Place / remove note', '1 – 9, 0 (column 1 – 10)');
    add('Place hold', 'Hold a number key and move the cursor');
    add('Place mine', 'Shift + number');
    add('Second half of a wide style', 'Alt + number');
    add('Record notes', 'Press number keys while the music plays');
    head('Mouse');
    add('Scroll', 'Wheel');
    add('Zoom / scale', 'Ctrl + wheel / Ctrl + Alt + wheel');
    add('Select notes', 'Drag (Shift adds, Alt removes)');
    add('Clear selection', 'Right click');
    add('Move cursor to mouse', 'Middle click');
    add('Move receptors', 'Drag the receptors');
    add('Seek', 'Click or drag the minimap');
    add('Edit tempo change', 'Click its box');
    const walk = (items: MenuEntry[], prefix: string) => {
      for (const it of items) {
        if (it === '-') continue;
        if (typeof it === 'string') {
          const a = this.host.actions.get(it);
          if (a && a.keys.length) add(`${prefix}${a.label}`, a.keys.map(displayShortcut).join(', '));
        } else {
          walk(it.items, `${prefix}${it.label} › `);
        }
      }
    };
    for (const m of MENU) {
      head(m.label);
      walk(m.items, '');
    }
    this.body.append(h('div', { class: 'scroll tall' }, table));
  }

  refresh(): void {}
}

class SectionsDialog extends Dialog {
  private copyFrom = 0;
  private copyTo = 1;
  private transform: CopyTransform = 'none';

  constructor(host: DialogHost) {
    super('sections', 'Similar sections', host, 360);
  }

  build(): void {
    const ed = this.ed;
    const sec = ed.sections;
    const status =
      sec.status === 'analyzing'
        ? 'Analyzing the music...'
        : !ed.audio.buffer
          ? 'Load the music to detect sections.'
          : `${sec.groups.length} group(s). Detection follows the chart's beat grid, so set BPM/offset first.`;
    this.body.append(
      row(button('Detect automatically', () => void sec.analyze(true), 'Find repeated sections in the music (keeps groups you made or edited)')),
      h('p', { class: 'hint' }, status),
    );

    const list = h('div', { class: 'section-list' });
    // Tree order: each section followed by the parts that repeat inside it.
    for (const { group, depth } of sec.ordered) list.append(this.groupRow(group, depth));
    if (!sec.groups.length) list.append(h('p', { class: 'hint' }, 'No groups yet.'));
    this.body.append(list);

    this.body.append(
      section('Mark by hand'),
      row(
        button('New group from selection', () => sec.newGroupFromRegion(), 'Select a region with Tab first'),
        button('Find similar to selection', () => void sec.findSimilarToRegion(), 'Rank places that sound like the selected region'),
      ),
      h('p', { class: 'hint' }, 'Tab marks a region. To add a place to the open group, move the cursor there and press Shift+A.'),
    );
    const c = sec.candidates;
    if (c) {
      const box = h('div', { class: 'candidates' }, h('div', { class: 'hint' }, `Similar to ${sec.measureLabel(c.begin)}–${sec.measureLabel(c.begin + c.length)}:`));
      for (const m of c.list) {
        const g = sec.groups.find((x) => x.id === c.groupId);
        const added = g?.starts.includes(m.start);
        box.append(
          h(
            'div',
            { class: 'occ' },
            h('span', { class: 'occ-label' }, `${sec.measureLabel(m.start)}–${sec.measureLabel(m.start + c.length)}`),
            h('span', { class: 'est-bar' }, h('span', { style: `width:${Math.round(Math.max(0, m.score) * 100)}%` })),
            button('Go', () => ed.setCursorRow(m.start)),
            added ? h('span', { class: 'hint' }, 'added') : button('Add', () => sec.addCandidate(m.start)),
          ),
        );
      }
      this.body.append(box);
    }

    const s = ed.settings;
    const check = (label: string, key: 'sectionGhosts' | 'sectionDiffs' | 'showSections' | 'sectionsInFile') => {
      const cb = h('input', { type: 'checkbox', checked: s[key] });
      cb.addEventListener('change', () => {
        s[key] = cb.checked;
        if (key === 'sectionsInFile') ed.metaDirty = true; // the next save adds or removes them
        ed.saveSettings();
        ed.changed();
      });
      return h('label', { class: 'check' }, cb, label);
    };
    this.body.append(
      section('Side views'),
      h(
        'p',
        { class: 'hint' },
        'Turn on Side views (button at the top right, Shift+V) to see the other occurrences of the section the cursor is in next to it. They follow the cursor from section to section.',
      ),
      check('Ghost notes from the other panes', 'sectionGhosts'),
      check('Flag rhythm differences (red: the music is the same there)', 'sectionDiffs'),
      check('Show section brackets beside the notes', 'showSections'),
      section('Saving'),
      check('Save groups in the simfile (a comment line the game ignores)', 'sectionsInFile'),
    );
  }

  private groupRow(g: SectionGroup, depth: number): HTMLElement {
    const ed = this.ed;
    const sec = ed.sections;
    const active = g.id === sec.activeId;
    const measures = Math.round((g.length / 192) * 4) / 4;
    const head = h(
      'div',
      { class: `group-head${active ? ' active' : ''}`, title: 'Show occurrences' },
      depth ? h('span', { class: 'tree-indent', style: `width:${depth * 14}px` }, '└') : '',
      h('span', { class: 'swatch', style: `background:${sec.colorOf(g)}` }),
      h('b', {}, sec.nameOf(g)),
      h('span', {}, ` ${measures} measures ×${g.starts.length}`),
      h('span', { class: 'hint' }, g.auto ? ` auto ${g.score?.toFixed(2) ?? ''}` : ' manual'),
      h('span', { class: 'spacer' }),
      button('×', () => sec.removeGroup(g), 'Delete this group'),
    );
    head.addEventListener('click', (e) => {
      if ((e.target as Element).closest('button')) return;
      sec.setActive(active ? null : g);
    });
    const box = h('div', { class: 'group' }, head);
    if (!active) return box;

    g.starts.forEach((start, i) => {
      box.append(
        h(
          'div',
          { class: 'occ' },
          h('span', { class: 'occ-label' }, `${i + 1}. ${sec.measureLabel(start)}–${sec.measureLabel(start + g.length)}`),
          h('span', { class: 'hint' }, `${sec.notesIn(start, g.length).length} notes`),
          h('span', { class: 'spacer' }),
          button('Go', () => ed.setCursorRow(start)),
          button('×', () => sec.removeOccurrence(g, i), 'Remove from the group'),
        ),
      );
    });
    box.append(row(button('Add cursor position', () => sec.addOccurrenceAtCursor(), 'Shift+A')));
    if (g.starts.length >= 2) {
      const n = g.starts.length;
      this.copyFrom = Math.min(this.copyFrom, n - 1);
      this.copyTo = Math.min(this.copyTo, n - 1);
      const idx = Array.from({ length: n }, (_, i) => [String(i), String(i + 1)] as [string, string]);
      box.append(
        h(
          'div',
          { class: 'dlg-row copy-row' },
          'Copy',
          select(idx, String(this.copyFrom), (v) => (this.copyFrom = +v)),
          '→',
          select(idx, String(this.copyTo), (v) => (this.copyTo = +v)),
          select(
            [['none', 'as is'], ['horizontal', 'left ↔ right'], ['vertical', 'up ↔ down'], ['both', 'mirror (both)']] as const,
            this.transform,
            (v) => (this.transform = v),
          ),
          button('Copy', () => {
            if (this.copyFrom === this.copyTo) return ed.hud('Pick two different occurrences.');
            sec.copy(g, this.copyFrom, this.copyTo, this.transform);
          }, 'Replaces the notes of the target occurrence (undoable)'),
        ),
      );
    }
    return box;
  }
}

class AboutDialog extends Dialog {
  constructor(host: DialogHost) {
    super('about', 'About', host, 320);
  }

  build(): void {
    this.body.append(
      h('p', {}, h('b', {}, 'Better Arrow Vortex'), ' — a browser chart editor for StepMania / Etterna .sm and .ssc files.'),
      h('p', {}, 'Layout, controls and shortcuts follow ArrowVortex (github.com/uvcat7/ArrowVortex).'),
      h('p', { class: 'hint' }, 'Saving in place needs Chrome or Edge (File System Access API). Other browsers download the file instead.'),
    );
  }

  refresh(): void {}
}

export function createDialog(id: DialogId, host: DialogHost): Dialog {
  switch (id) {
    case 'songProperties':
      return new SongPropertiesDialog(host);
    case 'chartProperties':
      return new ChartPropertiesDialog(host);
    case 'chartList':
      return new ChartListDialog(host);
    case 'newChart':
      return new NewChartDialog(host);
    case 'adjustSync':
      return new AdjustSyncDialog(host);
    case 'adjustTempo':
      return new AdjustTempoDialog(host);
    case 'tempoBreakdown':
      return new TempoBreakdownDialog(host);
    case 'waveform':
      return new WaveformDialog(host);
    case 'shortcuts':
      return new ShortcutsDialog(host);
    case 'sections':
      return new SectionsDialog(host);
    case 'about':
      return new AboutDialog(host);
  }
}
