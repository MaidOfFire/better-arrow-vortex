// Bottom status line: chart, snap, BPM, cursor position, ...

import { fmtNum, formatTime, type Editor } from '../editor/editor';
import { ROWS_PER_BEAT } from '../model/types';
import { h } from './dom';

export class Statusbar {
  readonly el = h('div', { class: 'statusbar' });
  private last = '';
  private statsFor: unknown[] = [];
  private npsText = '';

  constructor(private readonly editor: Editor) {}

  update(): void {
    const ed = this.editor;
    const v = ed.view;
    const st = ed.settings.status;
    const parts: [string, string][] = [];
    if (ed.isOpen) {
      if (st.chart) parts.push(['Chart', ed.chartName()]);
      if (st.snap) parts.push(['Snap', v.snapName]);
      if (st.bpm) parts.push(['BPM', fmtNum(ed.tempo.bpmAt(v.cursorBeat), 3)]);
      if (st.row) parts.push(['Row', String(v.cursorRow)]);
      if (st.beat) parts.push(['Beat', v.cursorBeat.toFixed(3)]);
      if (st.measure) parts.push(['Measure', ed.tempo.beatToMeasure(v.cursorBeat).toFixed(3)]);
      if (st.time) parts.push(['Time', formatTime(v.cursorTime)]);
      if (st.section) {
        const sec = ed.sections;
        const path = sec.pathAt(v.cursorRow);
        if (path.length) parts.push(['Section', path.map((g) => `${sec.nameOf(g)}${sec.occurrenceAt(g, v.cursorRow) + 1}`).join(' › ')]);
      }
      if (st.hover && v.hoverRow >= 0) {
        parts.push(['Mouse', `row ${v.hoverRow}, beat ${(v.hoverRow / ROWS_PER_BEAT).toFixed(3)}`]);
      }
      if (st.speed) parts.push(['Speed', `${Math.round(ed.audio.speed * 100)}%`]);
      if (st.nps && ed.chart) {
        if (this.statsFor[0] !== ed.notes || this.statsFor[1] !== ed.tempo) {
          this.statsFor = [ed.notes, ed.tempo];
          const s = ed.noteStats();
          this.npsText = `${s.avgNps.toFixed(2)} avg / ${s.peakNps} peak`;
        }
        parts.push(['NPS', this.npsText]);
      }
      if (ed.audio.playing) parts.push(['', '▶ playing']);
    } else {
      parts.push(['', 'Open a simfile folder (Ctrl+O) or drop a simfile/music file here.']);
    }
    const key = JSON.stringify(parts);
    if (key === this.last) return;
    this.last = key;
    this.el.replaceChildren(
      ...parts.map(([k, val]) => h('span', { class: 'status-item' }, k ? h('span', { class: 'status-key' }, `${k}: `) : null, val)),
    );
  }
}
