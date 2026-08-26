/**
 * The fight venue: everything painted behind the fighters, and the near ropes
 * and posts painted over them.
 *
 * The arena is almost entirely static geometry, so it is baked once into a
 * handful of offscreen canvases at construction and blitted per frame. Only the
 * things that genuinely move — crowd bob, camera flashes, spotlight sway, haze
 * drift and the light burst — are drawn live, and those reuse pre-rendered
 * sprites so the per-frame path never builds a gradient or allocates an array.
 */

import { PALETTE, WORLD } from '@/config/gameConfig';
import { Rng, clamp, clamp01, damp, lerp } from '@/utils/math';

type Quality = 'low' | 'medium' | 'high';

const W = WORLD.width;
const H = WORLD.height;
const TAU = Math.PI * 2;

/**
 * Ring geometry in world space. The mat is a trapezoid: the back edge is
 * narrower and higher than the front edge, which is what sells the raised
 * platform without any real 3D. Fighters stand on WORLD.floorY, which lands
 * halfway down the mat with comfortable margin inside both sloped edges.
 */
const RING = {
  backY: 628,
  frontY: 824,
  backL: 356,
  backR: 1244,
  frontL: 140,
  frontR: 1460,
  apronY: 880,
  apronL: 104,
  apronR: 1496,
  farPostH: 152,
  nearPostH: 216,
  farPostW: 24,
  nearPostW: 34,
} as const;

/** Rope heights as a fraction of post height, bottom rope first. */
const ROPE_F = [0.26, 0.47, 0.68, 0.9] as const;

const NEAR_TOP = RING.frontY - RING.nearPostH;

/** Baked layers only cover the bands they need, to keep texture memory sane. */
const RING_LAYER_Y = 448;
const RING_LAYER_H = H - RING_LAYER_Y;
const FG_LAYER_Y = 560;
const FG_LAYER_H = H - FG_LAYER_Y;

/** Crowd cache overscans horizontally so the sway never exposes an edge. */
const CROWD_OVERSCAN = 48;
const CROWD_W = W + CROWD_OVERSCAN * 2;
const CROWD_ROWS = 7;

/** Lighting rig: apex positions and the mat points each lamp is aimed at. */
const SPOT_X = [292, 648, 952, 1308] as const;
const SPOT_Y = 74;
const SPOT_AIM = [452, 706, 894, 1148] as const;

const CONE_W = 540;
const CONE_H = 1010;
const CONE_AX = CONE_W / 2;
const CONE_AY = 6;

const ACCENTS = [PALETTE.player, PALETTE.enemy, PALETTE.counter, PALETTE.warn, PALETTE.crit] as const;

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

interface CrowdRow {
  /** Source band inside the cached crowd canvas. */
  sy: number;
  sh: number;
  /** Destination Y before bob. */
  dy: number;
  bobAmp: number;
  bobSpeed: number;
  phase: number;
}

interface CameraFlash {
  x: number;
  y: number;
  /** ms remaining; <= 0 marks the slot free. */
  life: number;
  max: number;
  size: number;
}

interface Cone {
  x: number;
  y: number;
  /** Resting rotation, 0 = straight down. */
  base: number;
  sway: number;
  phase: number;
  scaleX: number;
  scaleY: number;
  gain: number;
  warm: boolean;
}

interface HazeBand {
  y: number;
  phase: number;
  speed: number;
  travel: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
}

/** Gradients painted straight onto the caller's context, cached per context. */
interface LiveGradients {
  vignette: CanvasGradient;
  wash: CanvasGradient;
}

const makeLayer = (w: number, h: number): Layer | null => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
};

const roundRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
};

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : h;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgba = (hex: string, a: number): string => {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

const mixHex = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexRgb(a);
  const [r2, g2, b2] = hexRgb(b);
  const part = (x: number, y: number): string => Math.round(lerp(x, y, t)).toString(16).padStart(2, '0');
  return `#${part(r1, r2)}${part(g1, g2)}${part(b1, b2)}`;
};

/** Left/right mat edge at a given world Y, following the perspective slope. */
const matL = (y: number): number => lerp(RING.backL, RING.frontL, (y - RING.backY) / (RING.frontY - RING.backY));
const matR = (y: number): number => lerp(RING.backR, RING.frontR, (y - RING.backY) / (RING.frontY - RING.backY));

const matPath = (ctx: CanvasRenderingContext2D): void => {
  ctx.beginPath();
  ctx.moveTo(RING.backL, RING.backY);
  ctx.lineTo(RING.backR, RING.backY);
  ctx.lineTo(RING.frontR, RING.frontY);
  ctx.lineTo(RING.frontL, RING.frontY);
  ctx.closePath();
};

/** A sagging rope, drawn as shadow + core + top highlight so it reads as round. */
const ropePath = (
  ctx: CanvasRenderingContext2D,
  x0: number, x1: number, y: number, sag: number, dy: number,
): void => {
  ctx.beginPath();
  ctx.moveTo(x0, y + dy);
  ctx.quadraticCurveTo((x0 + x1) / 2, y + dy + sag * 2, x1, y + dy);
};

export class ArenaRenderer {
  private quality: Quality = 'high';
  private energy = 0.35;
  private energyTarget = 0.35;
  /** 0..1 arena light burst, decays on its own. */
  private flash = 0;
  private flashAccum = 0;
  private built = false;

  private bgLayer: HTMLCanvasElement | null = null;
  private crowdLayer: HTMLCanvasElement | null = null;
  private ringLayer: HTMLCanvasElement | null = null;
  private fgLayer: HTMLCanvasElement | null = null;

  private coneWarm: HTMLCanvasElement | null = null;
  private coneCool: HTMLCanvasElement | null = null;
  private flashSprite: HTMLCanvasElement | null = null;
  private hazeSprite: HTMLCanvasElement | null = null;

  private readonly rows: CrowdRow[] = [];
  private readonly flashes: CameraFlash[] = [];
  private readonly cones: Cone[] = [];
  private readonly haze: HazeBand[] = [];

  private gradients: LiveGradients | null = null;
  private gradientOwner: CanvasRenderingContext2D | null = null;

  private readonly rng = new Rng(0x9e3779b);

  constructor() {
    for (let i = 0; i < 26; i += 1) this.flashes.push({ x: 0, y: 0, life: 0, max: 1, size: 16 });

    for (let i = 0; i < SPOT_X.length; i += 1) {
      const x = SPOT_X[i];
      const aim = SPOT_AIM[i];
      this.cones.push({
        x,
        y: SPOT_Y,
        base: Math.atan2(-(aim - x), 800 - SPOT_Y),
        sway: 0.032 + (i % 2) * 0.018,
        phase: i * 1.9,
        scaleX: 0.9 + (i % 2) * 0.22,
        scaleY: 1,
        gain: i === 0 || i === 3 ? 0.85 : 1,
        warm: i === 1 || i === 2,
      });
    }

    this.haze.push({ y: 322, phase: 0.4, speed: 0.000055, travel: 210, scaleX: 2.5, scaleY: 1.1, alpha: 0.05 });
    this.haze.push({ y: 486, phase: 2.7, speed: 0.000039, travel: 280, scaleX: 3.1, scaleY: 1.5, alpha: 0.045 });
    this.haze.push({ y: 604, phase: 4.9, speed: 0.000028, travel: 170, scaleX: 2.7, scaleY: 0.9, alpha: 0.035 });

    this.ensureBuilt();
  }

  // ---------------------------------------------------------------- lifecycle

  update(dtMs: number): void {
    const dt = clamp(dtMs, 0, 120);
    this.energy = damp(this.energy, this.energyTarget, 420, dt);
    // Burst falls off over roughly a quarter second, matching a camera strobe.
    this.flash = Math.max(0, this.flash - dt / 260);
    if (this.quality !== 'low') this.updateFlashes(dt);
  }

  setCrowdEnergy(v: number): void {
    this.energyTarget = clamp01(v);
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    if (q === 'low') {
      for (let i = 0; i < this.flashes.length; i += 1) this.flashes[i].life = 0;
      this.flashAccum = 0;
    }
  }

  flashLights(intensity: number): void {
    this.flash = clamp01(Math.max(this.flash, intensity));
  }

  // ------------------------------------------------------------------ drawing

  drawBackground(ctx: CanvasRenderingContext2D, timeMs: number): void {
    this.ensureBuilt();

    if (this.bgLayer) ctx.drawImage(this.bgLayer, 0, 0);
    else {
      ctx.fillStyle = PALETTE.bg;
      ctx.fillRect(0, 0, W, H);
    }

    this.drawCrowd(ctx, timeMs);
    if (this.quality !== 'low') this.drawCameraFlashes(ctx);
    this.drawSpotlights(ctx, timeMs);
    if (this.quality === 'high') this.drawHaze(ctx, timeMs);

    if (this.ringLayer) ctx.drawImage(this.ringLayer, 0, RING_LAYER_Y);

    if (this.flash > 0.001) {
      const g = this.ensureGradients(ctx);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.flash * 0.5;
      ctx.fillStyle = g.wash;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  drawForeground(ctx: CanvasRenderingContext2D, timeMs: number): void {
    this.ensureBuilt();

    if (this.fgLayer) ctx.drawImage(this.fgLayer, 0, FG_LAYER_Y);

    // Near post caps catch the rig light; a slow breathe keeps them from
    // looking like a decal, and they blow out during a knockdown flash.
    const sprite = this.flashSprite;
    if (sprite) {
      const a = clamp01(0.07 + Math.sin(timeMs * 0.0016) * 0.025 + this.flash * 0.5);
      if (a > 0.002) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        const s = 104;
        ctx.drawImage(sprite, RING.frontL - s / 2, NEAR_TOP - s / 2, s, s);
        ctx.drawImage(sprite, RING.frontR - s / 2, NEAR_TOP - s / 2, s, s);
        ctx.restore();
      }
    }

    const g = this.ensureGradients(ctx);
    ctx.save();
    ctx.fillStyle = g.vignette;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ------------------------------------------------------------ live elements

  private drawCrowd(ctx: CanvasRenderingContext2D, timeMs: number): void {
    const layer = this.crowdLayer;
    if (!layer) return;
    const e = this.energy;
    const drift = Math.sin(timeMs * 0.00042) * 3 * e;
    for (let i = 0; i < this.rows.length; i += 1) {
      const r = this.rows[i];
      const bob = Math.sin(timeMs * r.bobSpeed + r.phase) * r.bobAmp * (0.28 + e * 0.95);
      const sway = Math.cos(timeMs * r.bobSpeed * 0.62 + r.phase) * r.bobAmp * 0.55 * e + drift;
      ctx.drawImage(
        layer,
        0, r.sy, CROWD_W, r.sh,
        -CROWD_OVERSCAN + sway, r.dy + bob, CROWD_W, r.sh,
      );
    }
  }

  private updateFlashes(dt: number): void {
    for (let i = 0; i < this.flashes.length; i += 1) {
      const f = this.flashes[i];
      if (f.life > 0) f.life -= dt;
    }
    this.flashAccum += (dt / 1000) * lerp(0.6, 12, this.energy);
    while (this.flashAccum >= 1) {
      this.flashAccum -= 1;
      this.spawnFlash();
    }
  }

  private spawnFlash(): void {
    for (let i = 0; i < this.flashes.length; i += 1) {
      const f = this.flashes[i];
      if (f.life > 0) continue;
      f.x = this.rng.range(40, W - 40);
      f.y = this.rng.range(272, 616);
      f.max = this.rng.range(120, 210);
      f.life = f.max;
      f.size = this.rng.range(18, 40);
      return;
    }
  }

  private drawCameraFlashes(ctx: CanvasRenderingContext2D): void {
    const sprite = this.flashSprite;
    if (!sprite) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.flashes.length; i += 1) {
      const f = this.flashes[i];
      if (f.life <= 0) continue;
      const k = f.life / f.max;
      // Fast pop, slower fall — the shape of a real strobe.
      const a = k > 0.82 ? (1 - k) / 0.18 : k / 0.82;
      const size = f.size * (1.7 - k * 0.7);
      ctx.globalAlpha = a * 0.85;
      ctx.drawImage(sprite, f.x - size / 2, f.y - size / 2, size, size);
    }
    ctx.restore();
  }

  private drawSpotlights(ctx: CanvasRenderingContext2D, timeMs: number): void {
    const warm = this.coneWarm;
    const cool = this.coneCool;
    if (!warm || !cool) return;
    const boost = this.energy * 0.085 + this.flash * 0.5;
    const still = this.quality === 'low';

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.cones.length; i += 1) {
      const c = this.cones[i];
      const sway = still ? 0 : Math.sin(timeMs * 0.00021 + c.phase) * c.sway;
      const sprite = c.warm ? warm : cool;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.base + sway);
      ctx.globalAlpha = clamp01(0.09 + boost) * c.gain;
      ctx.drawImage(
        sprite,
        -CONE_AX * c.scaleX, -CONE_AY * c.scaleY,
        sprite.width * c.scaleX, sprite.height * c.scaleY,
      );
      ctx.restore();
    }

    // Lamp bloom sits at the apex, unrotated.
    const glow = this.flashSprite;
    if (glow) {
      ctx.globalAlpha = clamp01(0.16 + boost * 0.9);
      for (let i = 0; i < this.cones.length; i += 1) {
        const c = this.cones[i];
        const s = 96;
        ctx.drawImage(glow, c.x - s / 2, c.y - s / 2, s, s);
      }
    }
    ctx.restore();
  }

  private drawHaze(ctx: CanvasRenderingContext2D, timeMs: number): void {
    const sprite = this.hazeSprite;
    if (!sprite) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.haze.length; i += 1) {
      const b = this.haze[i];
      const w = sprite.width * b.scaleX;
      const h = sprite.height * b.scaleY;
      const x = 800 + Math.sin(timeMs * b.speed + b.phase) * b.travel;
      ctx.globalAlpha = b.alpha * (0.55 + this.energy * 0.55);
      ctx.drawImage(sprite, x - w / 2, b.y - h / 2, w, h);
    }
    ctx.restore();
  }

  /**
   * Gradients painted on the live context are tied to that context, so they are
   * rebuilt only when the target context changes (canvas resize / re-mount).
   */
  private ensureGradients(ctx: CanvasRenderingContext2D): LiveGradients {
    const cached = this.gradients;
    if (cached && this.gradientOwner === ctx) return cached;

    const vignette = ctx.createRadialGradient(800, 430, 300, 800, 470, 1080);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(0.52, 'rgba(0,0,0,0.16)');
    vignette.addColorStop(0.8, 'rgba(0,0,0,0.44)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.78)');

    const wash = ctx.createLinearGradient(0, 0, 0, H);
    wash.addColorStop(0, 'rgba(255,246,226,0.55)');
    wash.addColorStop(0.42, 'rgba(226,236,255,0.22)');
    wash.addColorStop(0.86, 'rgba(180,205,255,0.03)');
    wash.addColorStop(1, 'rgba(160,190,255,0)');

    const made: LiveGradients = { vignette, wash };
    this.gradients = made;
    this.gradientOwner = ctx;
    return made;
  }

  // ------------------------------------------------------------- static bakes

  private ensureBuilt(): void {
    if (this.built || typeof document === 'undefined') return;
    this.built = true;
    this.buildSprites();
    this.buildBackground();
    this.buildCrowd();
    this.buildRing();
    this.buildForeground();
  }

  private buildSprites(): void {
    const flash = makeLayer(64, 64);
    if (flash) {
      const c = flash.ctx;
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.16, 'rgba(255,251,240,0.72)');
      g.addColorStop(0.45, 'rgba(210,226,255,0.18)');
      g.addColorStop(1, 'rgba(160,190,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      // Faint cross flare so a strobe reads as a lens hit, not a dot.
      c.globalCompositeOperation = 'lighter';
      c.filter = 'blur(1.5px)';
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(6, 32); c.lineTo(58, 32);
      c.moveTo(32, 10); c.lineTo(32, 54);
      c.stroke();
      c.filter = 'none';
      this.flashSprite = flash.canvas;
    }

    this.coneWarm = this.buildCone('rgb(255,238,208)');
    this.coneCool = this.buildCone('rgb(186,212,255)');

    const haze = makeLayer(420, 120);
    if (haze) {
      const c = haze.ctx;
      c.filter = 'blur(22px)';
      c.fillStyle = 'rgba(190,208,255,0.34)';
      c.beginPath();
      c.ellipse(210, 60, 168, 24, 0, 0, TAU);
      c.fill();
      c.fillStyle = 'rgba(255,236,206,0.16)';
      c.beginPath();
      c.ellipse(150, 66, 96, 15, 0, 0, TAU);
      c.fill();
      c.filter = 'none';
      this.hazeSprite = haze.canvas;
    }
  }

  private buildCone(tint: string): HTMLCanvasElement | null {
    const layer = makeLayer(CONE_W, CONE_H);
    if (!layer) return null;
    const c = layer.ctx;
    const body = tint.slice(4, -1); // "r,g,b"
    const g = c.createRadialGradient(CONE_AX, CONE_AY, 0, CONE_AX, CONE_AY, CONE_H);
    g.addColorStop(0, `rgba(${body},0.62)`);
    g.addColorStop(0.1, `rgba(${body},0.4)`);
    g.addColorStop(0.38, `rgba(${body},0.17)`);
    g.addColorStop(0.72, `rgba(${body},0.05)`);
    g.addColorStop(1, `rgba(${body},0)`);
    // Blur is baked in, so the soft cone edge costs nothing at runtime.
    c.filter = 'blur(18px)';
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(CONE_AX, CONE_AY);
    c.lineTo(CONE_W - 44, CONE_H - 24);
    c.lineTo(44, CONE_H - 24);
    c.closePath();
    c.fill();
    c.filter = 'none';
    return layer.canvas;
  }

  private buildBackground(): void {
    const layer = makeLayer(W, H);
    if (!layer) return;
    const c = layer.ctx;

    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#02030a');
    sky.addColorStop(0.3, '#05060f');
    sky.addColorStop(0.6, '#0b0b16');
    sky.addColorStop(0.82, '#16131f');
    sky.addColorStop(1, '#0a0910');
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);

    this.buildArchitecture(c);
    this.buildBanners(c);

    // Ringside floor, so the strip either side of the platform reads as ground.
    const floor = c.createLinearGradient(0, 600, 0, H);
    floor.addColorStop(0, 'rgba(4,5,11,0)');
    floor.addColorStop(0.28, 'rgba(4,5,11,0.72)');
    floor.addColorStop(0.6, '#04050a');
    floor.addColorStop(1, '#020307');
    c.fillStyle = floor;
    c.fillRect(0, 600, W, H - 600);

    // Big soft pool of light hanging over the ring, painted last so it lifts
    // the architecture and the floor together instead of sitting under them.
    const pool = c.createRadialGradient(800, 250, 40, 800, 300, 880);
    pool.addColorStop(0, 'rgba(198,214,255,0.14)');
    pool.addColorStop(0.34, 'rgba(150,172,228,0.07)');
    pool.addColorStop(1, 'rgba(120,140,200,0)');
    c.fillStyle = pool;
    c.fillRect(0, 0, W, H);

    const warm = c.createRadialGradient(800, 176, 20, 800, 210, 440);
    warm.addColorStop(0, 'rgba(255,236,204,0.11)');
    warm.addColorStop(1, 'rgba(255,220,170,0)');
    c.fillStyle = warm;
    c.fillRect(0, 0, W, H);

    this.bgLayer = layer.canvas;
  }

  private buildArchitecture(c: CanvasRenderingContext2D): void {
    // Roof void and the lighting truss spanning it.
    c.fillStyle = '#06070e';
    c.fillRect(0, 0, W, 128);

    c.fillStyle = '#0a0c15';
    c.fillRect(0, 92, W, 36);
    c.strokeStyle = 'rgba(150,175,225,0.09)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = -40; x < W + 40; x += 96) {
      c.moveTo(x, 93);
      c.lineTo(x + 48, 127);
      c.moveTo(x + 48, 93);
      c.lineTo(x, 127);
    }
    c.stroke();
    c.strokeStyle = 'rgba(200,220,255,0.10)';
    c.beginPath();
    c.moveTo(0, 92.5);
    c.lineTo(W, 92.5);
    c.stroke();

    // Hanging speaker stacks — angular blocks with faint edge lighting.
    const stacks = [118, 386, 1214, 1482];
    for (let i = 0; i < stacks.length; i += 1) {
      const x = stacks[i];
      const w = 58;
      const top = 128;
      const h = 96;
      c.fillStyle = '#080a12';
      c.beginPath();
      c.moveTo(x - w / 2, top);
      c.lineTo(x + w / 2, top);
      c.lineTo(x + w / 2 - 7, top + h);
      c.lineTo(x - w / 2 + 7, top + h);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(160,185,235,0.11)';
      c.lineWidth = 1;
      c.stroke();
      c.strokeStyle = 'rgba(120,150,210,0.08)';
      for (let s = 0; s < 4; s += 1) {
        const sy = top + 16 + s * 19;
        c.beginPath();
        c.moveTo(x - w / 2 + 9, sy);
        c.lineTo(x + w / 2 - 9, sy);
        c.stroke();
      }
    }

    // Seating bowl backing. Everything the crowd sits against is dark enough
    // that a 3px bob gap can never flash the sky through.
    const bowl = c.createLinearGradient(0, 200, 0, 700);
    bowl.addColorStop(0, '#0a0c15');
    bowl.addColorStop(0.5, '#08090f');
    bowl.addColorStop(1, '#05060b');
    c.fillStyle = bowl;
    c.fillRect(0, 190, W, 470);

    // Tier fascias. The bowl wraps the ring, so each band lifts at the edges.
    const tiers = [
      { y: 246, h: 26, lift: 44, a: '#12151f', b: '#080a11', accent: PALETTE.counter },
      { y: 374, h: 30, lift: 62, a: '#101420', b: '#070910', accent: PALETTE.player },
      { y: 522, h: 34, lift: 84, a: '#0d1119', b: '#05070c', accent: PALETTE.enemy },
    ];
    for (let i = 0; i < tiers.length; i += 1) {
      const t = tiers[i];
      const top = t.y - t.lift;
      const ctrl = t.y + t.lift;
      const g = c.createLinearGradient(0, top, 0, ctrl + t.h);
      g.addColorStop(0, t.a);
      g.addColorStop(1, t.b);
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(0, top);
      c.quadraticCurveTo(800, ctrl, W, top);
      c.lineTo(W, top + t.h);
      c.quadraticCurveTo(800, ctrl + t.h, 0, top + t.h);
      c.closePath();
      c.fill();

      c.strokeStyle = 'rgba(162,186,236,0.12)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(0, top);
      c.quadraticCurveTo(800, ctrl, W, top);
      c.stroke();

      c.strokeStyle = rgba(t.accent, 0.07);
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(0, top + t.h - 1);
      c.quadraticCurveTo(800, ctrl + t.h - 1, W, top + t.h - 1);
      c.stroke();
    }

    // Aisles fan toward the ring, which sells the bowl geometry cheaply.
    c.strokeStyle = 'rgba(140,165,215,0.045)';
    c.lineWidth = 7;
    for (let x = 84; x < W; x += 214) {
      const bottom = lerp(x, 800, 0.14);
      c.beginPath();
      c.moveTo(x, 236);
      c.lineTo(bottom, 646);
      c.stroke();
    }

    // Vomitory tunnels with a hint of corridor light behind them.
    const tunnels = [402, 1198];
    for (let i = 0; i < tunnels.length; i += 1) {
      const x = tunnels[i];
      const y = 430;
      c.fillStyle = '#030408';
      c.beginPath();
      c.moveTo(x - 62, y + 46);
      c.lineTo(x - 62, y - 8);
      c.quadraticCurveTo(x, y - 54, x + 62, y - 8);
      c.lineTo(x + 62, y + 46);
      c.closePath();
      c.fill();
      const glow = c.createRadialGradient(x, y + 20, 4, x, y + 20, 70);
      glow.addColorStop(0, 'rgba(255,206,150,0.10)');
      glow.addColorStop(1, 'rgba(255,180,110,0)');
      c.fillStyle = glow;
      c.fill();
      c.strokeStyle = 'rgba(160,185,235,0.09)';
      c.lineWidth = 1.4;
      c.stroke();
    }

    // Lamp housings at the top of each spotlight cone.
    for (let i = 0; i < SPOT_X.length; i += 1) {
      const x = SPOT_X[i];
      c.fillStyle = '#0b0d16';
      c.beginPath();
      c.moveTo(x - 30, SPOT_Y - 34);
      c.lineTo(x + 30, SPOT_Y - 34);
      c.lineTo(x + 20, SPOT_Y + 4);
      c.lineTo(x - 20, SPOT_Y + 4);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(170,195,240,0.14)';
      c.lineWidth = 1;
      c.stroke();
      c.fillStyle = 'rgba(255,242,214,0.5)';
      c.beginPath();
      c.ellipse(x, SPOT_Y + 3, 17, 5, 0, 0, TAU);
      c.fill();
    }
  }

  private buildBanners(c: CanvasRenderingContext2D): void {
    const banners = [
      { x: 248, top: 128, bottom: 322, w: 152, accent: PALETTE.player },
      { x: 1352, top: 128, bottom: 322, w: 152, accent: PALETTE.enemy },
    ];
    for (let i = 0; i < banners.length; i += 1) {
      const b = banners[i];
      const halfTop = b.w / 2;
      const halfBot = b.w / 2 + 9;

      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(b.x - halfTop + 8, b.top + 8, b.w, b.bottom - b.top);

      const g = c.createLinearGradient(0, b.top, 0, b.bottom);
      g.addColorStop(0, '#0c0f1a');
      g.addColorStop(1, '#070911');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(b.x - halfTop, b.top);
      c.lineTo(b.x + halfTop, b.top);
      c.lineTo(b.x + halfBot, b.bottom);
      c.lineTo(b.x - halfBot, b.bottom);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(190,210,255,0.09)';
      c.lineWidth = 1.2;
      c.stroke();

      c.fillStyle = rgba(b.accent, 0.16);
      c.fillRect(b.x - halfTop + 10, b.top + 12, 4, b.bottom - b.top - 26);

      // Abstract chevron stack — an emblem, not a logo.
      c.strokeStyle = rgba(b.accent, 0.13);
      c.lineWidth = 5;
      c.lineJoin = 'round';
      for (let k = 0; k < 3; k += 1) {
        const y = b.top + 74 + k * 34;
        c.beginPath();
        c.moveTo(b.x - 34, y);
        c.lineTo(b.x, y + 24);
        c.lineTo(b.x + 34, y);
        c.stroke();
      }
      c.strokeStyle = 'rgba(220,230,255,0.05)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(b.x - halfBot + 6, b.bottom - 22);
      c.lineTo(b.x + halfBot - 6, b.bottom - 22);
      c.stroke();
    }
  }

  /**
   * Crowd rows are baked into one canvas as isolated bands. Each band is blitted
   * separately so rows can bob independently, and because they are isolated the
   * silhouettes are free to overlap in the destination the way real rows do.
   */
  private buildCrowd(): void {
    const rng = new Rng(0x51a7c3);
    const radii: number[] = [];
    const bases: number[] = [];
    const bands: number[] = [];
    let total = 0;

    for (let i = 0; i < CROWD_ROWS; i += 1) {
      const t = i / (CROWD_ROWS - 1);
      radii.push(lerp(5.2, 13.6, t * t * 0.55 + t * 0.45));
      bases.push(292 + 348 * Math.pow(t, 1.26));
      const bandH = Math.ceil(radii[i] * 5.6) + 6;
      bands.push(bandH);
      total += bandH;
    }

    const layer = makeLayer(CROWD_W, total);
    if (!layer) return;
    const c = layer.ctx;

    let sy = 0;
    for (let i = 0; i < CROWD_ROWS; i += 1) {
      const t = i / (CROWD_ROWS - 1);
      const r = radii[i];
      const bandH = bands[i];
      const localBase = bandH - r * 2.4;

      const step = r * 2.55;
      for (let x = -r * 3; x < CROWD_W + r * 3; x += step) {
        const rr = r * rng.range(0.84, 1.16);
        const cx = x + rng.range(-r * 0.45, r * 0.45);
        const by = sy + localBase + rng.range(-r * 0.3, r * 0.3);

        // Rows recede into haze: far rows lift toward the bowl's blue-grey,
        // near rows sink to near-black so the fighters keep the contrast.
        const cr = Math.round(clamp(lerp(31, 6, t) + rng.range(-5, 6), 0, 255));
        const cg = Math.round(clamp(lerp(37, 8, t) + rng.range(-5, 6), 0, 255));
        const cb = Math.round(clamp(lerp(55, 15, t) + rng.range(-6, 7), 0, 255));
        c.fillStyle = `rgb(${cr},${cg},${cb})`;

        c.beginPath();
        c.moveTo(cx - rr * 2.5, by + rr * 2.2);
        c.quadraticCurveTo(cx - rr * 2.3, by - rr * 0.9, cx - rr * 1.05, by - rr * 1.15);
        c.quadraticCurveTo(cx, by - rr * 1.55, cx + rr * 1.05, by - rr * 1.15);
        c.quadraticCurveTo(cx + rr * 2.3, by - rr * 0.9, cx + rr * 2.5, by + rr * 2.2);
        c.closePath();
        c.fill();

        c.beginPath();
        c.arc(cx, by - rr * 2.05, rr, 0, TAU);
        c.fill();

        if (rng.chance(0.14)) {
          c.strokeStyle = `rgb(${cr},${cg},${cb})`;
          c.lineWidth = rr * 0.68;
          c.lineCap = 'round';
          c.beginPath();
          c.moveTo(cx - rr * 1.7, by + rr * 0.4);
          c.quadraticCurveTo(cx - rr * 2.5, by - rr * 1.4, cx - rr * 2.1, by - rr * 2.9);
          c.moveTo(cx + rr * 1.7, by + rr * 0.4);
          c.quadraticCurveTo(cx + rr * 2.5, by - rr * 1.4, cx + rr * 2.1, by - rr * 2.9);
          c.stroke();
        }

        if (rng.chance(0.05)) {
          c.strokeStyle = rgba(ACCENTS[rng.int(0, ACCENTS.length - 1)], 0.22);
          c.lineWidth = Math.max(1, rr * 0.2);
          c.beginPath();
          c.arc(cx, by - rr * 2.05, rr * 1.02, Math.PI * 1.12, Math.PI * 1.88);
          c.stroke();
        }
      }

      this.rows.push({
        sy,
        sh: bandH,
        dy: bases[i] - localBase,
        bobAmp: 0.7 + 2.7 * t,
        bobSpeed: 0.0021 + i * 0.00023,
        phase: i * 1.37,
      });
      sy += bandH;
    }

    this.crowdLayer = layer.canvas;
  }

  private buildRing(): void {
    const layer = makeLayer(W, RING_LAYER_H);
    if (!layer) return;
    const c = layer.ctx;
    // Work in world coordinates; the blit puts the band back where it belongs.
    c.translate(0, -RING_LAYER_Y);

    this.buildRingsideCrowd(c);

    // Shadow cast by the platform onto the arena floor.
    c.save();
    c.translate(800, RING.apronY + 8);
    c.scale(1, 0.075);
    const shadow = c.createRadialGradient(0, 0, 40, 0, 0, 830);
    shadow.addColorStop(0, 'rgba(0,0,0,0.9)');
    shadow.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = shadow;
    c.fillRect(-900, -900, 1800, 1800);
    c.restore();

    this.buildApron(c);
    this.buildMat(c);

    // Far corner posts and ropes sit behind the fighters.
    ArenaRenderer.post(c, RING.backL, RING.backY, RING.farPostH, RING.farPostW, PALETTE.player, false);
    ArenaRenderer.post(c, RING.backR, RING.backY, RING.farPostH, RING.farPostW, PALETTE.enemy, false);

    for (let i = 0; i < ROPE_F.length; i += 1) {
      const y = RING.backY - RING.farPostH * ROPE_F[i];
      ArenaRenderer.rope(c, RING.backL, RING.backR, y, 3 + (1 - ROPE_F[i]) * 3, 6.5, '#3d3d47', 'rgba(206,220,255,0.20)');
    }
    for (let i = 0; i < ROPE_F.length; i += 1) {
      const y = RING.backY - RING.farPostH * ROPE_F[i];
      ArenaRenderer.wrap(c, RING.backL, y, RING.farPostW + 10, 13, false);
      ArenaRenderer.wrap(c, RING.backR, y, RING.farPostW + 10, 13, false);
    }

    this.ringLayer = layer.canvas;
  }

  /** A few near-black heads at the frame edges so the ring has people at it. */
  private buildRingsideCrowd(c: CanvasRenderingContext2D): void {
    const rng = new Rng(0x2b7d11);
    const spots = [-30, 34, 96, 1504, 1566, 1630];
    for (let i = 0; i < spots.length; i += 1) {
      const r = rng.range(22, 30);
      const x = spots[i] + rng.range(-8, 8);
      const y = rng.range(806, 872);
      c.fillStyle = i % 2 ? '#04050a' : '#050710';
      c.beginPath();
      c.moveTo(x - r * 2.4, y + r * 2.4);
      c.quadraticCurveTo(x - r * 2.2, y - r * 0.8, x - r, y - r * 1.1);
      c.quadraticCurveTo(x, y - r * 1.5, x + r, y - r * 1.1);
      c.quadraticCurveTo(x + r * 2.2, y - r * 0.8, x + r * 2.4, y + r * 2.4);
      c.closePath();
      c.fill();
      c.beginPath();
      c.arc(x, y - r * 2, r, 0, TAU);
      c.fill();
    }
  }

  private buildApron(c: CanvasRenderingContext2D): void {
    const g = c.createLinearGradient(0, RING.frontY, 0, RING.apronY);
    g.addColorStop(0, '#0e1220');
    g.addColorStop(0.45, '#080b14');
    g.addColorStop(1, '#04050b');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(RING.frontL, RING.frontY);
    c.lineTo(RING.frontR, RING.frontY);
    c.lineTo(RING.apronR, RING.apronY);
    c.lineTo(RING.apronL, RING.apronY);
    c.closePath();
    c.fill();

    c.save();
    c.clip();

    // Padded panel ribs, kept in perspective by walking both edges together.
    for (let k = 0; k <= 20; k += 1) {
      const t = k / 20;
      const xt = lerp(RING.frontL, RING.frontR, t);
      const xb = lerp(RING.apronL, RING.apronR, t);
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(xt, RING.frontY);
      c.lineTo(xb, RING.apronY);
      c.stroke();
      c.strokeStyle = 'rgba(190,208,255,0.045)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(xt + 2, RING.frontY);
      c.lineTo(xb + 2, RING.apronY);
      c.stroke();
    }

    // Broadcast band across the apron: house colours washing out at the centre.
    const band = c.createLinearGradient(RING.apronL, 0, RING.apronR, 0);
    band.addColorStop(0, rgba(PALETTE.player, 0.2));
    band.addColorStop(0.34, rgba(PALETTE.player, 0.04));
    band.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    band.addColorStop(0.66, rgba(PALETTE.enemy, 0.04));
    band.addColorStop(1, rgba(PALETTE.enemy, 0.2));
    c.fillStyle = band;
    c.beginPath();
    c.moveTo(RING.frontL, RING.frontY + 16);
    c.lineTo(RING.frontR, RING.frontY + 16);
    c.lineTo(lerp(RING.frontR, RING.apronR, 0.42), RING.frontY + 40);
    c.lineTo(lerp(RING.frontL, RING.apronL, 0.42), RING.frontY + 40);
    c.closePath();
    c.fill();
    c.restore();

    // Lit lip where the apron meets the canvas.
    c.strokeStyle = 'rgba(226,238,255,0.16)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(RING.frontL, RING.frontY + 1);
    c.lineTo(RING.frontR, RING.frontY + 1);
    c.stroke();

    // Deep shadow tucked under the platform edge.
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 6;
    c.beginPath();
    c.moveTo(RING.apronL, RING.apronY - 1);
    c.lineTo(RING.apronR, RING.apronY - 1);
    c.stroke();
  }

  private buildMat(c: CanvasRenderingContext2D): void {
    const base = c.createLinearGradient(0, RING.backY, 0, RING.frontY);
    base.addColorStop(0, '#18202f');
    base.addColorStop(0.55, '#141b29');
    base.addColorStop(1, '#0f1421');
    c.fillStyle = base;
    matPath(c);
    c.fill();

    c.save();
    matPath(c);
    c.clip();

    // Where the four cones converge.
    c.save();
    c.translate(800, 726);
    c.scale(1, 0.26);
    const pool = c.createRadialGradient(0, 0, 30, 0, 0, 700);
    pool.addColorStop(0, 'rgba(178,200,255,0.16)');
    pool.addColorStop(0.42, 'rgba(150,175,235,0.07)');
    pool.addColorStop(1, 'rgba(120,150,215,0)');
    c.fillStyle = pool;
    c.fillRect(-800, -800, 1600, 1600);
    c.restore();

    this.buildEmblem(c);

    // Scuffs: sole drag marks and resin smear from previous rounds.
    const rng = new Rng(0x7f3a91);
    c.lineCap = 'round';
    for (let i = 0; i < 240; i += 1) {
      const y = lerp(RING.backY + 6, RING.frontY - 6, Math.sqrt(rng.next()));
      const x = lerp(matL(y) + 12, matR(y) - 12, rng.next());
      const len = rng.range(12, 74);
      const ang = rng.range(-0.2, 0.2);
      c.strokeStyle = rng.chance(0.45) ? 'rgba(226,236,255,0.028)' : 'rgba(0,0,0,0.055)';
      c.lineWidth = rng.range(1, 3.4);
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(x + len * 0.5, y + Math.sin(ang) * len * 0.5, x + len * Math.cos(ang), y + Math.sin(ang) * len);
      c.stroke();
    }

    // Rope shadows falling toward camera.
    c.strokeStyle = 'rgba(0,0,0,0.07)';
    c.lineWidth = 6;
    for (let i = 0; i < 4; i += 1) {
      const y = 654 + i * 19;
      c.beginPath();
      c.moveTo(matL(y) + 30, y);
      c.quadraticCurveTo(800, y + 7, matR(y) - 30, y);
      c.stroke();
    }

    // Mat vignette: bright under the lamps, falling away to the ropes.
    c.save();
    c.translate(800, 742);
    c.scale(1, 0.29);
    const vig = c.createRadialGradient(0, 0, 120, 0, 0, 900);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(0.5, 'rgba(0,0,0,0.14)');
    vig.addColorStop(1, 'rgba(0,0,0,0.62)');
    c.fillStyle = vig;
    c.fillRect(-1000, -1000, 2000, 2000);
    c.restore();

    c.restore();

    // Canvas seam tape just inside the mat edge.
    c.strokeStyle = 'rgba(210,224,255,0.06)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(RING.backL + 16, RING.backY + 9);
    c.lineTo(RING.backR - 16, RING.backY + 9);
    c.lineTo(RING.frontR - 26, RING.frontY - 9);
    c.lineTo(RING.frontL + 26, RING.frontY - 9);
    c.closePath();
    c.stroke();

    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = 2;
    matPath(c);
    c.stroke();
  }

  /** Original house mark: twin chevrons inside a ticked ring, flattened to the mat. */
  private buildEmblem(c: CanvasRenderingContext2D): void {
    c.save();
    c.translate(800, 736);
    c.scale(1, 0.3);

    c.strokeStyle = 'rgba(158,178,225,0.10)';
    c.lineWidth = 8;
    c.beginPath();
    c.arc(0, 0, 252, 0, TAU);
    c.stroke();

    c.strokeStyle = 'rgba(158,178,225,0.06)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(0, 0, 218, 0, TAU);
    c.stroke();

    c.strokeStyle = 'rgba(200,216,255,0.07)';
    c.lineWidth = 5;
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      c.beginPath();
      c.moveTo(ca * 226, sa * 226);
      c.lineTo(ca * 244, sa * 244);
      c.stroke();
    }

    const chevron = (dir: number, colour: string): void => {
      c.fillStyle = rgba(colour, 0.13);
      c.beginPath();
      c.moveTo(dir * 34, -128);
      c.lineTo(dir * 158, 0);
      c.lineTo(dir * 34, 128);
      c.lineTo(dir * 78, 128);
      c.lineTo(dir * 202, 0);
      c.lineTo(dir * 78, -128);
      c.closePath();
      c.fill();
    };
    chevron(-1, PALETTE.player);
    chevron(1, PALETTE.enemy);

    c.strokeStyle = 'rgba(226,236,255,0.09)';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(0, -58);
    c.lineTo(30, 0);
    c.lineTo(0, 58);
    c.lineTo(-30, 0);
    c.closePath();
    c.stroke();
    c.restore();

    // Wordmark, squashed on the same perspective as the emblem.
    c.save();
    c.translate(800, 790);
    c.scale(1, 0.4);
    c.fillStyle = 'rgba(206,220,255,0.075)';
    c.font = '900 34px system-ui, "Segoe UI", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const label = 'HANDSTRIKE';
    const gap = 13;
    let total = -gap;
    for (const ch of label) total += c.measureText(ch).width + gap;
    let x = -total / 2;
    for (const ch of label) {
      const w = c.measureText(ch).width;
      c.fillText(ch, x + w / 2, 0);
      x += w + gap;
    }
    c.restore();
  }

  private buildForeground(): void {
    const layer = makeLayer(W, FG_LAYER_H);
    if (!layer) return;
    const c = layer.ctx;
    c.translate(0, -FG_LAYER_Y);

    // Everything this close to the lens is very slightly out of focus.
    c.filter = 'blur(1.1px)';

    // Near posts run past the mat edge down to the bottom of frame so they
    // genuinely bracket the shot.
    ArenaRenderer.post(c, RING.frontL, H + 6, RING.nearPostH + (H + 6 - RING.frontY), RING.nearPostW, PALETTE.player, true);
    ArenaRenderer.post(c, RING.frontR, H + 6, RING.nearPostH + (H + 6 - RING.frontY), RING.nearPostW, PALETTE.enemy, true);

    for (let i = 0; i < ROPE_F.length; i += 1) {
      const f = ROPE_F[i];
      const y = RING.frontY - RING.nearPostH * f;
      ArenaRenderer.rope(c, RING.frontL, RING.frontR, y, 12 + (1 - f) * 10, 10, '#565149', 'rgba(255,246,226,0.3)');
    }

    // Spacer straps tie the near ropes together, as on a real ring.
    const strapTop = RING.frontY - RING.nearPostH * ROPE_F[ROPE_F.length - 1];
    const strapBottom = RING.frontY - RING.nearPostH * ROPE_F[0];
    const straps = [470, 1130];
    for (let i = 0; i < straps.length; i += 1) {
      const x = straps[i];
      const sagTop = strapTop + 12 + (1 - ROPE_F[ROPE_F.length - 1]) * 10;
      const sagBottom = strapBottom + 12 + (1 - ROPE_F[0]) * 10;
      const g = c.createLinearGradient(x - 5, 0, x + 5, 0);
      g.addColorStop(0, '#141210');
      g.addColorStop(0.42, '#4b463d');
      g.addColorStop(1, '#100e0c');
      c.fillStyle = g;
      roundRectPath(c, x - 5, sagTop - 6, 10, sagBottom - sagTop + 18, 3);
      c.fill();
    }

    for (let i = 0; i < ROPE_F.length; i += 1) {
      const y = RING.frontY - RING.nearPostH * ROPE_F[i];
      ArenaRenderer.wrap(c, RING.frontL, y, RING.nearPostW + 14, 18, true);
      ArenaRenderer.wrap(c, RING.frontR, y, RING.nearPostW + 14, 18, true);
    }

    c.filter = 'none';
    this.fgLayer = layer.canvas;
  }

  // ---------------------------------------------------------------- ring parts

  /** Padded corner post: shaded cylinder, neon rim, brushed metal cap. */
  private static post(
    c: CanvasRenderingContext2D,
    cx: number, baseY: number, h: number, w: number,
    accent: string, near: boolean,
  ): void {
    const half = w / 2;
    const topY = baseY - h;
    const dark = mixHex(accent, '#04060b', near ? 0.76 : 0.84);
    const mid = mixHex(accent, '#04060b', near ? 0.5 : 0.66);

    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.beginPath();
    c.ellipse(cx, baseY, half * 2.2, half * 0.75, 0, 0, TAU);
    c.fill();

    const g = c.createLinearGradient(cx - half, 0, cx + half, 0);
    g.addColorStop(0, '#03050a');
    g.addColorStop(0.2, dark);
    g.addColorStop(0.44, mid);
    g.addColorStop(0.64, dark);
    g.addColorStop(1, '#020408');
    c.fillStyle = g;
    roundRectPath(c, cx - half, topY, w, h, half * 0.6);
    c.fill();

    c.strokeStyle = rgba(accent, near ? 0.32 : 0.2);
    c.lineWidth = near ? 2.2 : 1.4;
    c.beginPath();
    c.moveTo(cx - half + 3, topY + half);
    c.lineTo(cx - half + 3, baseY - half * 0.6);
    c.stroke();

    c.strokeStyle = 'rgba(255,255,255,0.09)';
    c.lineWidth = near ? 2 : 1.2;
    c.beginPath();
    c.moveTo(cx + half * 0.1, topY + half);
    c.lineTo(cx + half * 0.1, baseY - half * 0.6);
    c.stroke();

    // Metal cap.
    const capH = near ? 20 : 14;
    const capW = w + (near ? 10 : 6);
    const cg = c.createLinearGradient(cx - capW / 2, 0, cx + capW / 2, 0);
    cg.addColorStop(0, '#1b2030');
    cg.addColorStop(0.3, '#6b7489');
    cg.addColorStop(0.5, '#98a2b8');
    cg.addColorStop(0.72, '#4b5365');
    cg.addColorStop(1, '#161a26');
    c.fillStyle = cg;
    roundRectPath(c, cx - capW / 2, topY - capH, capW, capH + 6, 4);
    c.fill();
    c.fillStyle = 'rgba(190,204,230,0.55)';
    c.beginPath();
    c.ellipse(cx, topY - capH, capW / 2, capW / 6, 0, 0, TAU);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.beginPath();
    c.ellipse(cx - capW * 0.12, topY - capH - 1, capW / 5, capW / 14, 0, 0, TAU);
    c.fill();
  }

  private static rope(
    c: CanvasRenderingContext2D,
    x0: number, x1: number, y: number, sag: number, width: number,
    core: string, highlight: string,
  ): void {
    c.lineCap = 'round';

    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = width;
    ropePath(c, x0, x1, y, sag, width * 0.32);
    c.stroke();

    c.strokeStyle = core;
    c.lineWidth = width;
    ropePath(c, x0, x1, y, sag, 0);
    c.stroke();

    c.strokeStyle = highlight;
    c.lineWidth = width * 0.3;
    ropePath(c, x0, x1, y, sag, -width * 0.3);
    c.stroke();
  }

  /** Turnbuckle tape where a rope terminates at the post. */
  private static wrap(
    c: CanvasRenderingContext2D,
    cx: number, y: number, w: number, h: number, bright: boolean,
  ): void {
    const g = c.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    g.addColorStop(0, '#141210');
    g.addColorStop(0.38, bright ? '#6f6858' : '#4a463c');
    g.addColorStop(0.6, bright ? '#514b3f' : '#37342c');
    g.addColorStop(1, '#0f0d0b');
    c.fillStyle = g;
    roundRectPath(c, cx - w / 2, y - h / 2, w, h, 4);
    c.fill();

    c.strokeStyle = 'rgba(0,0,0,0.42)';
    c.lineWidth = 1;
    for (let i = 1; i < 3; i += 1) {
      const ly = y - h / 2 + (h / 3) * i;
      c.beginPath();
      c.moveTo(cx - w / 2 + 2, ly);
      c.lineTo(cx + w / 2 - 2, ly);
      c.stroke();
    }
  }
}

export const arena = new ArenaRenderer();
