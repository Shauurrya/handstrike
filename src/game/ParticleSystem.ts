/**
 * Pooled particle system — the visual half of punch impact.
 *
 * Every particle lives in a preallocated pool that is never grown, filtered or
 * spliced: a fight throws hundreds of bursts a minute and per-hit allocation
 * would hand the GC a stutter at exactly the moment the player is watching a
 * knockdown. Dead particles are swap-removed with the last live one, so the
 * live set always occupies [0, active).
 */

import { FEEL } from '@/config/gameConfig';
import { clamp, clamp01, easeOutQuad, Rng } from '@/utils/math';

export type ParticleKind =
  | 'spark'
  | 'sweat'
  | 'dust'
  | 'impact'
  | 'ring'
  | 'shockwave'
  | 'star'
  | 'ember'
  | 'debris';

export interface BurstOptions {
  count?: number;
  color?: string;
  /** 0..1 intensity. A 0-100 STRIKE POWER is accepted and normalised. */
  power?: number;
  dirX?: number;
  dirY?: number;
  /** Cone width in radians around the direction vector. */
  spread?: number;
  speed?: number;
  size?: number;
  gravity?: number;
  life?: number;
}

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** ms remaining. */
  life: number;
  maxLife: number;
  /** Radius for rings, half-length for wedges, dot radius otherwise. */
  size: number;
  /** Size change per second — drives ring expansion. */
  grow: number;
  /** Stroke/wedge thickness. */
  width: number;
  gravity: number;
  /** Exponential velocity damping coefficient, per second. */
  drag: number;
  rot: number;
  spin: number;
  color: string;
  alpha: number;
  additive: boolean;
}

interface KindSpec {
  count: number;
  speed: number;
  spread: number;
  size: number;
  grow: number;
  width: number;
  gravity: number;
  drag: number;
  life: number;
  alpha: number;
  color: string;
  additive: boolean;
}

const TAU = Math.PI * 2;

/** Per-kind physical and visual defaults. Callers override only what differs. */
const KINDS: Record<ParticleKind, KindSpec> = {
  spark: {
    count: 10, speed: 640, spread: Math.PI * 0.85, size: 3.1, grow: -3, width: 0,
    gravity: 980, drag: 3.4, life: 270, alpha: 1, color: '#fff0bf', additive: true,
  },
  sweat: {
    count: 6, speed: 280, spread: 1.35, size: 3.4, grow: 0, width: 0,
    gravity: 1650, drag: 0.55, life: 640, alpha: 0.9, color: '#cfe4ff', additive: false,
  },
  dust: {
    count: 8, speed: 62, spread: TAU, size: 15, grow: 26, width: 0,
    gravity: -46, drag: 1.7, life: 950, alpha: 0.32, color: '#7a809c', additive: false,
  },
  impact: {
    count: 6, speed: 300, spread: TAU, size: 30, grow: 130, width: 7,
    gravity: 0, drag: 7, life: 150, alpha: 1, color: '#ffffff', additive: true,
  },
  ring: {
    count: 1, speed: 0, spread: 0, size: 10, grow: 540, width: 5,
    gravity: 0, drag: 0, life: 380, alpha: 1, color: '#ffffff', additive: true,
  },
  shockwave: {
    count: 1, speed: 0, spread: 0, size: 16, grow: 1500, width: 16,
    gravity: 0, drag: 0, life: 300, alpha: 0.85, color: '#ffffff', additive: true,
  },
  star: {
    count: 4, speed: 230, spread: TAU, size: 13, grow: -6, width: 0,
    gravity: 300, drag: 2.1, life: 540, alpha: 1, color: '#ffd34d', additive: true,
  },
  ember: {
    count: 6, speed: 95, spread: TAU, size: 3.6, grow: -1.6, width: 0,
    gravity: -180, drag: 0.75, life: 1150, alpha: 0.95, color: '#ff6a00', additive: true,
  },
  debris: {
    count: 5, speed: 320, spread: Math.PI * 0.75, size: 5, grow: 0, width: 0,
    gravity: 1500, drag: 1.15, life: 820, alpha: 0.9, color: '#2a3047', additive: false,
  },
};

const QUALITY_SCALE = { low: 0.35, medium: 0.7, high: 1 } as const;

/**
 * HitReport carries STRIKE POWER on a 0-100 scale while the feel code talks in
 * 0..1 intensities. Accept both rather than making every caller remember which.
 */
const normPower = (p: number): number => clamp01(p > 1 ? p / 100 : p);

const makeParticle = (): Particle => ({
  kind: 'spark',
  x: 0, y: 0, vx: 0, vy: 0,
  life: 0, maxLife: 1,
  size: 1, grow: 0, width: 1,
  gravity: 0, drag: 0,
  rot: 0, spin: 0,
  color: '#ffffff', alpha: 1, additive: true,
});

export class ParticleSystem {
  private readonly pool: Particle[];
  private active = 0;
  private qScale = 1;
  private steal = 0;
  /** Private stream so effects never perturb the shared gameplay RNG. */
  private readonly rand = new Rng(0x51f3c7);

  constructor(budget: number = FEEL.particleBudget) {
    const size = Math.max(32, Math.floor(budget));
    this.pool = new Array<Particle>(size);
    for (let i = 0; i < size; i += 1) this.pool[i] = makeParticle();
  }

  setQuality(q: 'low' | 'medium' | 'high'): void {
    this.qScale = QUALITY_SCALE[q];
  }

  private acquire(): Particle {
    if (this.active < this.pool.length) {
      this.active += 1;
      return this.pool[this.active - 1];
    }
    // Budget exhausted. Recycling round-robin keeps the newest, gameplay-critical
    // burst visible instead of dropping it behind stale ambient dust.
    this.steal = (this.steal + 1) % this.pool.length;
    return this.pool[this.steal];
  }

  burst(kind: ParticleKind, x: number, y: number, opts: BurstOptions = {}): void {
    const d = KINDS[kind];
    const power = opts.power === undefined ? 1 : normPower(opts.power);
    const raw = opts.count === undefined ? d.count : opts.count;
    if (raw <= 0) return;

    // Quality scales density only — never speed or size, so low-end machines
    // still get the same read on how hard a punch landed.
    const n = Math.max(1, Math.round(raw * this.qScale));
    const speed = (opts.speed === undefined ? d.speed : opts.speed) * (0.55 + 0.65 * power);
    const size = (opts.size === undefined ? d.size : opts.size) * (0.7 + 0.45 * power);
    const life = opts.life === undefined ? d.life : opts.life;
    const gravity = opts.gravity === undefined ? d.gravity : opts.gravity;
    const spread = opts.spread === undefined ? d.spread : opts.spread;
    const color = opts.color ?? d.color;
    const dirX = opts.dirX === undefined ? 0 : opts.dirX;
    const dirY = opts.dirY === undefined ? -1 : opts.dirY;
    const base = Math.atan2(dirY, dirX);
    const r = this.rand;

    for (let i = 0; i < n; i += 1) {
      const p = this.acquire();
      // Even angular spacing plus jitter reads as a burst; pure random clumps.
      const slot = n > 1 ? (i + r.range(0.1, 0.9)) / n - 0.5 : r.range(-0.5, 0.5);
      const ang = base + slot * spread;
      const sp = speed * r.range(0.55, 1.3);

      p.kind = kind;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.maxLife = Math.max(16, life * r.range(0.78, 1.24));
      p.life = p.maxLife;
      p.size = Math.max(0.4, size * r.range(0.72, 1.3));
      p.grow = d.grow * (0.7 + 0.6 * power);
      p.width = Math.max(0.5, d.width * (0.7 + 0.5 * power));
      p.gravity = gravity;
      p.drag = d.drag;
      p.rot = r.range(0, TAU);
      p.spin = r.range(-9, 9);
      p.color = color;
      p.alpha = d.alpha;
      p.additive = d.additive;
    }
  }

  /** Expanding ring plus the fatter shockwave behind it. */
  impactRing(x: number, y: number, color: string, power: number): void {
    const k = normPower(power);
    this.burst('ring', x, y, { color, power: k, size: 10 + 8 * k, life: 340 + 120 * k });
    if (k > 0.35) {
      this.burst('shockwave', x, y, { color, power: k, size: 14 + 10 * k, life: 260 + 120 * k });
    }
  }

  /** The full punch-landed package. dirX is the direction the punch travels. */
  hitBurst(x: number, y: number, color: string, power: number, dirX: number): void {
    const k = normPower(power);
    const dx = dirX >= 0 ? 1 : -1;

    this.impactRing(x, y, color, k);
    this.burst('impact', x, y, { color: '#ffffff', power: k, count: 5 + Math.round(3 * k) });
    this.burst('spark', x, y, {
      color,
      power: k,
      count: 8 + Math.round(14 * k),
      dirX: dx,
      dirY: -0.38,
      spread: Math.PI * 0.8,
    });
    this.burst('sweat', x, y - 6, {
      power: k,
      count: 3 + Math.round(5 * k),
      dirX: dx,
      dirY: -0.85,
      spread: 1.1,
    });
    // Reserve the gold sparkle for hits that actually deserve a highlight.
    if (k > 0.7) {
      this.burst('star', x, y, { power: k, count: 3 + Math.round(3 * k) });
      this.burst('debris', x, y, { power: k, count: 3, dirX: dx, dirY: -0.5 });
    }
  }

  blockBurst(x: number, y: number, dirX: number): void {
    const dx = dirX >= 0 ? 1 : -1;
    this.burst('spark', x, y, {
      color: '#a8dcff',
      power: 0.55,
      count: 9,
      dirX: -dx,
      dirY: -0.55,
      spread: Math.PI * 0.55,
      speed: 520,
      life: 220,
    });
    this.burst('ring', x, y, { color: '#8ec9ff', power: 0.4, size: 8, life: 240 });
    this.burst('impact', x, y, { color: '#dff1ff', power: 0.35, count: 4, life: 110 });
  }

  dust(x: number, y: number, amount: number): void {
    this.burst('dust', x, y, { count: amount, power: 0.6, speed: 70, dirY: -1, spread: TAU });
  }

  update(dtMs: number): void {
    // A tab-switch can hand us a multi-second dt; a huge step would teleport
    // every particle off screen instead of quietly finishing its life.
    const ms = clamp(dtMs, 0, 100);
    if (ms <= 0 || this.active === 0) return;
    const dt = ms / 1000;

    for (let i = 0; i < this.active; i += 1) {
      const p = this.pool[i];
      p.life -= ms;
      if (p.life <= 0) {
        // Swap-remove: the tail particle takes this slot and we re-test index i.
        this.active -= 1;
        if (i !== this.active) {
          this.pool[i] = this.pool[this.active];
          this.pool[this.active] = p;
        }
        i -= 1;
        continue;
      }
      if (p.drag > 0) {
        const damp = Math.exp(-p.drag * dt);
        p.vx *= damp;
        p.vy *= damp;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size = Math.max(0.2, p.size + p.grow * dt);
      p.rot += p.spin * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.active === 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Two passes so the composite mode flips exactly twice per frame rather
    // than once per particle — state changes are the expensive part here.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.active; i += 1) {
      const p = this.pool[i];
      if (p.additive) this.paint(ctx, p);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < this.active; i += 1) {
      const p = this.pool[i];
      if (!p.additive) this.paint(ctx, p);
    }
    ctx.restore();
  }

  private paint(ctx: CanvasRenderingContext2D, p: Particle): void {
    const t = clamp01(p.life / p.maxLife);
    switch (p.kind) {
      case 'spark':
        this.paintSpark(ctx, p, t);
        break;
      case 'impact':
        this.paintWedge(ctx, p, t);
        break;
      case 'ring':
        this.paintRing(ctx, p, t);
        break;
      case 'shockwave':
        this.paintShockwave(ctx, p, t);
        break;
      case 'star':
        this.paintStar(ctx, p, t);
        break;
      case 'ember':
        this.paintEmber(ctx, p, t);
        break;
      case 'dust':
        this.paintDust(ctx, p, t);
        break;
      case 'sweat':
        this.paintSweat(ctx, p, t);
        break;
      case 'debris':
        this.paintDebris(ctx, p, t);
        break;
      default:
        break;
    }
  }

  private paintSpark(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    const sp = Math.hypot(p.vx, p.vy);
    if (sp < 1e-3) return;
    const nx = p.vx / sp;
    const ny = p.vy / sp;
    const len = clamp(sp * 0.016, p.size * 1.5, p.size * 11);
    const tailX = p.x - nx * len;
    const tailY = p.y - ny * len;

    ctx.globalAlpha = p.alpha * easeOutQuad(t);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.size;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();

    // The white core dies faster than the body, so the streak cools from
    // hot-white into the fighter's colour instead of just dimming.
    ctx.globalAlpha = p.alpha * t * t * t;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = p.size * 0.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - nx * len * 0.6, p.y - ny * len * 0.6);
    ctx.stroke();
  }

  private paintWedge(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    const sp = Math.hypot(p.vx, p.vy);
    const nx = sp > 1e-3 ? p.vx / sp : 1;
    const ny = sp > 1e-3 ? p.vy / sp : 0;
    const w = p.width * t;
    const tipX = p.x + nx * p.size;
    const tipY = p.y + ny * p.size;

    ctx.globalAlpha = p.alpha * t;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(p.x - ny * w, p.y + nx * w);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(p.x + ny * w, p.y - nx * w);
    ctx.closePath();
    ctx.fill();
  }

  private paintRing(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    ctx.globalAlpha = p.alpha * t * t;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(0.6, p.width * t);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.stroke();
  }

  private paintShockwave(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    const r = Math.max(1, p.size);
    const w = Math.max(1.5, p.width * t);
    const g = ctx.createRadialGradient(p.x, p.y, Math.max(0.1, r - w), p.x, p.y, r + w);
    // Transparent black contributes nothing under additive blending, so the
    // band feathers off at both edges instead of showing a hard rim.
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, p.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.globalAlpha = p.alpha * t * t;
    ctx.strokeStyle = g;
    ctx.lineWidth = w * 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.stroke();
  }

  private paintStar(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    const r = p.size * (0.55 + 0.45 * t);
    ctx.globalAlpha = p.alpha * easeOutQuad(t);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.quadraticCurveTo(0, 0, 0, r);
    ctx.quadraticCurveTo(0, 0, -r, 0);
    ctx.quadraticCurveTo(0, 0, 0, -r);
    ctx.fill();
    ctx.globalAlpha = p.alpha * t * t;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private paintEmber(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    // Flicker keyed to the particle's own rotation so embers never pulse in sync.
    const flicker = 0.72 + 0.28 * Math.sin(p.rot * 3.1);
    ctx.globalAlpha = p.alpha * t * t * flicker;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = p.alpha * t * flicker * 0.7;
    ctx.fillStyle = '#ffd9a0';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 0.42, 0, TAU);
    ctx.fill();
  }

  private paintDust(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    // Puffs bloom in over the first slice of life, then fade as they rise.
    const grow = clamp01((1 - t) * 4);
    ctx.globalAlpha = p.alpha * t * grow;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = p.alpha * t * grow * 0.45;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 1.6, 0, TAU);
    ctx.fill();
  }

  private paintSweat(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    ctx.globalAlpha = p.alpha * clamp01(t * 2.2);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(p.vy, p.vx));
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size * 1.7, p.size * 0.72, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = p.alpha * clamp01(t * 2.2) * 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-p.size * 0.4, -p.size * 0.2, p.size * 0.32, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private paintDebris(ctx: CanvasRenderingContext2D, p: Particle, t: number): void {
    ctx.globalAlpha = p.alpha * clamp01(t * 1.8);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size * 0.5, -p.size * 0.38, p.size, p.size * 0.76);
    ctx.restore();
  }

  clear(): void {
    this.active = 0;
  }

  get count(): number {
    return this.active;
  }
}
