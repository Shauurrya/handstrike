import type { Vec2 } from '@/types/core';
import { clamp, lerp } from './math';

/**
 * One Euro filter, the standard choice for landmark smoothing.
 * It smooths hard while a hand is still (killing jitter) and barely at all while
 * the hand is moving fast, so punches stay responsive instead of being averaged
 * into mush.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private readonly minCutoff = 1.2,
    private readonly beta = 0.02,
    private readonly dCutoff = 1,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (!Number.isFinite(x)) return this.xPrev ?? 0;
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;

    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    this.dxPrev = lerp(this.dxPrev, dx, aD);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = OneEuroFilter.alpha(cutoff, dt);
    this.xPrev = lerp(this.xPrev, x, a);
    return this.xPrev;
  }

  get velocity(): number {
    return this.dxPrev;
  }
}

export class OneEuroVec2 {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(v: Vec2, tMs: number): Vec2 {
    return { x: this.fx.filter(v.x, tMs), y: this.fy.filter(v.y, tMs) };
  }

  get velocity(): Vec2 {
    return { x: this.fx.velocity, y: this.fy.velocity };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}

/**
 * A boolean that must hold true for onMs before it latches, and false for offMs
 * before it releases. Stops guard and duck flickering on noisy frames.
 */
export class Hysteresis {
  private state = false;
  private since = 0;

  constructor(
    private readonly onMs: number,
    private readonly offMs: number,
  ) {}

  update(raw: boolean, tMs: number): boolean {
    if (raw === this.state) {
      this.since = tMs;
      return this.state;
    }
    const needed = raw ? this.onMs : this.offMs;
    if (tMs - this.since >= needed) {
      this.state = raw;
      this.since = tMs;
    }
    return this.state;
  }

  get value(): boolean {
    return this.state;
  }

  reset(): void {
    this.state = false;
    this.since = 0;
  }
}

/** Fixed-length ring buffer of timestamped samples for temporal analysis. */
export class TemporalBuffer<T> {
  private readonly items: { t: number; v: T }[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly maxItems = 120,
  ) {}

  push(v: T, t: number): void {
    this.items.push({ t, v });
    while (this.items.length > this.maxItems) this.items.shift();
    while (this.items.length > 1 && t - this.items[0].t > this.windowMs) this.items.shift();
  }

  get all(): { t: number; v: T }[] {
    return this.items;
  }

  get latest(): { t: number; v: T } | null {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  get oldest(): { t: number; v: T } | null {
    return this.items.length ? this.items[0] : null;
  }

  /** Newest sample at least ageMs old, used for finite-difference velocity. */
  sampleBefore(ageMs: number, now: number): { t: number; v: T } | null {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (now - this.items[i].t >= ageMs) return this.items[i];
    }
    return this.items.length ? this.items[0] : null;
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Move current towards target by at most maxDelta. */
export const approach = (current: number, target: number, maxDelta: number): number => {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
};

/** Exponential decay towards a target, dt in seconds. */
export const decayTowards = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, clamp(1 - Math.exp(-rate * dt), 0, 1));
