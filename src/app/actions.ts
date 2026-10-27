// Every command in the editor, its default shortcuts and its place in the menu bar.
// Add new functionality by registering an action here; the menu, keyboard handler and the
// shortcuts dialog all read from this table.

import { QUANT_NAMES } from '../model/notes';
import type { Editor, SegmentType } from '../editor/editor';
import { ROWS_PER_BEAT, ROWS_PER_MEASURE } from '../model/types';

export type DialogId =
  | 'songProperties'
  | 'chartProperties'
  | 'chartList'
  | 'newChart'
  | 'adjustSync'
  | 'adjustTempo'
  | 'tempoBreakdown'
  | 'waveform'
  | 'shortcuts'
  | 'sections'
  | 'about';

export interface ActionHost {
  editor: Editor;
  openDialog(id: DialogId): void;
  editSegmentAtCursor(type: SegmentType): void;
  openSimfile(): Promise<void>;
  openFilesFallback(): Promise<void>;
  loadMusic(): Promise<void>;
  closeSimfile(): void;
  setCustomSnap(): void;
}

export interface Action {
  id: string;
  label: string;
  keys: string[];
  run: () => void;
  checked?: () => boolean;
  enabled?: () => boolean;
  /** Repeats while the key is held (cursor movement). */
  repeat?: boolean;
}

export type MenuEntry = string | '-' | { label: string; items: MenuEntry[] };

export function createActions(host: ActionHost): Map<string, Action> {
  const ed = host.editor;
  const v = ed.view;
  const s = ed.settings;
  const actions = new Map<string, Action>();
  const add = (id: string, label: string, keys: string[], run: () => void, extra: Partial<Action> = {}) =>
    actions.set(id, { id, label, keys, run, ...extra });
  const hasSim = () => ed.isOpen;
  const hasChart = () => ed.chart !== null;
  const toggle = (key: keyof typeof s, label: string) => () => {
    (s as unknown as Record<string, boolean>)[key as string] = !s[key];
    ed.hud(`${label}: ${s[key] ? 'on' : 'off'}`);
    ed.saveSettings();
    ed.changed();
  };
  const chartOnly = { enabled: hasChart };

  // File.
  add('file.open', 'Open...', ['ctrl+o'], () => void host.openSimfile());
  add('file.openFiles', 'Open files...', [], () => void host.openFilesFallback());
  add('file.close', 'Close', [], () => host.closeSimfile(), { enabled: hasSim });
  add('file.save', 'Save', ['ctrl+s'], () => void ed.save(false), { enabled: hasSim });
  add('file.saveAs', 'Save as...', ['ctrl+shift+s'], () => void ed.save(true), { enabled: hasSim });
  add('file.properties', 'Properties...', ['shift+p'], () => host.openDialog('songProperties'), { enabled: hasSim });

  // Edit.
  add('edit.undo', 'Undo', ['ctrl+z'], () => ed.undo(), { enabled: () => ed.history.canUndo, repeat: true });
  add('edit.redo', 'Redo', ['ctrl+y', 'ctrl+shift+z'], () => ed.redo(), { enabled: () => ed.history.canRedo, repeat: true });
  add('edit.cut', 'Cut', ['ctrl+x'], () => ed.copy(true), chartOnly);
  add('edit.copy', 'Copy', ['ctrl+c'], () => ed.copy(false), chartOnly);
  add('edit.paste', 'Paste', ['ctrl+v'], () => ed.paste(false), chartOnly);
  add('edit.pasteInsert', 'Insert paste', ['ctrl+shift+v'], () => ed.paste(true), chartOnly);
  add('edit.delete', 'Delete', ['delete', 'backspace'], () => ed.deleteSelection(), { enabled: hasSim });
  add('edit.selectAll', 'Select all', ['ctrl+a'], () => ed.selectAll(), chartOnly);
  add('edit.selectAllTempo', 'Select all tempo changes', ['ctrl+alt+a'], () => ed.selectAllSegments(), { enabled: hasSim });
  add('edit.selectRegion', 'Select region', ['tab'], () => ed.toggleRegionSelect(), { enabled: hasSim });
  add('edit.clearSelection', 'Clear selection', ['escape'], () => {
    ed.placing.clear();
    ed.clearSelection();
    ed.sections.focusMain(); // back to the main notefield when editing a side view
  });
  add('edit.jumpToNext', 'Enable jump to next note', [], toggle('jumpToNextNote', 'Jump to next note'), { checked: () => s.jumpToNextNote });
  add('edit.undoJump', 'Enable undo/redo jump', [], toggle('undoRedoJump', 'Undo/redo jump'), { checked: () => s.undoRedoJump });

  // Chart.
  add('chart.list', 'Chart list...', ['shift+l'], () => host.openDialog('chartList'), { enabled: hasSim });
  add('chart.properties', 'Properties...', ['shift+c'], () => host.openDialog('chartProperties'), chartOnly);
  add('chart.new', 'New chart...', ['shift+n'], () => host.openDialog('newChart'), { enabled: hasSim });
  add('chart.prev', 'Previous chart', ['f5'], () => ed.nextChart(-1), { enabled: hasSim });
  add('chart.next', 'Next chart', ['f6'], () => ed.nextChart(1), { enabled: hasSim });
  add('chart.delete', 'Delete chart', ['ctrl+delete'], () => {
    if (confirm(`Delete chart "${ed.chartName()}"? (This can be undone.)`)) ed.deleteChart();
  }, chartOnly);

  // Notes.
  QUANT_NAMES.forEach((name, q) => add(`notes.selectQuant${q}`, name, [], () => ed.selectQuant(q), chartOnly));
  add('notes.selectSteps', 'Steps', [], () => ed.selectWhere((n) => n.type === 'tap' || n.type === 'lift', 'step'), chartOnly);
  add('notes.selectJumps', 'Jumps', [], () => {
    const counts = new Map<number, number>();
    for (const n of ed.notes) if (n.type !== 'mine' && n.type !== 'fake') counts.set(n.row, (counts.get(n.row) ?? 0) + 1);
    ed.selectWhere((n) => n.type !== 'mine' && n.type !== 'fake' && (counts.get(n.row) ?? 0) >= 2, 'jump note');
  }, chartOnly);
  add('notes.selectMines', 'Mines', [], () => ed.selectWhere((n) => n.type === 'mine', 'mine'), chartOnly);
  add('notes.selectHolds', 'Holds', [], () => ed.selectWhere((n) => n.type === 'hold' && n.endRow > n.row, 'hold'), chartOnly);
  add('notes.selectRolls', 'Rolls', [], () => ed.selectWhere((n) => n.type === 'roll', 'roll'), chartOnly);
  add('notes.selectFakes', 'Fakes', [], () => ed.selectWhere((n) => n.type === 'fake', 'fake'), chartOnly);
  add('notes.selectLifts', 'Lifts', [], () => ed.selectWhere((n) => n.type === 'lift', 'lift'), chartOnly);
  add('notes.selectBefore', 'Before cursor', ['shift+home'], () => ed.selectBeforeCursor(), chartOnly);
  add('notes.selectAfter', 'After cursor', ['shift+end'], () => ed.selectAfterCursor(), chartOnly);

  add('notes.toMines', 'Notes → Mines', [], () => ed.convertNotes('tap', 'mine'), chartOnly);
  add('notes.toFakes', 'Notes → Fakes', [], () => ed.convertNotes('tap', 'fake'), chartOnly);
  add('notes.toLifts', 'Notes → Lifts', [], () => ed.convertNotes('tap', 'lift'), chartOnly);
  add('notes.minesToNotes', 'Mines → Notes', [], () => ed.convertNotes('mine', 'tap'), chartOnly);
  add('notes.minesToFakes', 'Mines → Fakes', [], () => ed.convertNotes('mine', 'fake'), chartOnly);
  add('notes.fakesToNotes', 'Fakes → Notes', [], () => ed.convertNotes('fake', 'tap'), chartOnly);
  add('notes.liftsToNotes', 'Lifts → Notes', [], () => ed.convertNotes('lift', 'tap'), chartOnly);
  add('notes.holdsRolls', 'Holds ↔ Rolls', ['`'], () => ed.toggleHoldsRolls(), chartOnly);
  add('notes.holdsToSteps', 'Holds → Steps', [], () => ed.convertNotes('holdroll', 'tap'), chartOnly);
  add('notes.holdsToMines', 'Holds → Mines', [], () => ed.convertNotes('holdroll', 'mine'), chartOnly);

  add('notes.mirrorH', 'Horizontally', ['y'], () => ed.mirror('horizontal'), chartOnly);
  add('notes.mirrorV', 'Vertically', ['t'], () => ed.mirror('vertical'), chartOnly);
  add('notes.mirrorBoth', 'Both', ['g'], () => ed.mirror('both'), chartOnly);
  add('notes.expand21', '2:1 (8th to 4th)', [], () => ed.scaleNotes(2, 1), chartOnly);
  add('notes.expand32', '3:2 (12th to 8th)', [], () => ed.scaleNotes(3, 2), chartOnly);
  add('notes.expand43', '4:3 (16th to 12th)', [], () => ed.scaleNotes(4, 3), chartOnly);
  add('notes.compress12', '1:2 (4th to 8th)', [], () => ed.scaleNotes(1, 2), chartOnly);
  add('notes.compress23', '2:3 (8th to 12th)', [], () => ed.scaleNotes(2, 3), chartOnly);
  add('notes.compress34', '3:4 (12th to 16th)', [], () => ed.scaleNotes(3, 4), chartOnly);
  add('notes.requantize', 'Requantize to snap', ['ctrl+r'], () => ed.requantize(), chartOnly);

  // Tempo.
  const seg = (type: SegmentType) => () => host.editSegmentAtCursor(type);
  add('tempo.bpm', 'BPM at cursor...', ['ctrl+alt+q'], seg('bpm'), { enabled: hasSim });
  add('tempo.stop', 'Stop at cursor...', ['ctrl+alt+w'], seg('stop'), { enabled: hasSim });
  add('tempo.delay', 'Delay at cursor...', ['ctrl+alt+e'], seg('delay'), { enabled: hasSim });
  add('tempo.warp', 'Warp at cursor...', ['ctrl+alt+r'], seg('warp'), { enabled: hasSim });
  add('tempo.timesig', 'Time signature at cursor...', ['ctrl+alt+t'], seg('timesig'), { enabled: hasSim });
  add('tempo.label', 'Label at cursor...', ['ctrl+alt+['], seg('label'), { enabled: hasSim });
  add('tempo.adjustSync', 'Adjust sync...', ['shift+s'], () => host.openDialog('adjustSync'), { enabled: hasSim });
  add('tempo.adjustTempo', 'Adjust tempo...', ['shift+t'], () => host.openDialog('adjustTempo'), { enabled: hasSim });
  add('tempo.breakdown', 'Breakdown...', ['shift+b'], () => host.openDialog('tempoBreakdown'), { enabled: hasSim });

  // Sections.
  const sec = ed.sections;
  const hasMusic = () => ed.audio.buffer !== null;
  add('sections.dialog', 'Similar sections...', ['shift+m'], () => host.openDialog('sections'), { enabled: hasSim });
  add('sections.detect', 'Detect automatically', [], () => void sec.analyze(true), { enabled: hasMusic });
  add('sections.fromRegion', 'New group from selection', [], () => {
    sec.newGroupFromRegion();
    host.openDialog('sections');
  }, { enabled: () => ed.region !== null });
  add('sections.addCursor', 'Add cursor position to group', ['shift+a'], () => sec.addOccurrenceAtCursor(), { enabled: () => sec.active !== null });
  add('sections.findSimilar', 'Find similar to selection', [], () => {
    host.openDialog('sections');
    void sec.findSimilarToRegion();
  }, { enabled: () => ed.region !== null && hasMusic() });
  const hasSideViews = () => (sec.panes()?.length ?? 0) > 1;
  add('sections.compare', 'Side views', ['shift+v'], () => sec.toggleSideViews(), { enabled: hasSim, checked: () => sec.sideViewsOn });
  add('sections.prevPane', 'Edit the pane to the left', ['['], () => sec.focusNext(-1), { enabled: hasSideViews });
  add('sections.nextPane', 'Edit the pane to the right', [']'], () => sec.focusNext(1), { enabled: hasSideViews });
  add('sections.ghosts', 'Ghost notes from other panes', [], toggle('sectionGhosts', 'Ghost notes'), { checked: () => s.sectionGhosts });
  add('sections.diffs', 'Flag rhythm differences', [], toggle('sectionDiffs', 'Rhythm differences'), { checked: () => s.sectionDiffs });
  add('sections.show', 'Show section brackets', [], toggle('showSections', 'Section brackets'), { checked: () => s.showSections });
  add('sections.inFile', 'Save sections in the simfile', [], () => {
    s.sectionsInFile = !s.sectionsInFile;
    ed.metaDirty = true; // the next save adds or removes them
    ed.hud(s.sectionsInFile ? 'Sections will be saved in the simfile as a comment line.' : 'Sections will not be saved in the simfile.');
    ed.saveSettings();
    ed.changed();
  }, { checked: () => s.sectionsInFile });

  // Audio.
  add('audio.load', 'Load music...', [], () => void host.loadMusic(), { enabled: hasSim });
  add('audio.play', 'Play / pause', ['space'], () => ed.togglePlay(), { enabled: hasSim });
  add('audio.volumeReset', 'Default', [], () => ed.setVolume(1));
  add('audio.volumeUp', 'Louder', ['shift+up'], () => ed.setVolume(ed.audio.volume + 0.1), { repeat: true });
  add('audio.volumeDown', 'Softer', ['shift+down'], () => ed.setVolume(ed.audio.volume - 0.1), { repeat: true });
  add('audio.mute', 'Mute', [], () => {
    ed.audio.setMuted(!ed.audio.muted);
    ed.hud(ed.audio.muted ? 'Muted' : 'Unmuted');
    ed.changed();
  }, { checked: () => ed.audio.muted });
  add('audio.speedReset', 'Default', [], () => ed.setSpeed(1));
  add('audio.speedUp', 'Faster by 10%', ['shift+right'], () => ed.setSpeed(ed.audio.speed + 0.1), { repeat: true });
  add('audio.speedDown', 'Slower by 10%', ['shift+left'], () => ed.setSpeed(ed.audio.speed - 0.1), { repeat: true });
  add('audio.speedUpFine', 'Faster by 1%', ['ctrl+shift+right'], () => ed.setSpeed(ed.audio.speed + 0.01), { repeat: true });
  add('audio.speedDownFine', 'Slower by 1%', ['ctrl+shift+left'], () => ed.setSpeed(ed.audio.speed - 0.01), { repeat: true });
  add('audio.beatTick', 'Beat tick', ['f3'], toggle('beatTick', 'Beat tick'), { checked: () => s.beatTick });
  add('audio.noteTick', 'Note tick', ['f4'], toggle('noteTick', 'Note tick'), { checked: () => s.noteTick });

  // View.
  const viewChanged = (msg?: string) => {
    if (msg) ed.hud(msg);
    ed.saveSettings();
    ed.changed();
  };
  add('view.waveform', 'Show audio', [], toggle('showWaveform', 'Audio view'), { checked: () => s.showWaveform });
  add('view.audioOnsets', 'Onsets (low / mid / high)', [], () => {
    s.audioView = 'onsets';
    s.showWaveform = true;
    viewChanged('Audio view: onsets per band');
  }, { checked: () => s.audioView === 'onsets' });
  add('view.audioWaveform', 'Waveform', [], () => {
    s.audioView = 'waveform';
    s.showWaveform = true;
    viewChanged('Audio view: waveform');
  }, { checked: () => s.audioView === 'waveform' });
  add('view.tempoBoxes', 'Show tempo boxes', [], toggle('showTempoBoxes', 'Tempo boxes'), { checked: () => s.showTempoBoxes });
  add('view.notes', 'Show notes', [], toggle('showNotes', 'Notes'), { checked: () => s.showNotes });
  add('view.minimap', 'Show minimap', [], toggle('showMinimap', 'Minimap'), { checked: () => s.showMinimap });
  add('view.reverse', 'Reverse scroll', [], () => {
    v.reverse = !v.reverse;
    viewChanged(`Reverse scroll: ${v.reverse ? 'on' : 'off'}`);
  }, { checked: () => v.reverse });
  add('view.timeBased', 'Time based (C-mod)', [], () => {
    v.timeBased = true;
    viewChanged('Time based view');
  }, { checked: () => v.timeBased });
  add('view.rowBased', 'Row based (X-mod)', [], () => {
    v.timeBased = false;
    viewChanged('Row based view');
  }, { checked: () => !v.timeBased });
  add('view.waveformSettings', 'Settings...', ['shift+w'], () => host.openDialog('waveform'));
  add('view.skinDbz', 'DivideByZero', [], () => {
    s.noteskin = 'dividebyzero';
    viewChanged();
  }, { checked: () => s.noteskin === 'dividebyzero' });
  add('view.boldHolds', 'Bold hold bodies', [], toggle('boldHolds', 'Bold hold bodies'), { checked: () => s.boldHolds });
  add('view.skinArrows', 'Arrows (built-in)', [], () => {
    s.noteskin = 'arrows';
    viewChanged();
  }, { checked: () => s.noteskin === 'arrows' });
  add('view.skinBars', 'Bars (built-in)', [], () => {
    s.noteskin = 'bars';
    viewChanged();
  }, { checked: () => s.noteskin === 'bars' });
  add('view.beatlines', 'Enabled', [], toggle('showBeatLines', 'Beat lines'), { checked: () => s.showBeatLines });
  add('view.beatlinesSnap', 'Use current snap', [], toggle('beatLinesSnap', 'Snap beat lines'), { checked: () => s.beatLinesSnap });
  add('view.beatlinesColor', 'Use snap colors', [], toggle('beatLinesColor', 'Coloured beat lines'), { checked: () => s.beatLinesColor });
  add('view.beatlinesHover', 'Highlight mouse position', [], toggle('beatLinesHover', 'Hover line'), { checked: () => s.beatLinesHover });
  add('view.minimapNotes', 'Notes', [], () => {
    s.minimapMode = 'notes';
    viewChanged();
  }, { checked: () => s.minimapMode === 'notes' });
  add('view.minimapDensity', 'Density', [], () => {
    s.minimapMode = 'density';
    viewChanged();
  }, { checked: () => s.minimapMode === 'density' });
  add('view.zoomReset', 'Reset', [], () => {
    v.setZoom(8);
    v.setScale(4);
    viewChanged('Zoom reset');
  });
  add('view.zoomIn', 'Zoom in', ['numadd', '='], () => {
    v.setZoom(v.zoomLevel + 0.25);
    viewChanged();
  }, { repeat: true });
  add('view.zoomOut', 'Zoom out', ['numsub', '-'], () => {
    v.setZoom(v.zoomLevel - 0.25);
    viewChanged();
  }, { repeat: true });
  add('view.scaleUp', 'Scale increase', ['ctrl+numadd', 'ctrl+alt+='], () => {
    v.setScale(v.scaleLevel + 0.25);
    viewChanged();
  }, { repeat: true });
  add('view.scaleDown', 'Scale decrease', ['ctrl+numsub', 'ctrl+alt+-'], () => {
    v.setScale(v.scaleLevel - 0.25);
    viewChanged();
  }, { repeat: true });
  add('view.snapReset', 'Reset', [], () => {
    v.setSnapType(0);
    viewChanged(`Snap: ${v.snapName}`);
  });
  add('view.snapNext', 'Next', ['right'], () => {
    v.setSnapType(v.snapType + 1);
    viewChanged(`Snap: ${v.snapName}`);
  }, { repeat: true });
  add('view.snapPrev', 'Previous', ['left'], () => {
    v.setSnapType(v.snapType - 1);
    viewChanged(`Snap: ${v.snapName}`);
  }, { repeat: true });
  add('view.snapCustom', 'Set snap...', [], () => host.setCustomSnap());
  add('cursor.up', 'Up', ['up'], () => ed.moveCursorSnap('up'), { repeat: true });
  add('cursor.down', 'Down', ['down'], () => ed.moveCursorSnap('down'), { repeat: true });
  add('cursor.prevBeat', 'Previous beat', ['shift+pageup'], () => ed.moveCursorInterval(-ROWS_PER_BEAT), { repeat: true });
  add('cursor.nextBeat', 'Next beat', ['shift+pagedown'], () => ed.moveCursorInterval(ROWS_PER_BEAT), { repeat: true });
  add('cursor.prevMeasure', 'Previous measure', ['pageup'], () => ed.moveCursorInterval(-ROWS_PER_MEASURE), { repeat: true });
  add('cursor.nextMeasure', 'Next measure', ['pagedown'], () => ed.moveCursorInterval(ROWS_PER_MEASURE), { repeat: true });
  add('cursor.streamStart', 'Stream start', ['ctrl+up'], () => ed.moveCursorToStream(true), { repeat: true });
  add('cursor.streamEnd', 'Stream end', ['ctrl+down'], () => ed.moveCursorToStream(false), { repeat: true });
  add('cursor.selStart', 'Selection start', ['ctrl+home'], () => ed.moveCursorToSelection(true));
  add('cursor.selEnd', 'Selection end', ['ctrl+end'], () => ed.moveCursorToSelection(false));
  add('cursor.chartStart', 'First beat', ['home'], () => ed.moveCursorToChartEdge(true));
  add('cursor.chartEnd', 'Last beat', ['end'], () => ed.moveCursorToChartEdge(false));
  for (const item of ['chart', 'snap', 'bpm', 'row', 'beat', 'measure', 'time', 'section', 'hover', 'speed', 'nps']) {
    add(`status.${item}`, `Show ${item === 'nps' ? 'NPS' : item === 'bpm' ? 'BPM' : item}`, [], () => {
      s.status[item] = !s.status[item];
      viewChanged();
    }, { checked: () => !!s.status[item] });
  }

  // Help.
  add('help.shortcuts', 'Shortcuts...', ['f1'], () => host.openDialog('shortcuts'));
  add('help.about', 'About...', [], () => host.openDialog('about'));

  return actions;
}

export const MENU: { label: string; items: MenuEntry[] }[] = [
  {
    label: 'File',
    items: ['file.open', 'file.openFiles', 'file.close', '-', 'file.save', 'file.saveAs', '-', 'file.properties'],
  },
  {
    label: 'Edit',
    items: [
      'edit.undo',
      'edit.redo',
      '-',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.pasteInsert',
      'edit.delete',
      '-',
      'edit.selectAll',
      'edit.selectAllTempo',
      'edit.selectRegion',
      'edit.clearSelection',
      '-',
      'edit.jumpToNext',
      'edit.undoJump',
    ],
  },
  {
    label: 'Chart',
    items: ['chart.list', 'chart.properties', '-', 'chart.new', '-', 'chart.prev', 'chart.next', '-', 'chart.delete'],
  },
  {
    label: 'Notes',
    items: [
      {
        label: 'Select',
        items: [
          { label: 'Quantization', items: QUANT_NAMES.map((_, q) => `notes.selectQuant${q}`) },
          '-',
          'notes.selectSteps',
          'notes.selectJumps',
          'notes.selectMines',
          'notes.selectHolds',
          'notes.selectRolls',
          'notes.selectFakes',
          'notes.selectLifts',
          '-',
          'notes.selectBefore',
          'notes.selectAfter',
        ],
      },
      {
        label: 'Convert',
        items: [
          'notes.toMines',
          'notes.toFakes',
          'notes.toLifts',
          '-',
          'notes.minesToNotes',
          'notes.minesToFakes',
          '-',
          'notes.fakesToNotes',
          'notes.liftsToNotes',
          '-',
          'notes.holdsRolls',
          'notes.holdsToSteps',
          'notes.holdsToMines',
        ],
      },
      { label: 'Mirror', items: ['notes.mirrorH', 'notes.mirrorV', 'notes.mirrorBoth'] },
      { label: 'Expand', items: ['notes.expand21', 'notes.expand32', 'notes.expand43'] },
      { label: 'Compress', items: ['notes.compress12', 'notes.compress23', 'notes.compress34'] },
      'notes.requantize',
    ],
  },
  {
    label: 'Tempo',
    items: [
      'tempo.bpm',
      'tempo.stop',
      'tempo.delay',
      'tempo.warp',
      'tempo.timesig',
      'tempo.label',
      '-',
      'tempo.adjustSync',
      'tempo.adjustTempo',
      '-',
      'tempo.breakdown',
    ],
  },
  {
    label: 'Sections',
    items: [
      'sections.dialog',
      '-',
      'sections.detect',
      'sections.fromRegion',
      'sections.findSimilar',
      'sections.addCursor',
      '-',
      'sections.compare',
      'sections.prevPane',
      'sections.nextPane',
      '-',
      'sections.ghosts',
      'sections.diffs',
      'sections.show',
      '-',
      'sections.inFile',
    ],
  },
  {
    label: 'Audio',
    items: [
      'audio.load',
      'audio.play',
      '-',
      { label: 'Volume', items: ['audio.volumeReset', '-', 'audio.volumeUp', 'audio.volumeDown', '-', 'audio.mute'] },
      {
        label: 'Speed',
        items: ['audio.speedReset', '-', 'audio.speedUp', 'audio.speedDown', '-', 'audio.speedUpFine', 'audio.speedDownFine'],
      },
      '-',
      'audio.beatTick',
      'audio.noteTick',
    ],
  },
  {
    label: 'View',
    items: [
      'view.waveform',
      'view.tempoBoxes',
      'view.notes',
      'view.minimap',
      '-',
      'view.reverse',
      '-',
      'view.timeBased',
      'view.rowBased',
      '-',
      { label: 'Audio view', items: ['view.audioOnsets', 'view.audioWaveform', '-', 'view.waveformSettings'] },
      { label: 'Noteskin', items: ['view.skinDbz', '-', 'view.skinArrows', 'view.skinBars', '-', 'view.boldHolds'] },
      { label: 'Beatlines', items: ['view.beatlines', '-', 'view.beatlinesSnap', 'view.beatlinesColor', 'view.beatlinesHover'] },
      { label: 'Minimap', items: ['view.minimapNotes', 'view.minimapDensity'] },
      { label: 'Zoom', items: ['view.zoomReset', '-', 'view.zoomIn', 'view.zoomOut', 'view.scaleUp', 'view.scaleDown'] },
      { label: 'Snap', items: ['view.snapReset', '-', 'view.snapCustom', 'view.snapPrev', 'view.snapNext'] },
      {
        label: 'Cursor',
        items: [
          'cursor.up',
          'cursor.down',
          '-',
          'cursor.prevBeat',
          'cursor.nextBeat',
          'cursor.prevMeasure',
          'cursor.nextMeasure',
          '-',
          'cursor.streamStart',
          'cursor.streamEnd',
          '-',
          'cursor.selStart',
          'cursor.selEnd',
          '-',
          'cursor.chartStart',
          'cursor.chartEnd',
        ],
      },
      {
        label: 'Status',
        items: ['chart', 'snap', 'bpm', 'row', 'beat', 'measure', 'time', 'section', 'hover', 'speed', 'nps'].map((k) => `status.${k}`),
      },
    ],
  },
  { label: 'Help', items: ['help.shortcuts', 'help.about'] },
];

// ------------------------------------------------------------------------------------------------
// Keyboard shortcut strings.

const CODE_NAMES: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Home: 'home',
  End: 'end',
  Delete: 'delete',
  Backspace: 'backspace',
  Insert: 'insert',
  Tab: 'tab',
  Escape: 'escape',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Space: 'space',
  Backquote: '`',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummul',
  NumpadDivide: 'numdiv',
};

export function keyName(e: KeyboardEvent): string {
  const c = e.code;
  if (c.startsWith('Key')) return c.slice(3).toLowerCase();
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Numpad') && /\d$/.test(c)) return `num${c.slice(6)}`;
  if (/^F\d+$/.test(c)) return c.toLowerCase();
  return CODE_NAMES[c] ?? c.toLowerCase();
}

export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(keyName(e));
  return parts.join('+');
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

export function displayShortcut(sc: string): string {
  return sc
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return IS_MAC ? '⌘' : 'Ctrl';
      if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
      if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (p === 'numadd') return 'Num+';
      if (p === 'numsub') return 'Num−';
      if (p.startsWith('num')) return `Num${p.slice(3)}`;
      if (p === 'pageup') return 'PgUp';
      if (p === 'pagedown') return 'PgDn';
      return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    })
    .join(IS_MAC ? '' : '+');
}
