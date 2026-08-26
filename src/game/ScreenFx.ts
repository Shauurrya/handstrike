/**
 * Camera and full-screen impact effects: shake, hit-stop, slow motion, punch-in
 * zoom, colour flashes and floating combat text.
 *
 * Everything here runs on REAL time. The simulation asks `update()` for its time
 * scale each frame, which means a freeze can never wedge the fight — the timers
 * that unfreeze it keep ticking regardless of what the game clock is doing.
 */

import { FEEL, PALETTE } from '@/config/gameConfig';
import { clamp, clamp01, easeBack, easeOutQuad } from '@/utils/math';

export interface FloatingTextSpec {
  text: string;
  x: number;
  y: number;
  color?: string;
  size?: number;
  weight?: number;
  life?: number;
  vy?: number;
  shadow?: string;
}

interface TextItem {
  text: string;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  weight: number;
  shadow: string | null;
}

interface Flash {
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
}

const DISPLAY_FONT = "'Barlow Condensed', 'Chakra Petch', system-ui, sans-serif";

const TEXT_POOL = 28;
const FLASH_POOL = 6;
const SPEED_LINES = 34;

/** Scale pop duration on a new floating text. */
const POP_MS = 150;

const makeText = (): TextItem => ({
  text: '',
  x: 0, y: 0, vy: 0,
  life: 0, maxLife: 1,
  color: PALETTE.ink,
  size: 42,
  weight: 700,
  shadow: null,
});

export class ScreenFx {
  private enabled = true;
  private reduced = false;

  private mag = 0;
  private phase = 0;
  private sx = 0;
  private sy = 0;
  /** Real elapsed ms, drives the shake oscillators and speed-line drift. */
  private time = 0;

  private stopMs = 0;
  private slowMs = 0;
  private slowMax = 1;
  private slowScale = 1;

  private zoomAmt = 0;
  private zoomMs = 0;
  private zoomMax = 1;
  private zoomValue = 0;

  private readonly texts: TextItem[] = [];
  private textCount = 0;
  private readonly flashes: Flash[] = [];
  private flashCount = 0;
  private readonly lineAngles: number[] = [];

  constructor() {
    for (let i = 0; i < TEXT_POOL; i += 1) this.texts.push(makeText());
    for (let i = 0; i < FLASH_POOL; i += 1) {
      this.flashes.push({ color: '#ffffff', alpha: 0, life: 0, maxLife: 1 });
    }
    // Fixed irregular spacing: evenly spaced lines read as a printed sunburst,
    // slightly uneven ones read as motion.
    for (let i = 0; i < SPEED_LINES; i += 1) {
      const t = i / SPEED_LINES;
      this.lineAngles.push(t * Math.PI * 2 + Math.sin(i * 12.9898) * 0.06);
    }
  }

  setEnabled(shake: boolean): void {
    this.enabled = shake;
    if (!shake) this.killCamera();
  }

  setReducedMotion(v: boolean): void {
    this.reduced = v;
    if (v) {
      this.killCamera();
      this.slowMs = 0;
    }
  }

  /** Shake and zoom are the two motion-sickness offenders — drop both at once. */
  private killCamera(): void {
    this.mag = 0;
    this.sx = 0;
    this.sy = 0;
    this.zoomAmt = 0;
    this.zoomMs = 0;
    this.zoomValue = 0;
  }

  shake(magnitude: number): void {
    if (!this.enabled || this.reduced || magnitude <= 0) return;
    // Mostly "take the biggest hit" with a little stacking, so a jab flurry adds
    // texture without compounding into unreadable noise.
    this.mag = clamp(Math.max(this.mag, magnitude) + magnitude * 0.22, 0, FEEL.maxShake);
    // Re-seed the phase so consecutive kicks travel in different directions.
    this.phase += 1.732;
  }

  flash(color: string, alpha: number, ms: number): void {
    if (alpha <= 0 || ms <= 0) return;
    let slot = this.flashCount < FLASH_POOL ? this.flashCount : 0;
    if (this.flashCount < FLASH_POOL) this.flashCount += 1;
    else {
      // Overwrite whichever flash is closest to finishing.
      for (let i = 1; i < FLASH_POOL; i += 1) {
        if (this.flashes[i].life < this.flashes[slot].life) slot = i;
      }
    }
    const f = this.flashes[slot];
    f.color = color;
    f.alpha = clamp01(alpha);
    f.maxLife = ms;
    f.life = ms;
  }

  hitStop(ms: number): void {
    if (ms <= 0) return;
    this.stopMs = Math.max(this.stopMs, Math.min(ms, 400));
  }

  slowMo(ms: number, scale: number = FEEL.slowMoScale): void {
    if (this.reduced || ms <= 0) return;
    this.slowMs = Math.max(this.slowMs, ms);
    this.slowMax = Math.max(this.slowMax, this.slowMs);
    this.slowScale = clamp(scale, 0.05, 1);
  }

  zoom(amount: number, ms: number): void {
    if (!this.enabled || this.reduced || amount === 0 || ms <= 0) return;
    this.zoomAmt = clamp(Math.max(this.zoomAmt, amount), -0.4, 0.4);
    this.zoomMs = Math.max(this.zoomMs, ms);
    this.zoomMax = Math.max(1, this.zoomMs);
  }

  text(spec: FloatingTextSpec): void {
    let slot = this.textCount;
    if (this.textCount < TEXT_POOL) this.textCount += 1;
    else {
      slot = 0;
      for (let i = 1; i < TEXT_POOL; i += 1) {
        if (this.texts[i].life < this.texts[slot].life) slot = i;
      }
    }
    const t = this.texts[slot];
    t.text = spec.text;
    t.x = spec.x;
    t.y = spec.y;
    t.vy = spec.vy ?? -110;
    t.maxLife = Math.max(60, spec.life ?? 900);
    t.life = t.maxLife;
    t.color = spec.color ?? PALETTE.ink;
    t.size = spec.size ?? 42;
    t.weight = spec.weight ?? 700;
    t.shadow = spec.shadow ?? null;
  }

  /** Advance effects with REAL dt, and return the SIMULATION time scale. */
  update(dtMs: number): number {
    const ms = clamp(dtMs, 0, 100);
    this.time += ms;

    if (this.stopMs > 0) this.stopMs = Math.max(0, this.stopMs - ms);
    if (this.slowMs > 0) {
      this.slowMs = Math.max(0, this.slowMs - ms);
      if (this.slowMs === 0) this.slowMax = 1;
    }

    // Frame-rate independent exponential decay of the shake envelope.
    if (this.mag > 0.01) {
      this.mag *= Math.exp(-FEEL.shakeDecay * (ms / 1000));
      if (this.mag < 0.01) this.mag = 0;
    }
    if (this.mag > 0) {
      const t = this.time / 1000;
      // Two out-of-phase oscillators per axis: a fast kick riding a slower sway,
      // which reads as a camera being punched rather than as random static.
      this.sx = this.mag * (Math.sin(t * 57.3 + this.phase) * 0.72 + Math.sin(t * 23.1 + this.phase * 1.7) * 0.28);
      this.sy = this.mag * (Math.cos(t * 43.7 + this.phase * 0.6) * 0.62 + Math.sin(t * 89.5 + this.phase) * 0.26);
    } else {
      this.sx = 0;
      this.sy = 0;
    }

    if (this.zoomMs > 0) {
      this.zoomMs = Math.max(0, this.zoomMs - ms);
      const k = this.zoomMs / this.zoomMax;
      // Snap in over the first quarter, ease back out over the rest.
      const shape = k > 0.75 ? 1 - (k - 0.75) / 0.25 : easeOutQuad(k / 0.75);
      this.zoomValue = this.zoomAmt * shape;
      if (this.zoomMs === 0) {
        this.zoomAmt = 0;
        this.zoomValue = 0;
      }
    }

    this.updateTexts(ms);
    this.updateFlashes(ms);

    if (this.stopMs > 0) return 0;
    return this.slowMs > 0 && !this.reduced ? this.slowScale : 1;
  }

  private updateTexts(ms: number): void {
    const dt = ms / 1000;
    for (let i = 0; i < this.textCount; i += 1) {
      const t = this.texts[i];
      t.life -= ms;
      if (t.life <= 0) {
        this.textCount -= 1;
        if (i !== this.textCount) {
          this.texts[i] = this.texts[this.textCount];
          this.texts[this.textCount] = t;
        }
        i -= 1;
        continue;
      }
      t.y += t.vy * dt;
      // Decelerate as it rises so the text settles where the eye can read it.
      t.vy *= Math.exp(-2.4 * dt);
    }
  }

  private updateFlashes(ms: number): void {
    for (let i = 0; i < this.flashCount; i += 1) {
      const f = this.flashes[i];
      f.life -= ms;
      if (f.life <= 0) {
        this.flashCount -= 1;
        if (i !== this.flashCount) {
          this.flashes[i] = this.flashes[this.flashCount];
          this.flashes[this.flashCount] = f;
        }
        i -= 1;
      }
    }
  }

  get frozen(): boolean {
    return this.stopMs > 0;
  }

  get shakeX(): number {
    return this.sx;
  }

  get shakeY(): number {
    return this.sy;
  }

  /** Apply shake + zoom. The caller owns save()/restore() around this. */
  applyCamera(ctx: CanvasRenderingContext2D, worldW: number, worldH: number): void {
    if (this.sx !== 0 || this.sy !== 0) ctx.translate(this.sx, this.sy);
    if (this.zoomValue !== 0) {
      const z = 1 + this.zoomValue;
      const cx = worldW * 0.5;
      const cy = worldH * 0.55; // bias low: the action sits below centre
      ctx.translate(cx, cy);
      ctx.scale(z, z);
      ctx.translate(-cx, -cy);
    }
  }

  /** World space — called inside the camera transform. */
  drawTexts(ctx: CanvasRenderingContext2D): void {
    if (this.textCount === 0) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    for (let i = 0; i < this.textCount; i += 1) {
      const t = this.texts[i];
      const age = t.maxLife - t.life;
      // easeBack overshoots past 1 then settles — the pop that sells a hit.
      const pop = age < POP_MS ? easeBack(clamp01(age / POP_MS)) : 1;
      const fade = clamp01(t.life / (t.maxLife * 0.42));
      const size = t.size * pop;

      ctx.globalAlpha = fade;
      ctx.font = `${t.weight} ${size.toFixed(1)}px ${DISPLAY_FONT}`;

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(3, size * 0.15);
      ctx.strokeStyle = 'rgba(4,5,12,0.9)';
      ctx.strokeText(t.text, t.x, t.y);

      if (t.shadow) {
        ctx.shadowColor = t.shadow;
        ctx.shadowBlur = size * 0.55;
      }
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }

    ctx.restore();
  }

  /** Screen space — flashes and slow-mo speed lines. */
  drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.flashCount > 0) {
      ctx.save();
      for (let i = 0; i < this.flashCount; i += 1) {
        const f = this.flashes[i];
        const a = f.alpha * easeOutQuad(clamp01(f.life / f.maxLife));
        if (a <= 0.002) continue;
        // Faint flashes bloom (additive); heavy ones need to actually cover the
        // frame, which only normal blending can do.
        ctx.globalCompositeOperation = a >= 0.5 ? 'source-over' : 'lighter';
        ctx.globalAlpha = a;
        ctx.fillStyle = f.color;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    }

    if (this.reduced || this.slowMs <= 0) return;
    const k = this.slowMs / this.slowMax;
    const inten = Math.min(1, k * 4) * Math.min(1, (1 - k) * 9);
    if (inten <= 0.01) return;

    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR = Math.hypot(w, h) * 0.5;
    // One gradient shared by every line: it fades them all out towards the
    // centre so the middle of the frame stays readable.
    const g = ctx.createRadialGradient(cx, cy, maxR * 0.34, cx, cy, maxR);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.6)');

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = inten * 0.3;
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < SPEED_LINES; i += 1) {
      const drift = Math.sin(this.time * 0.004 + i * 1.7) * 0.03;
      const ang = this.lineAngles[i] + drift;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const inner = maxR * (0.4 + 0.16 * Math.sin(i * 2.3 + this.time * 0.005));
      ctx.moveTo(cx + c * inner, cy + s * inner);
      ctx.lineTo(cx + c * maxR * 1.05, cy + s * maxR * 1.05);
    }
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
  }

  clear(): void {
    this.killCamera();
    this.stopMs = 0;
    this.slowMs = 0;
    this.slowMax = 1;
    this.slowScale = 1;
    this.textCount = 0;
    this.flashCount = 0;
    this.phase = 0;
  }
}
