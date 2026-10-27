// Noteskins drawn from StepMania-style sprite sheets (Down-pointing art rotated per column).

/** A sprite sheet split into a grid of equally sized frames. */
interface Sheet {
  file: string;
  cols: number;
  rows: number;
}

export interface ImageSkinDef {
  id: string;
  name: string;
  /** Folder under public/, relative to the app's base URL. */
  base: string;
  /** Colour per quantization (rowQuant order), used for the minimap and beat lines. */
  quantColors: string[];
  /** One frame per quantization, 4th first; extra quantizations use the last frame. */
  tapNote: Sheet;
  /** Frame 0 is shown for the first `flashBeats` of each beat, frame 1 otherwise. */
  receptor: Sheet & { flashBeats: number };
  /** Animated over `animBeats` beats. */
  mine: Sheet & { animBeats: number };
  holdBody: string;
  holdCap: string;
  rollBody: string;
  rollCap: string;
  /** StopDrawingHoldBodyOffsetFromTail from metrics.ini, in skin pixels. */
  bodyOffsetFromTail: number;
  /** Body drawn under the hold/roll textures when "bold holds" is on: [edge, centre] colours, width in skin pixels. */
  boldBody: { hold: [string, string]; roll: [string, string]; width: number };
  /** Size of one frame in skin pixels; it is scaled to the column width. */
  framePx: number;
}

export const DIVIDE_BY_ZERO: ImageSkinDef = {
  id: 'dividebyzero',
  name: 'DivideByZero',
  base: 'noteskins/dividebyzero/',
  quantColors: ['#ff0000', '#0040ff', '#00ff00', '#ffff00', '#ff00bf', '#ffa400', '#00ffff', '#a8a8a8', '#a8a8a8'],
  tapNote: { file: 'tap-note.png', cols: 1, rows: 8 },
  receptor: { file: 'receptor.png', cols: 2, rows: 1, flashBeats: 0.2 },
  mine: { file: 'mine.png', cols: 8, rows: 1, animBeats: 4 },
  holdBody: 'hold-body.png',
  holdCap: 'hold-cap.png',
  rollBody: 'roll-body.png',
  rollCap: 'roll-cap.png',
  bodyOffsetFromTail: -32,
  boldBody: {
    hold: ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.58)'],
    roll: ['rgba(120,90,240,0.3)', 'rgba(185,160,255,0.75)'],
    width: 50,
  },
  framePx: 64,
};

export const IMAGE_SKINS: ImageSkinDef[] = [DIVIDE_BY_ZERO];

export class ImageSkin {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly cache = new Map<string, HTMLCanvasElement>();
  ready = false;
  dpr = 1;

  constructor(
    readonly def: ImageSkinDef,
    onReady: () => void,
  ) {
    const files = [def.tapNote.file, def.receptor.file, def.mine.file, def.holdBody, def.holdCap, def.rollBody, def.rollCap];
    Promise.all(
      files.map(async (f) => {
        const img = new Image();
        img.src = `${import.meta.env.BASE_URL}${def.base}${f}`;
        await img.decode();
        this.images.set(f, img);
      }),
    ).then(
      () => {
        this.ready = true;
        onReady();
      },
      (e) => console.warn(`Noteskin ${def.name} failed to load`, e),
    );
  }

  /** A frame of a sheet, rotated (degrees clockwise) and scaled to `size`, optionally as a white silhouette. */
  private frame(sheet: Sheet, index: number, rotation: number, size: number, white = false): HTMLCanvasElement {
    const key = `${sheet.file}:${index}:${rotation}:${size}:${this.dpr}:${white}`;
    let c = this.cache.get(key);
    if (c) return c;
    const img = this.images.get(sheet.file)!;
    const fw = img.width / sheet.cols;
    const fh = img.height / sheet.rows;
    const i = Math.min(index, sheet.cols * sheet.rows - 1);
    const sx = (i % sheet.cols) * fw;
    const sy = Math.floor(i / sheet.cols) * fh;
    const px = Math.max(1, Math.ceil(size * this.dpr));
    c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const ctx = c.getContext('2d')!;
    ctx.translate(px / 2, px / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, sx, sy, fw, fh, -px / 2, -px / 2, px, px);
    if (white) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, px, px);
    }
    if (this.cache.size > 800) this.cache.clear();
    this.cache.set(key, c);
    return c;
  }

  /** The art points down; `angle` uses 0 = up, 90 = right. */
  private static rotation(angle: number): number {
    return (((angle - 180) % 360) + 360) % 360;
  }

  private blit(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement, x: number, y: number, size: number): void {
    ctx.drawImage(c, x - size / 2, y - size / 2, size, size);
  }

  drawNote(ctx: CanvasRenderingContext2D, angle: number, quant: number, x: number, y: number, size: number): void {
    this.blit(ctx, this.frame(this.def.tapNote, quant, ImageSkin.rotation(angle), size), x, y, size);
  }

  drawReceptor(ctx: CanvasRenderingContext2D, angle: number, x: number, y: number, size: number, beat: number): void {
    const frac = beat - Math.floor(beat);
    const index = frac < this.def.receptor.flashBeats ? 0 : 1;
    this.blit(ctx, this.frame(this.def.receptor, index, ImageSkin.rotation(angle), size), x, y, size);
  }

  /** Brightening flash on a receptor after a note passes it during playback. */
  drawGlow(ctx: CanvasRenderingContext2D, angle: number, x: number, y: number, size: number): void {
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    this.blit(ctx, this.frame(this.def.receptor, 0, ImageSkin.rotation(angle), size, true), x, y, size);
    this.blit(ctx, this.frame(this.def.tapNote, 7, ImageSkin.rotation(angle), size, true), x, y, size);
    ctx.globalCompositeOperation = prev;
  }

  drawSelection(ctx: CanvasRenderingContext2D, angle: number, quant: number, x: number, y: number, size: number): void {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.55;
    this.blit(ctx, this.frame(this.def.tapNote, quant, ImageSkin.rotation(angle), size, true), x, y, size);
    ctx.globalAlpha = alpha;
  }

  drawMine(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, beat: number): void {
    const m = this.def.mine;
    const frames = m.cols * m.rows;
    const t = (((beat % m.animBeats) + m.animBeats) % m.animBeats) / m.animBeats;
    this.blit(ctx, this.frame(m, Math.floor(t * frames) % frames, 0, size), x, y, size);
  }

  /**
   * Hold/roll body tiled from the head towards the tail, then the bottom cap. With `bold`, a solid
   * rounded body is drawn underneath so long notes stand out even with a minimal skin.
   */
  drawBody(ctx: CanvasRenderingContext2D, type: 'hold' | 'roll', x: number, headY: number, tailY: number, size: number, bold: boolean): void {
    const body = this.images.get(type === 'roll' ? this.def.rollBody : this.def.holdBody)!;
    const cap = this.images.get(type === 'roll' ? this.def.rollCap : this.def.holdCap)!;
    const s = size / this.def.framePx;
    const dir = tailY >= headY ? 1 : -1;
    const length = Math.abs(tailY - headY) + this.def.bodyOffsetFromTail * s;
    ctx.save();
    ctx.translate(x, headY);
    if (dir < 0) ctx.scale(1, -1); // reverse scroll: flip the body and cap
    if (bold) {
      const half = (this.def.boldBody.width * s) / 2;
      const end = Math.abs(tailY - headY);
      ctx.beginPath();
      ctx.moveTo(-half, 0);
      ctx.lineTo(-half, end);
      ctx.ellipse(0, end, half, half * 0.6, 0, Math.PI, 0, true);
      ctx.lineTo(half, 0);
      ctx.closePath();
      const [edge, centre] = this.def.boldBody[type];
      const tube = ctx.createLinearGradient(-half, 0, half, 0);
      tube.addColorStop(0, edge);
      tube.addColorStop(0.4, centre);
      tube.addColorStop(0.6, centre);
      tube.addColorStop(1, edge);
      ctx.fillStyle = tube;
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.5 * s);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.stroke();
    }
    const tileH = body.height * s;
    for (let y = 0; y < length; y += tileH) {
      const h = Math.min(tileH, length - y);
      ctx.drawImage(body, 0, 0, body.width, h / s, -size / 2, y, size, h);
    }
    ctx.drawImage(cap, -size / 2, Math.max(0, length), size, cap.height * s);
    ctx.restore();
  }
}
