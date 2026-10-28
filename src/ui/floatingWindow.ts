// A floating window over the notefield (NPS graph, sync map): starts half as wide as the editor,
// drag it by its title, resize it from the corner. Unpinned it is a popup that closes on a click
// elsewhere; pinned it stays open, also in the next session. Its state lives in the settings.

import type { Editor } from '../editor/editor';
import type { Settings } from '../editor/settings';
import { makeDraggable } from './dialogs';
import { h } from './dom';

type KeyOf<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];

/** The settings holding one window's state: shown, pinned, place and size (see place()). */
export interface WindowKeys {
  open: KeyOf<boolean>;
  pinned: KeyOf<boolean>;
  x: KeyOf<number>;
  y: KeyOf<number>;
  w: KeyOf<number>;
  h: KeyOf<number>;
}

const PIN_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M5 1h6v1.5l-1 1V7l2.5 2.5V11h-9V9.5L6 7V3.5l-1-1z"/><path fill="currentColor" d="M7.4 11h1.2v3.5L8 16l-.6-1.5z"/></svg>';

export class FloatingWindow {
  readonly el: HTMLElement;
  /** Where the content goes: a column that fills the window. */
  readonly body = h('div', { class: 'float-body' });
  private readonly pin = h('button', { class: 'float-pin', type: 'button' });
  private saveTimer = 0;

  constructor(
    private readonly editor: Editor,
    private readonly layer: HTMLElement,
    name: string,
    private readonly keys: WindowKeys,
    shortcut: string,
    /** Called when the window is shown or the editor is resized. */
    private readonly onLayout: () => void,
  ) {
    const s = editor.settings as unknown as Record<string, number | boolean>;
    // An unpinned window is a popup: it does not come back on its own in the next session.
    if (!s[keys.pinned]) s[keys.open] = false;

    const close = h('button', { class: 'dlg-close', title: `Close (${shortcut})`, type: 'button' }, '×');
    const title = h('div', { class: 'dlg-title' }, h('span', {}, name), h('div', { class: 'float-buttons' }, this.pin, close));
    this.el = h('div', { class: 'dialog float-window', hidden: true }, title, this.body);
    this.pin.innerHTML = PIN_ICON;
    layer.append(this.el);
    this.updatePin();

    makeDraggable(this.el, title, () => this.saveGeometry());
    close.addEventListener('click', () => this.setOpen(false));
    this.pin.addEventListener('click', () => {
      s[keys.pinned] = !s[keys.pinned];
      editor.saveSettings();
      this.updatePin();
      editor.hud(`${name} ${s[keys.pinned] ? 'pinned: stays open' : 'unpinned: closes on a click elsewhere'}`);
    });
    // Bring to front before a canvas captures the pointer (moving it later would drop the capture).
    this.el.addEventListener(
      'pointerdown',
      () => {
        if (layer.lastElementChild !== this.el) layer.append(this.el);
      },
      true,
    );
    // Unpinned: a click anywhere else closes it (the menus and the toolbar buttons excepted).
    window.addEventListener(
      'mousedown',
      (e) => {
        const t = e.target;
        if (this.el.hidden || s[keys.pinned] || !(t instanceof Element)) return;
        if (this.el.contains(t) || t.closest('.menubar')) return;
        this.setOpen(false);
      },
      true,
    );
    new ResizeObserver(() => {
      this.place();
      this.onLayout();
    }).observe(layer);
    // Resizing from the corner: remember the size once the mouse stops.
    new ResizeObserver(() => {
      if (this.el.hidden) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.saveGeometry(), 250);
    }).observe(this.el);
  }

  private get state(): Record<string, number | boolean> {
    return this.editor.settings as unknown as Record<string, number | boolean>;
  }

  /** Shows or hides the window to match the settings; true while it is shown. */
  update(): boolean {
    const show = this.editor.isOpen && Boolean(this.state[this.keys.open]);
    if (this.el.hidden === show) {
      this.el.hidden = !show;
      if (show) {
        this.place();
        this.onLayout();
      }
    }
    return show;
  }

  setOpen(open: boolean): void {
    const ed = this.editor;
    if (this.state[this.keys.open] === open) return;
    this.state[this.keys.open] = open;
    ed.saveSettings();
    ed.changed();
  }

  private updatePin(): void {
    const pinned = Boolean(this.state[this.keys.pinned]);
    this.pin.classList.toggle('pinned', pinned);
    this.pin.title = pinned ? 'Pinned: stays open while you edit. Click to unpin.' : 'Pin: keep it open while you edit (unpinned it closes on a click elsewhere).';
  }

  /**
   * Width is kept as a fraction of the editor and position as a fraction of the room around the
   * window, so both survive resizing the browser.
   */
  private place(): void {
    if (this.el.hidden) return;
    const s = this.state;
    const k = this.keys;
    this.el.style.width = `${((s[k.w] as number) * 100).toFixed(2)}%`;
    this.el.style.height = `${Math.round(s[k.h] as number)}px`;
    const roomX = Math.max(0, this.layer.clientWidth - this.el.offsetWidth);
    const roomY = Math.max(0, this.layer.clientHeight - this.el.offsetHeight - 8);
    this.el.style.left = `${Math.round((s[k.x] as number) * roomX)}px`;
    this.el.style.top = `${Math.round((s[k.y] as number) * roomY)}px`;
  }

  private saveGeometry(): void {
    if (this.el.hidden || !this.layer.clientWidth) return;
    const s = this.state;
    const k = this.keys;
    s[k.w] = Math.min(1, this.el.offsetWidth / this.layer.clientWidth);
    s[k.h] = this.el.offsetHeight;
    const roomX = this.layer.clientWidth - this.el.offsetWidth;
    const roomY = this.layer.clientHeight - this.el.offsetHeight - 8;
    s[k.x] = roomX > 0 ? Math.min(1, Math.max(0, this.el.offsetLeft / roomX)) : 0.5;
    s[k.y] = roomY > 0 ? Math.min(1, Math.max(0, this.el.offsetTop / roomY)) : 1;
    this.editor.saveSettings();
  }
}
