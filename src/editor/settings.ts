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
  sectionGhosts: true,
  sectionDiffs: true,
  sectionsInFile: true,
  sideViews: false,
  sideDepth: 0,

  jumpToNextNote: false,
  undoRedoJump: true,

  status: Object.fromEntries(STATUS_ITEMS.map((k) => [k, k !== 'hover' && k !== 'nps'])),
};

const KEY = 'better-arrow-vortex.settings';
/** Bump when a default changes and saved values should be dropped (see MIGRATIONS). */
const VERSION = 2;
/** Settings reset to their new default when upgrading from an older version. */
const MIGRATIONS: Record<number, (keyof Settings)[]> = {
  2: ['noteskin'], // DivideByZero became the default skin
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
