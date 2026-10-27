# Better Arrow Vortex

Better Arrow Vortex is a browser-based StepMania / Etterna chart editor for `.sm` and `.ssc` files, modelled on
[ArrowVortex](https://github.com/uvcat7/ArrowVortex): same layout, controls and default shortcuts.
TypeScript + Canvas 2D + Web Audio, no framework, built with Vite.

Live: **https://maidoffire.github.io/better-arrow-vortex/**

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (parser, timing, editing, BPM detection)
npm run build      # static site in dist/ (host anywhere, e.g. GitHub Pages)
```

Every push to `main` builds, tests and publishes the site to GitHub Pages
(`.github/workflows/deploy.yml`).

Use Chrome or Edge to save files in place (File System Access API): **File > Open** asks for the
song folder, and **Save** writes the `.sm` back into it. Other browsers can open files with
**File > Open files...** (pick the `.sm` and the music together) and save by downloading.
You can also drag a song folder or files onto the window, or click **Try a demo chart**.

## What works

- `.sm` / `.ssc` load and save, including BPMs, stops, delays, warps (written as negative BPMs in
  `.sm`), time signatures, labels; other tags are kept as they were.
- Notefield in time-based (C-mod) or row-based (X-mod) view, drawn with the DivideByZero noteskin
  by default (View > Noteskin also has built-in drawn arrows and bars), holds, rolls, mines, lifts, fakes,
  an onset strip beside the notes (attack strength in low / mid / high bands; View > Audio view
  can switch back to the ArrowVortex waveform), beat lines,
  measure numbers, stop/delay/warp shading, tempo boxes and a minimap (notes or density).
- Placing notes ArrowVortex-style: number keys place/remove, hold the key and move for holds,
  Shift for mines, Alt for the right half of wide styles, record live while playing.
- Selection by drag box (Shift adds, Alt removes), region select (Tab), select by type or
  quantization; cut/copy/paste/insert-paste, delete, mirror, expand/compress, requantize, note-type
  conversions, holds ↔ rolls; unlimited undo/redo.
- Tempo editing at the cursor (Ctrl+Alt+Q/W/E/R/T/[), clickable tempo boxes, Adjust Sync (offset,
  initial BPM, move first beat, automatic BPM + offset detection), Adjust Tempo (halve/double,
  insert/delete beats, region to stop), tempo breakdown.
- Similar sections (Sections menu, Shift+M): repeated parts of the song are detected from the
  audio on the chart's beat grid when the music loads (harmony + timbre + onset rhythm per beat),
  at three scales so that repeats nest: whole sections, the parts that repeat inside them (e.g. a
  chorus phrase) and smaller figures. The nesting follows from which occurrences contain which,
  also for groups marked by hand, and names follow it (D → Da → Da1). The minimap has one lane per
  level, the status bar shows the path (E1 › Ea1), and in side views `{` / `}` switch between
  following whole sections and the parts inside them;
  and can be marked by hand (group from a Tab region, add the cursor position with Shift+A, or
  "find similar to selection"). Groups show as brackets beside the notes and on the minimap and
  are remembered per song in the browser; the minimap gives every group its own labelled lane
  (click a block to jump there), and the status bar shows which section the cursor is in.
  **Side views** (button at the top right, or Shift+V) is a mode: while it is on, the other
  occurrences of the section the cursor is in are shown to the right of the notefield, in
  lockstep, and they switch by themselves as the cursor moves into another section (also while
  playing). Click a side view (or use [ and ]) to edit it; Escape or clicking the main notefield
  goes back, and the main cursor never moves meanwhile. Each side view has a thin progress line
  and an × to hide it; the row scrolls horizontally (Shift+wheel, trackpad or the scrollbar).
  The minimap always moves the main notefield. Ghost notes and ticks show where the rhythm
  differs (red when the music there is the same).
  Occurrences can be copied onto each other as is or mirrored. Groups are saved inside the .sm/.ssc as one comment
  line between the header and the first chart (`//@better-arrow-vortex {...}`, positions in beats).
  StepMania, Etterna and ArrowVortex skip comments there, so the game sees the same file; editors
  that rewrite the file from scratch (e.g. ArrowVortex) drop the line. Turn it off in the
  Sections menu to keep groups in the browser only.
- Playback with speed and volume control, beat tick (F3) and note tick (F4).
- Song properties, chart properties with note counts, NPS and stream breakdown, chart list,
  new/delete chart, chart switching (F5/F6). F1 lists every shortcut.

Not ported yet: dancing bot, note generator, SM-style preview, background images, audio
conversion, recent files, DWI/osu formats, editing of SM5 speed/scroll/fake/tickcount/combo
segments (they are preserved on save), two-player routine notes.

## Layout

```
src/model/      simfile data, .sm/.ssc parser and writer, timing (beat <-> time), note helpers
src/editor/     Editor state and all edit operations, view/cursor/snap, renderer, noteskin,
                minimap, waveform peaks, audio playback, file access, undo history, settings
src/analysis/   BPM / offset detection and per-band onset strength (run in Web Workers)
src/app/        actions table (menus + shortcuts), input handling, app wiring, demo song
src/ui/         menu bar, dialogs, status bar, HUD
tests/          vitest unit tests
```

### Adding your own features

- **New command:** add an entry in `createActions` (`src/app/actions.ts`) and put its id in `MENU`.
  The menu, keyboard handling and the F1 shortcut list pick it up automatically.
- **Another image noteskin:** copy its Down sprite sheets into `public/noteskins/<id>/` and add an
  `ImageSkinDef` to `IMAGE_SKINS` in `src/editor/imageSkin.ts` (frame layout, quant colours, hold
  body offset from `metrics.ini`), then a menu action next to `view.skinDbz`.
- **New panel:** subclass `Dialog` in `src/ui/dialogs.ts` and register it in `createDialog`.
- **Chart analysis** (e.g. a difficulty/effort model): read `editor.notes` (sorted
  `{row, col, type, endRow}`, 48 rows per beat) and convert rows to seconds with
  `editor.tempo.rowToTime(row)`. Draw overlays in `Renderer.draw()` (`src/editor/renderer.ts`)
  using `view.rowToY(row)` / `view.timeToY(t)` for the vertical position.
- **Edits:** go through `editor.editNotes(remove, add, description)` or `editor.editTiming(...)`
  so they are undoable and mark the file as modified.
- `window.app` is exposed in the browser console for quick experiments.
