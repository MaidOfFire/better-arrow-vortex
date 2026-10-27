// Procedurally drawn note sprites, cached per shape, colour and size.
//
// Notes have a black outline, a darker rim in the quantization colour and a lighter inner panel
// with a soft top highlight. Lighting is always from the top of the screen, whatever the rotation.

import type { ColumnShape } from '../model/styles';

/** Quantization colours, same order as rowQuant(): 4th, 8th, 12th, 16th, 24th, 32nd, 48th, 64th, 192nd. */
export const QUANT_COLORS = ['#ff0000', '#2976f5', '#910cce', '#ffff00', '#ce0c71', '#f7941d', '#69e7f5', '#00c600', '#848484'];

export type SkinType = 'arrows' | 'bars';

type Pt = [number, number];

// Arrow outline pointing up, in a unit box centred on the origin.
const ARROW: Pt[] = [
  [0, -0.44],
  [0.44, 0],
  [0.44, 0.22],
  [0.2, -0.02],
  [0.2, 0.44],
  [-0.2, 0.44],
  [-0.2, -0.02],
  [-0.44, 0.22],
  [-0.44, 0],
];
const BAR: Pt[] = [
  [-0.45, -0.17],
  [0.45, -0.17],
  [0.45, 0.17],
  [-0.45, 0.17],
];
const SQUARE: Pt[] = [
  [-0.37, -0.37],
  [0.37, -0.37],
  [0.37, 0.37],
  [-0.37, 0.37],
];

const OUTLINE = 0.06;
const RIM = 0.075;

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function rotate(pts: Pt[], deg: number): Pt[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

/** Moves every edge of a simple polygon inwards by d. */
function inset(pts: Pt[], d: number): Pt[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; ++i) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area += x0 * y1 - x1 * y0;
  }
  const sign = area > 0 ? 1 : -1;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dx = (q[0] - p[0]) / len;
    const dy = (q[1] - p[1]) / len;
    const nx = -dy * sign;
    const ny = dx * sign;
    return { px: p[0] + nx * d, py: p[1] + ny * d, dx, dy };
  });
  return lines.map((cur, i) => {
    const prev = lines[(i + n - 1) % n];
    const cross = prev.dx * cur.dy - prev.dy * cur.dx;
    if (Math.abs(cross) < 1e-9) return [cur.px, cur.py] as Pt;
    const t = ((cur.px - prev.px) * cur.dy - (cur.py - prev.py) * cur.dx) / cross;
    return [prev.px + prev.dx * t, prev.py + prev.dy * t] as Pt;
  });
}

/** Polygon path with rounded corners. */
function roundedPath(ctx: CanvasRenderingContext2D, pts: Pt[], radius: number): void {
  const n = pts.length;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  ctx.beginPath();
  const start = mid(pts[n - 1], pts[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; ++i) {
    const p = pts[i];
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const r = Math.min(radius, 0.45 * dist(p, prev), 0.45 * dist(p, next));
    const m = mid(p, next);
    ctx.arcTo(p[0], p[1], m[0], m[1], r);
  }
  ctx.closePath();
}

export class Noteskin {
  private cache = new Map<string, HTMLCanvasElement>();
  type: SkinType = 'arrows';
  dpr = 1;

  private sprite(key: string, size: number, draw: (ctx: CanvasRenderingContext2D, px: number) => void): HTMLCanvasElement {
    const full = `${key}|${size}|${this.dpr}|${this.type}`;
    let c = this.cache.get(full);
    if (!c) {
      c = document.createElement('canvas');
      const px = Math.max(1, Math.ceil(size * this.dpr));
      c.width = px;
      c.height = px;
      const ctx = c.getContext('2d')!;
      ctx.scale(px, px);
      ctx.translate(0.5, 0.5);
      ctx.lineJoin = 'round';
      draw(ctx, px);
      if (this.cache.size > 600) this.cache.clear();
      this.cache.set(full, c);
    }
    return c;
  }

  private outline(shape: ColumnShape): Pt[] {
    if (this.type === 'bars' || shape.kind === 'bar') return BAR;
    if (shape.kind === 'center') return SQUARE;
    return rotate(ARROW, shape.angle);
  }

  note(shape: ColumnShape, quant: number, size: number): HTMLCanvasElement {
    return this.sprite(`note:${shapeKey(shape)}:${quant}`, size, (ctx, px) => {
      const color = QUANT_COLORS[quant] ?? QUANT_COLORS[8];
      const pts = this.outline(shape);
      const panel = inset(pts, RIM);

      // Soft drop shadow, then the black outline.
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = px * 0.05;
      ctx.shadowOffsetY = px * 0.02;
      roundedPath(ctx, pts, 0.07);
      ctx.lineWidth = OUTLINE;
      ctx.strokeStyle = '#0a0a0a';
      ctx.stroke();
      ctx.restore();

      // Rim.
      roundedPath(ctx, pts, 0.07);
      const rim = ctx.createLinearGradient(0, -0.5, 0, 0.5);
      rim.addColorStop(0, shade(color, -0.15));
      rim.addColorStop(1, shade(color, -0.55));
      ctx.fillStyle = rim;
      ctx.fill();

      // Inner panel.
      roundedPath(ctx, panel, 0.04);
      const body = ctx.createLinearGradient(0, -0.45, 0, 0.45);
      body.addColorStop(0, shade(color, 0.55));
      body.addColorStop(0.45, color);
      body.addColorStop(1, shade(color, -0.2));
      ctx.fillStyle = body;
      ctx.fill();

      // Highlight on the upper part of the panel.
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.ellipse(0, -0.42, 0.55, 0.3, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fill();
      ctx.restore();

      roundedPath(ctx, panel, 0.04);
      ctx.lineWidth = 0.018;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.stroke();
    });
  }

  receptor(shape: ColumnShape, size: number, lit: boolean): HTMLCanvasElement {
    return this.sprite(`recep:${shapeKey(shape)}:${lit}`, size, (ctx) => {
      const pts = this.outline(shape);
      const panel = inset(pts, RIM);
      if (lit) {
        roundedPath(ctx, pts, 0.07);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.lineWidth = 0.045;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
        return;
      }
      roundedPath(ctx, pts, 0.07);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.lineWidth = OUTLINE;
      ctx.strokeStyle = '#0a0a0a';
      ctx.stroke();
      roundedPath(ctx, pts, 0.07);
      ctx.lineWidth = 0.035;
      ctx.strokeStyle = '#8c8c8c';
      ctx.stroke();
      roundedPath(ctx, panel, 0.04);
      ctx.lineWidth = 0.02;
      ctx.strokeStyle = 'rgba(140,140,140,0.45)';
      ctx.stroke();
    });
  }

  glow(shape: ColumnShape, size: number): HTMLCanvasElement {
    return this.sprite(`glow:${shapeKey(shape)}`, size, (ctx, px) => {
      ctx.shadowColor = 'rgba(255,255,220,1)';
      ctx.shadowBlur = px * 0.12;
      roundedPath(ctx, this.outline(shape), 0.07);
      ctx.lineWidth = 0.06;
      ctx.strokeStyle = 'rgba(255,255,235,0.95)';
      ctx.stroke();
    });
  }

  /** White overlay following the note's shape, for selected notes. */
  selection(shape: ColumnShape | 'mine', size: number): HTMLCanvasElement {
    return this.sprite(`sel:${shape === 'mine' ? 'mine' : shapeKey(shape)}`, size, (ctx) => {
      if (shape === 'mine') {
        ctx.beginPath();
        ctx.arc(0, 0, 0.36, 0, Math.PI * 2);
      } else {
        roundedPath(ctx, this.outline(shape), 0.07);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
      ctx.lineWidth = 0.05;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });
  }

  mine(size: number): HTMLCanvasElement {
    return this.sprite('mine', size, (ctx, px) => {
      // Spikes.
      for (let i = 0; i < 8; ++i) {
        const a = (i * Math.PI) / 4 + Math.PI / 8;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - 0.2) * 0.27, Math.sin(a - 0.2) * 0.27);
        ctx.lineTo(Math.cos(a) * 0.44, Math.sin(a) * 0.44);
        ctx.lineTo(Math.cos(a + 0.2) * 0.27, Math.sin(a + 0.2) * 0.27);
        ctx.closePath();
        ctx.fillStyle = '#3a3a3a';
        ctx.fill();
        ctx.lineWidth = 0.025;
        ctx.strokeStyle = '#000';
        ctx.stroke();
      }
      // Shell.
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = px * 0.05;
      ctx.beginPath();
      ctx.arc(0, 0, 0.3, 0, Math.PI * 2);
      const shell = ctx.createRadialGradient(-0.1, -0.12, 0.02, 0, 0, 0.3);
      shell.addColorStop(0, '#7a7a7a');
      shell.addColorStop(0.5, '#333');
      shell.addColorStop(1, '#111');
      ctx.fillStyle = shell;
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 0.03;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      // Glowing core.
      ctx.save();
      ctx.shadowColor = 'rgba(255,60,30,0.9)';
      ctx.shadowBlur = px * 0.08;
      ctx.beginPath();
      ctx.arc(0, 0, 0.15, 0, Math.PI * 2);
      const core = ctx.createRadialGradient(-0.03, -0.04, 0.01, 0, 0, 0.15);
      core.addColorStop(0, '#ffd0b8');
      core.addColorStop(0.4, '#ff4a26');
      core.addColorStop(1, '#8a0000');
      ctx.fillStyle = core;
      ctx.fill();
      ctx.restore();
      // Specular highlight.
      ctx.beginPath();
      ctx.ellipse(-0.1, -0.15, 0.08, 0.04, -0.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
    });
  }
}

function shapeKey(s: ColumnShape): string {
  return s.kind === 'arrow' ? `a${s.angle}` : s.kind;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const BODY_COLORS = { hold: '#4fbf3f', roll: '#7c7ce0' };

/** Tube-like horizontal gradient for a hold or roll body centred at x. */
export function bodyFill(ctx: CanvasRenderingContext2D, type: 'hold' | 'roll', x: number, w: number, selected: boolean): CanvasGradient {
  const base = BODY_COLORS[type];
  const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  const lift = selected ? 0.35 : 0;
  g.addColorStop(0, shade(base, -0.55 + lift));
  g.addColorStop(0.35, shade(base, 0.25 + lift * 0.5));
  g.addColorStop(0.65, shade(base, 0.05 + lift * 0.5));
  g.addColorStop(1, shade(base, -0.55 + lift));
  return g;
}
