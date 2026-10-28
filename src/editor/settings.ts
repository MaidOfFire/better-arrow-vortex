// User preferences, persisted in localStorage.

import type { WaveFilter } from './waveform';

export interface Settings {
  zoomLevel: number;
  scaleLevel: number;
  timeBased: boolean;
  reverse: boolean;
  receptorX: number;
  receptorY: number;
  snapType: number;
  customSnap: number;

  showWaveform: boolean;
  showNotes: boolean;
  showBeatLines: boolean;
  beatLinesSnap: boolean;
  beatLinesColor: boolean;
  beatLinesHover: boolean;
  showTempoBoxes: boolean;
  showMinimap: boolean;
  minimapMode: 'notes' | 'density';
  /** Etterna-style notes per second graph, split by chord size, in a floating window. */
  showChordGraph: boolean;
  /** Keep the graph window open while editing (and across sessions); unpinned it closes on an outside click. */
  chordGraphPinned: boolean;
  /** Graph window position, as a fraction of the room left around it (0.5, 1 = bottom centre). */
  chordGraphX: number;
  chordGraphY: number;
  /** Graph window size: width as a fraction of the editor, height in pixels. */
  chordGraphW: number;
  chordGraphH: number;
  /** An image skin id (see IMAGE_SKINS) or a built-in drawn skin. */
  noteskin: 'dividebyzero' | 'arrows' | 'bars';
  /** Solid hold/roll bodies on image skins whose own hold art is faint. */
  boldHolds: boolean;
  /** What the audio strip behind the notes shows. */
  audioView: 'onsets' | 'waveform';
  waveFilter: WaveFilter;
  waveFilterCutoff: number;

  volume: number;
  speed: number;
  beatTick: boolean;
  noteTick: boolean;

  /** Coloured brackets marking similar sections beside the notefield. */
  showSections: boolean;
  /** In compare panes: faint copies of the other occurrences' notes. */
  sectionGhosts: boolean;
  /** In compare panes: marks rows whose rhythm differs from the other occurrences. */
  sectionDiffs: boolean;
  /** Show the other occurrences of the current section next to the notefield. */
  sideViews: boolean;
  /** Which level of nested sections the side views follow (0 = whole sections). */
  sideDepth: number;
  /** Write section groups into the simfile as a comment line when saving. */
  sectionsInFile: boolean;
  /** How much automatic detection finds: 1 = only the clearest big sections … 5 = everything. */
  sectionDetail: number;
  /** BPM detection in Adjust sync: the built-in onset analysis, or the Beat This! neural beat tracker. */
  tempoDetector: 'classic' | 'beatThis';
  /** Sync map window: shown, pinned, place and size (as the NPS graph's). */
  showSyncMap: boolean;
  syncMapPinned: boolean;
  syncMapX: number;
  syncMapY: number;
  syncMapW: number;
  syncMapH: number;

  jumpToNextNote: boolean;
  undoRedoJump: boolean;

  status: Record<string, boolean>;
}

export const STATUS_ITEMS = ['chart', 'snap', 'bpm', 'row', 'beat', 'measure', 'time', 'section', 'hover', 'speed', 'nps'] as const;

const DEFAULTS: Settings = {
  zoomLevel: 8,
  scaleLevel: 4,
  timeBased: true,
  reverse: false,
  receptorX: 0,
  receptorY: 192,
  snapType: 4,
  customSnap: 20,

  showWaveform: true,
  showNotes: true,
  showBeatLines: true,
  beatLinesSnap: false,
  beatLinesColor: false,
  beatLinesHover: false,
  showTempoBoxes: true,
  showMinimap: true,
  minimapMode: 'notes',
  showChordGraph: false,
  chordGraphPinned: false,
  chordGraphX: 0.5,
  chordGraphY: 1,
  chordGraphW: 0.5,
  chordGraphH: 124,
  noteskin: 'dividebyzero',
  boldHolds: true,
  audioView: 'onsets',
  waveFilter: 'none',
  waveFilterCutoff: 200,

  volume: 1,
  speed: 1,
  beatTick: false,
  noteTick: false,

  showSections: true,
  sectionGhosts: false,
  sectionDiffs: true,
  sectionsInFile: true,
  sectionDetail: 4,
  tempoDetector: 'classic',
  showSyncMap: false,
  syncMapPinned: false,
  syncMapX: 0.5,
  syncMapY: 0.5,
  syncMapW: 0.5,
  syncMapH: 220,
  sideViews: false,
  sideDepth: 0,

  jumpToNextNote: false,
  undoRedoJump: true,

  status: Object.fromEntries(STATUS_ITEMS.map((k) => [k, k !== 'hover' && k !== 'nps'])),
};

const KEY = 'better-arrow-vortex.settings';
/** Bump when a default changes and saved values should be dropped (see MIGRATIONS). */
const VERSION = 3;
/** Settings reset to their new default when upgrading from an older version. */
const MIGRATIONS: Record<number, (keyof Settings)[]> = {
  2: ['noteskin'], // DivideByZero became the default skin
  3: ['sectionGhosts'], // ghost notes became opt-in
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings> & { version?: number };
      for (let v = (saved.version ?? 1) + 1; v <= VERSION; ++v) for (const k of MIGRATIONS[v] ?? []) delete saved[k];
      return { ...DEFAULTS, ...saved, status: { ...DEFAULTS.status, ...(saved.status ?? {}) } };
    }
  } catch {
    // storage unavailable or corrupt: fall back to defaults
  }
  return structuredClone(DEFAULTS);
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, version: VERSION }));
  } catch {
    // storage unavailable
  }
}
