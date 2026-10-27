// Tiny DOM helpers.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** A label + control row for dialogs. */
export function field(label: string, control: HTMLElement, title?: string): HTMLElement {
  return h('label', { class: 'field', title }, h('span', { class: 'field-label' }, label), control);
}

export function textInput(value: string, onCommit: (v: string) => void, attrs: Attrs = {}): HTMLInputElement {
  const input = h('input', { type: 'text', value, ...attrs });
  const commit = () => onCommit(input.value);
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    }
  });
  return input;
}

export function numberInput(value: number, onCommit: (v: number) => void, attrs: Attrs = {}): HTMLInputElement {
  const input = h('input', { type: 'number', value, ...attrs });
  const commit = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onCommit(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    }
  });
  return input;
}

export function select<T extends string>(options: readonly (T | [T, string])[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select');
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    el.append(h('option', { value: v, selected: v === value }, label));
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const el = h('button', { type: 'button', title }, label);
  el.addEventListener('click', () => {
    // Give the keyboard back to the editor so Space still plays instead of re-clicking.
    el.blur();
    onClick();
  });
  return el;
}

/** Keeps an input's value in sync unless the user is typing in it. */
export function setIfIdle(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}
