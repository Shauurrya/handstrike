import type { Side, Vec2 } from '@/types/core';
import type { CalibrationProfile, DetectConfidence, PunchEvent, PunchKind } from '@/types/vision';
import { VISION } from '@/config/gameConfig';
import { clamp, clamp01, invLerp } from '@/utils/math';
import type { HandSlot, MotionAnalyzer } from './MotionAnalyzer';

/**
 * Detects intentional punches from 2D motion alone.
 *
 * Design constraints that drove this (see the project brief):
 *  - The player must never have to punch *toward the lens*. Everything here is
 *    driven by motion visible in the frame plane.
 *  - A visible fist is not a punch. A punch is a short, fast, committed burst
 *    of motion, so detection is a per-hand temporal state machine, not a
 *    per-frame classifier.
 *  - Reliability beats cleverness. When the classifier cannot confidently name
 *    the punch it still fires a generic straight rather than swallowing the
 *    player's input.
 *
 * Every threshold is expressed in *palm widths per second* or *palm widths*, so
 * the same gesture works close to the camera and far from it.
 */

type Phase = 'idle' | 'burst' | 'cooldown';

interface PathPoint {
  x: number;
  y: number;
  t: number;
}

const MAX_PATH = 24;

/** Apparent palm growth over a burst — a hand coming at you gets bigger in
 *  frame. This is a 2D cue (blob size), not a depth estimate. */
const GROWTH_FULL = 0.22;

class HandDetector {
  private phase: Phase = 'idle';
  private startedAt = 0;
  private endedAt = -1e9;
  private start: Vec2 = { x: 0, y: 0 };
  private startPalm = 0.11;
  private peakSpeed = 0;
  private peakPalm = 0.11;
  private readonly path: PathPoint[] = [];
  private pathLen = 0;
  private lastPoint: PathPoint | null = null;

  constructor(readonly side: Side) {}

  reset(): void {
    this.phase = 'idle';
    this.peakSpeed = 0;
    this.pathLen = 0;
    this.path.length = 0;
    this.lastPoint = null;
    this.endedAt = -1e9;
  }

  get active(): boolean {
    return this.phase === 'burst';
  }

  /** Returns a finished burst's measurements, or null while nothing completed. */
  update(slot: HandSlot, cal: CalibrationProfile, t: number, suppressed: boolean): BurstResult | null {
    const sens = clamp(cal.sensitivity, 0.5, 1.8);
    const startSpeed = cal.punchSpeed * sens;
    const endSpeed = startSpeed * 0.42;

    if (this.phase === 'cooldown') {
      if (t - this.endedAt >= VISION.punchCooldownMs) this.phase = 'idle';
      else return null;
    }

    if (!slot.present) {
      // A hand that vanishes mid-burst cannot be trusted to have completed a
      // punch; drop it rather than inventing a landing position.
      if (this.phase === 'burst' && slot.lostForMs > VISION.handGraceMs) this.reset();
      return null;
    }

    if (this.phase === 'idle') {
      if (suppressed) return null;
      // Require both speed *and* positive acceleration: a hand already coasting
      // (a wave, a reach for the mouse) never crosses this gate cleanly.
      if (slot.speed >= startSpeed && slot.accel > 0) {
        this.phase = 'burst';
        this.startedAt = t;
        this.start = { ...slot.pos };
        this.startPalm = slot.palmSize > 0 ? slot.palmSize : 0.11;
        this.peakSpeed = slot.speed;
        this.peakPalm = this.startPalm;
        this.path.length = 0;
        this.pathLen = 0;
        this.lastPoint = { x: slot.pos.x, y: slot.pos.y, t };
        this.path.push(this.lastPoint);
      }
      return null;
    }

    // --- in a burst -------------------------------------------------------
    const point: PathPoint = { x: slot.pos.x, y: slot.pos.y, t };
    if (this.lastPoint) this.pathLen += Math.hypot(point.x - this.lastPoint.x, point.y - this.lastPoint.y);
    this.lastPoint = point;
    if (this.path.length < MAX_PATH) this.path.push(point);

    if (slot.speed > this.peakSpeed) {
      this.peakSpeed = slot.speed;
      this.peakPalm = slot.palmSize;
    }

    const elapsed = t - this.startedAt;
    const decelerated = slot.speed < Math.max(endSpeed, this.peakSpeed * 0.38);
    const timedOut = elapsed >= VISION.burstMaxMs;

    if (!decelerated && !timedOut) return null;

    const result = this.measure(slot, t, elapsed);
    this.phase = 'cooldown';
    this.endedAt = t;
    return result;
  }

  private measure(slot: HandSlot, t: number, durationMs: number): BurstResult {
    const scale = 1 / Math.max(0.03, slot.palmSize);
    const dx = (slot.pos.x - this.start.x) * scale;
    const dy = (slot.pos.y - this.start.y) * scale;
    const travel = Math.hypot(dx, dy);
    const pathLen = this.pathLen * scale;
    // 1 = a perfectly straight line, lower = a curved arc (a hook).
    const straightness = pathLen > 1e-3 ? clamp01(travel / pathLen) : 1;
    const growth = clamp01((this.peakPalm / Math.max(1e-4, this.startPalm) - 1) / GROWTH_FULL);

    return {
      hand: this.side,
      dx,
      dy,
      travel,
      straightness,
      growth,
      peakSpeed: this.peakSpeed,
      durationMs,
      endPos: { ...slot.pos },
      startPos: { ...this.start },
      at: t,
    };
  }
}

export interface BurstResult {
  hand: Side;
  /** Net displacement in palm widths. +x is the player's right, +y is DOWN. */
  dx: number;
  dy: number;
  travel: number;
  straightness: number;
  growth: number;
  peakSpeed: number;
  durationMs: number;
  endPos: Vec2;
  startPos: Vec2;
  at: number;
}

export interface PunchContext {
  /** True while the guard shell is held — stops raising the hands from
   *  registering as an uppercut. */
  guardHeld: boolean;
  /** True while both hands sit inside the guard zone right now. */
  bothHandsAtFace: boolean;
}

export class PunchDetector {
  private readonly detectors: Record<Side, HandDetector> = {
    left: new HandDetector('left'),
    right: new HandDetector('right'),
  };

  private lastPunchAt = -1e9;
  private nextId = 1;
  private lastResult: { kind: PunchKind; confidence: number; tier: DetectConfidence } | null = null;

  reset(): void {
    this.detectors.left.reset();
    this.detectors.right.reset();
    this.lastPunchAt = -1e9;
    this.lastResult = null;
  }

  get debugConfidence(): number {
    return this.lastResult?.confidence ?? 0;
  }

  /** Runs both hands and returns the punches that completed on this frame. */
  update(
    analyzer: MotionAnalyzer,
    cal: CalibrationProfile,
    t: number,
    ctx: PunchContext,
    out: PunchEvent[],
  ): void {
    const sides: Side[] = ['left', 'right'];
    for (const side of sides) {
      const slot = analyzer.slots[side];
      const burst = this.detectors[side].update(slot, cal, t, ctx.guardHeld);
      if (!burst) continue;

      // A short global gap stops one committed two-handed lunge from firing
      // two punches on the same frame.
      if (t - this.lastPunchAt < VISION.globalPunchCooldownMs) continue;

      const event = this.classify(burst, cal, analyzer, ctx);
      if (!event) continue;

      this.lastPunchAt = t;
      out.push(event);
    }
  }

  /**
   * Turns a completed motion burst into a punch, or rejects it.
   * Returns null for LOW confidence (jitter) — everything else fires.
   */
  private classify(
    b: BurstResult,
    cal: CalibrationProfile,
    analyzer: MotionAnalyzer,
    ctx: PunchContext,
  ): PunchEvent | null {
    const sens = clamp(cal.sensitivity, 0.5, 1.8);
    const minTravel = cal.punchTravel * 0.62 * sens;

    // --- quality gate -----------------------------------------------------
    // Travel and speed together: a fast twitch that goes nowhere is noise, and
    // so is a long slow drift.
    const speedQ = clamp01(invLerp(cal.punchSpeed * sens * 0.9, cal.punchSpeedMax, b.peakSpeed) * 0.85 + 0.15);
    const travelQ = clamp01(invLerp(minTravel * 0.75, cal.punchTravel * 1.9, b.travel));
    const durationQ = b.durationMs < 60 ? 0.35 : clamp01(invLerp(VISION.burstMaxMs * 1.15, 90, b.durationMs) * 0.5 + 0.5);
    const quality = speedQ * 0.5 + travelQ * 0.34 + durationQ * 0.16;

    if (b.travel < minTravel * 0.72 || quality < 0.3) {
      this.lastResult = { kind: 'straight', confidence: quality, tier: 'low' };
      return null;
    }

    // --- classification ---------------------------------------------------
    const up = -b.dy;
    const lateral = Math.abs(b.dx);
    const invTravel = 1 / Math.max(1e-3, b.travel);
    const upness = clamp01(up * invTravel);
    const lateralness = clamp01(lateral * invTravel);
    const curvature = clamp01(1 - b.straightness);
    const longTravel = clamp01(invLerp(cal.punchTravel * 1.1, cal.punchTravel * 2.6, b.travel));

    // Uppercut: dominated by a rising arc with real vertical distance.
    const uppercutScore = up <= 0.15
      ? -1
      : upness * 1.55 + clamp01(invLerp(0.45, 1.4, up)) * 0.55 - lateralness * 0.35;

    // Hook: wide, curved, sideways. Apparent growth argues against it because a
    // hook travels across the frame rather than toward the lens.
    const hookScore = lateralness * 1.15 + curvature * 1.25 + longTravel * 0.45 - b.growth * 0.5 - upness * 0.35;

    // Straight (jab / cross): committed, straight-line motion, often with the
    // fist visibly growing as it comes forward.
    const straightScore =
      b.straightness * 1.05 + b.growth * 1.0 + (1 - lateralness) * 0.45 + (1 - curvature) * 0.35 - upness * 0.3;

    let kind: PunchKind = 'straight';
    let top = straightScore;
    let second = Math.max(hookScore, uppercutScore);
    if (hookScore > top) {
      second = Math.max(top, uppercutScore);
      top = hookScore;
      kind = 'hook';
    }
    if (uppercutScore > top) {
      second = Math.max(hookScore, straightScore);
      top = uppercutScore;
      kind = 'uppercut';
    }

    // Raising both hands into the shell must never read as a double uppercut.
    if (kind === 'uppercut' && (ctx.bothHandsAtFace || ctx.guardHeld)) {
      kind = 'straight';
    }

    const separation = clamp01((top - second) / 0.7);
    const classConfidence = clamp01(0.45 + separation * 0.55);
    const confidence = clamp01(quality * 0.62 + classConfidence * 0.38);

    let tier: DetectConfidence;
    if (confidence >= 0.66) tier = 'high';
    else if (confidence >= 0.36) tier = 'medium';
    else tier = 'low';

    if (tier === 'low') {
      this.lastResult = { kind, confidence, tier };
      return null;
    }

    // MEDIUM confidence still fires — it just falls back to the generic
    // straight for that hand instead of guessing a hook or an uppercut.
    if (tier === 'medium') kind = 'straight';

    const resolved: PunchKind = kind === 'straight' ? (b.hand === 'left' ? 'jab' : 'cross') : kind;
    const target = this.resolveTarget(b, analyzer, resolved);

    // --- STRIKE POWER (a gameplay metric, not a physical force) -----------
    const speedScore = clamp01(invLerp(cal.punchSpeed * sens, cal.punchSpeedMax, b.peakSpeed));
    const travelScore = clamp01(invLerp(cal.punchTravel * 0.8, cal.punchTravel * 2.5, b.travel));
    const raw = speedScore * 0.6 + travelScore * 0.25 + confidence * 0.15;
    const power = Math.round(clamp(24 + raw * 76, 24, 100));

    this.lastResult = { kind: resolved, confidence, tier };

    return {
      id: this.nextId++,
      hand: b.hand,
      kind: resolved,
      label: labelFor(resolved, b.hand, target),
      power,
      confidence,
      tier,
      target,
      peakSpeed: b.peakSpeed,
      at: b.at,
      source: 'vision',
    };
  }

  /** Head or body, from where the punch finished relative to the player. */
  private resolveTarget(b: BurstResult, analyzer: MotionAnalyzer, kind: PunchKind): 'head' | 'body' {
    if (kind === 'uppercut') return 'head';
    const pose = analyzer.pose;
    if (pose.present && pose.chest) {
      const low = pose.chest.y + analyzer.shoulderWidth * 0.34;
      return b.endPos.y > low ? 'body' : 'head';
    }
    const headY = analyzer.headY();
    if (headY !== null) return b.endPos.y > headY + 0.42 ? 'body' : 'head';
    // No pose at all: fall back to the lower third of the frame.
    return b.endPos.y > 0.66 ? 'body' : 'head';
  }
}

export function labelFor(kind: PunchKind, hand: Side, target: 'head' | 'body'): string {
  const side = hand === 'left' ? 'LEFT' : 'RIGHT';
  switch (kind) {
    case 'jab':
      return 'LEFT JAB';
    case 'cross':
      return 'RIGHT CROSS';
    case 'hook':
      return target === 'body' ? `${side} BODY HOOK` : `${side} HOOK`;
    case 'uppercut':
      return `${side} UPPERCUT`;
    default:
      return `${side} STRAIGHT`;
  }
}
