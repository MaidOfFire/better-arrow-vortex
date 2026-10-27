// Desktop-style menu bar built from the MENU table.

import { MENU, displayShortcut, type Action, type MenuEntry } from '../app/actions';
import { h } from './dom';

export class Menubar {
  readonly el: HTMLElement;
  private openIndex = -1;
  private tops: HTMLElement[] = [];

  constructor(
    private readonly actions: Map<string, Action>,
    private readonly onRun: (a: Action) => void,
  ) {
    this.el = h('nav', { class: 'menubar' });
    MENU.forEach((menu, i) => {
      const top = h('div', { class: 'menu-top' }, h('span', { class: 'menu-title' }, menu.label));
      top.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('.menu-panel')) return;
        e.preventDefault();
        this.toggle(i);
      });
      top.addEventListener('mouseenter', () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i);
      });
      this.tops.push(top);
      this.el.append(top);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.el.contains(e.target as Node)) this.close();
    });
    window.addEventListener('blur', () => this.close());
  }

  get isOpen(): boolean {
    return this.openIndex >= 0;
  }

  private toggle(i: number): void {
    if (this.openIndex === i) this.close();
    else this.open(i);
  }

  private open(i: number): void {
    this.close();
    this.openIndex = i;
    const top = this.tops[i];
    top.classList.add('open');
    top.append(this.buildPanel(MENU[i].items));
  }

  close(): void {
    if (this.openIndex < 0) return;
    const top = this.tops[this.openIndex];
    top.classList.remove('open');
    top.querySelector('.menu-panel')?.remove();
    this.openIndex = -1;
  }

  private buildPanel(items: MenuEntry[]): HTMLElement {
    const panel = h('div', { class: 'menu-panel' });
    for (const item of items) {
      if (item === '-') {
        panel.append(h('div', { class: 'menu-sep' }));
      } else if (typeof item === 'string') {
        const a = this.actions.get(item);
        if (!a) continue;
        const enabled = a.enabled ? a.enabled() : true;
        const checked = a.checked?.();
        const row = h(
          'div',
          { class: `menu-item${enabled ? '' : ' disabled'}` },
          h('span', { class: 'menu-check' }, checked ? '✓' : ''),
          h('span', { class: 'menu-label' }, a.label),
          h('span', { class: 'menu-key' }, a.keys[0] ? displayShortcut(a.keys[0]) : ''),
        );
        row.addEventListener('mouseenter', () => {
          panel.querySelectorAll(':scope > .submenu > .menu-panel').forEach((p) => p.remove());
        });
        row.addEventListener('mouseup', () => {
          if (!enabled) return;
          this.close();
          this.onRun(a);
        });
        panel.append(row);
      } else {
        const row = h(
          'div',
          { class: 'menu-item submenu' },
          h('span', { class: 'menu-check' }),
          h('span', { class: 'menu-label' }, item.label),
          h('span', { class: 'menu-key' }, '▸'),
        );
        row.addEventListener('mouseenter', () => {
          panel.querySelectorAll(':scope > .submenu > .menu-panel').forEach((p) => p.remove());
          const sub = this.buildPanel(item.items);
          sub.classList.add('sub');
          row.append(sub);
          // Keep the submenu on screen.
          const r = sub.getBoundingClientRect();
          if (r.right > window.innerWidth) sub.classList.add('left');
          if (r.bottom > window.innerHeight) sub.style.top = `${Math.max(-r.top, window.innerHeight - r.bottom - 4)}px`;
        });
        panel.append(row);
      }
    }
    return panel;
  }
}
