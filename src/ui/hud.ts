// Short-lived messages in the top-left corner, like ArrowVortex's HUD notes.

import type { HudKind } from '../editor/editor';
import { h } from './dom';

export class Hud {
  readonly el = h('div', { class: 'hud' });
  private readonly log: { text: string; kind: HudKind; time: Date }[] = [];

  show(text: string, kind: HudKind = 'note'): void {
    this.log.push({ text, kind, time: new Date() });
    if (this.log.length > 200) this.log.shift();
    const msg = h('div', { class: `hud-msg ${kind}` }, text);
    this.el.append(msg);
    while (this.el.children.length > 6) this.el.firstElementChild?.remove();
    const life = kind === 'warning' || kind === 'error' ? 6000 : 2500;
    setTimeout(() => {
      msg.classList.add('fade');
      setTimeout(() => msg.remove(), 400);
    }, life);
  }

  get messages() {
    return this.log;
  }
}
