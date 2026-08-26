import type { Vec2 } from '@/types/core';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const remap = (v: number, a: number, b: number, c: number, d: number): number => lerp(c, d, invLerp(a, b, v));

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const addVec = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const subVec = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scaleVec = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const lenVec = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distVec = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midVec = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const normalizeVec = (a: Vec2): Vec2 => {
  const l = lenVec(a);
  return l < 1e-6 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

/** Frame-rate independent exponential smoothing factor. */
export const smoothFactor = (halfLifeMs: number, dtMs: number): number =>
  halfLifeMs <= 0 ? 1 : 1 - Math.pow(0.5, dtMs / halfLifeMs);

export const damp = (current: number, target: number, halfLifeMs: number, dtMs: number): number =>
  lerp(current, target, smoothFactor(halfLifeMs, dtMs));

export const dampVec = (current: Vec2, target: Vec2, halfLifeMs: number, dtMs: number): Vec2 => {
  const t = smoothFactor(halfLifeMs, dtMs);
  return { x: lerp(current.x, target.x, t), y: lerp(current.y, target.y, t) };
};

export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeIn = (t: number): number => t * t * t;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeSnap = (t: number): number => 1 - Math.pow(1 - t, 6);
export const easeBack = (t: number): number => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

export const rectsOverlap = (
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

export const pointInRect = (px: number, py: number, x: number, y: number, w: number, h: number): boolean =>
  px >= x && px <= x + w && py >= y && py <= y + h;

/** Overlap area between two rects, used to pick which hurtbox a punch hits. */
export const overlapArea = (
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): number => {
  const ox = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const oy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  return ox > 0 && oy > 0 ? ox * oy : 0;
};

/** Rolling mean over a fixed window. Cheap enough to run per vision frame. */
export class RollingAverage {
  private readonly values: number[] = [];
  private sum = 0;

  constructor(private readonly size: number) {}

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.values.push(v);
    this.sum += v;
    if (this.values.length > this.size) this.sum -= this.values.shift() as number;
  }

  get average(): number {
    return this.values.length ? this.sum / this.values.length : 0;
  }

  get count(): number {
    return this.values.length;
  }

  clear(): void {
    this.values.length = 0;
    this.sum = 0;
  }
}

/** Median of a copied array, robust against the odd bad tracking frame. */
export const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const mean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

/** Small xorshift PRNG so AI decisions are reproducible within a run. */
export class Rng {
  private state: number;

  constructor(seed = 0x2f6e2b1) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.state = s >>> 0;
    return this.state / 0xffffffff;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** Weighted pick over [item, weight] pairs. */
  weighted<T>(entries: [T, number][]): T {
    const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
    if (total <= 0) return entries[0][0];
    let roll = this.next() * total;
    for (const [item, w] of entries) {
      roll -= Math.max(0, w);
      if (roll <= 0) return item;
    }
    return entries[entries.length - 1][0];
  }
}

export const rng = new Rng(Math.floor(Math.random() * 0xffffff) + 1);
