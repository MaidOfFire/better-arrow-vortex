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
The start page lists recently opened song folders (opened with **File > Open** or dropped as a
folder); click one to open it again (the browser asks once for access).

## What works

- `.sm` / `.ssc` load and save, including BPMs, stops, delays, warps (written as negative BPMs in
  `.sm`), time signatures, labels; other tags are kept as they were.
- Notefield in time-based (C-mod) or row-based (X-mod) view, drawn with the DivideByZero noteskin
  by default (View > Noteskin also has built-in drawn arrows and bars), holds, rolls, mines, lifts, fakes,
  an onset strip beside the notes (attack strength in low / mid / high bands; View > Audio view
  can switch back to the ArrowVortex waveform), beat lines,
  measure numbers, stop/delay/warp shading, tempo boxes and a minimap (notes or density).
- NPS graph (button at the top right, Shift+G or View > Show NPS graph): a chord density graph
  after Etterna's Til' Death theme, in a window half as wide as the editor that can be moved by
  its title and resized from its corner. One bar per second, as tall as its notes per second,
  shaded darker for notes in bigger chords (single, jump, hand, quad; stacked, so every chord
  size shows), mines in red and a red line at 70% of the peak NPS. It marks the cursor and the
  stretch on screen, and the line below names the chords in the second under the mouse (or the
  cursor); click or drag to jump there. Unpinned, the window closes on a click elsewhere; pinned,
  it stays open while you edit and comes back next time, with its size and place.
- Placing notes ArrowVortex-style: number keys place/remove, hold the key and move for holds,
  Shift for mines, Alt for the right half of wide styles, record live while playing.
- Selection by drag box (Shift adds, Alt removes), region select (Tab), select by type or
  quantization; cut/copy/paste/insert-paste, delete, mirror, expand/compress, requantize, note-type
  conversions, holds ↔ rolls; unlimited undo/redo.
- Tempo editing at the cursor (Ctrl+Alt+Q/W/E/R/T/[), clickable tempo boxes, Adjust Sync (offset,
  initial BPM, move first beat, automatic BPM + offset detection, which lands within a few
  milliseconds of hand-synced Etterna charts; as the method, "Onsets" is fast, "Beat This!" runs a
  neural beat tracker on the first two minutes, about 12 s, after a one-time 10 MB model
  download, and also puts beat 0 on a downbeat so measures start where the bars do), Adjust Tempo (halve/double,
  insert/delete beats, region to stop), tempo breakdown.
- Similar sections (Sections menu, Shift+M): repeated parts of the song are detected from the
  audio on the chart's beat grid when the music loads (harmony + timbre + onset rhythm per beat),
  at three scales so that repeats nest: whole sections, the parts that repeat inside them (e.g. a
  chorus phrase) and smaller figures. A repeat counts only when it lines up sharply: its
  occurrences must match clearly better at their exact offset than a beat or three off, so music
  that just keeps one sound throughout is not taken for a repeat. Occurrences that do not line up
  with the rest of their group are dropped, each group's confidence is shown in the dialog
  (faint, clear, very clear), and groups never half overlap: two groups either nest or sit side
  by side (the surer one wins; a near copy of a group is merged into it). Groups marked by hand
  are kept as they are and found groups fit around them. Detection builds five detail levels as
  one hierarchy, coarsest first: each level searches more widely and fits around what the
  coarser ones found (adding occurrences to them at most), so a finer level only adds groups. The
  slider beside "Detect automatically" (also Sections > Detection detail) is a cut-off on that
  hierarchy and moves instantly: 1 shows only the clearest big sections, 2 all big sections, 3
  adds the parts inside them, 4 (default) short figures, 5 also fainter and shorter repeats.
  Found groups are refreshed whenever a song loads. Occurrences are matched at any beat offset, also when a
  repeat is not a whole number of measures later, and each group's start and end are then moved
  beat by beat to where its occurrences stop sounding alike; where two neighbouring sections
  both claim a few beats, each keeps the beats its own occurrences agree on more. The nesting
  follows from which occurrences contain which, also for groups marked by hand, and names follow
  it (D → Da → Da1): a group sits one level below the deepest group it lies inside. The minimap
  has one lane per level (levels past the third are a narrower stripe inside their parent's
  block; hand-made groups of one level that partly overlap are drawn side by side), brackets beside the notes get a column per level, the status bar shows the path (E#1 › Ea#1: occurrence 1 of E, occurrence 1 of Ea), and in side views `{` / `}` switch between
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
  The minimap always moves the main notefield. Ticks show where the rhythm differs (red when
  the music there is the same); ghost notes from the other panes can be turned on in the
  Sections menu.
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
src/analysis/   BPM / offset detection, per-band onset strength, similar sections, Beat This!
                (all run in Web Workers)
public/models/  the Beat This! "small0" model as ONNX, run with ONNX Runtime Web
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

## Credits

Beat This! (Francesco Foscarin, Jan Schlüter, Gerhard Widmer; JKU Linz, ISMIR 2024,
https://github.com/CPJKU/beat_this): code and model weights under the MIT license. Its "small0"
model is included as `public/models/beat_this_small0.onnx` (exported to ONNX for this editor;
licence in `public/models/LICENSE-beat-this.txt`) and runs with ONNX Runtime Web (MIT).
