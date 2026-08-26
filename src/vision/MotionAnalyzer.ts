import type { Side, Vec2 } from '@/types/core';
import type { HandSample, PoseSample } from '@/types/vision';
import { VISION } from '@/config/gameConfig';
import { clamp, clamp01, median } from '@/utils/math';
import { OneEuroVec2, TemporalBuffer } from '@/utils/smoothing';
import type { RawHand } from './HandTracker';
import type { RawPose } from './PoseTracker';

/**
 * Turns raw landmarks into stable, *scale-normalised* kinematics.
 *
 * Two problems are solved here:
 *
 * 1. IDENTITY. MediaPipe returns an unordered list of up to two hands, and its
 *    handedness label is confident but not infallible (crossed arms, a hand at
 *    the frame edge). We combine the label with frame-to-frame continuity and a
 *    weak spatial prior, then solve the 2x2 assignment by brute force.
 *
 * 2. SCALE. Nothing downstream may use raw pixels. Every velocity is divided by
 *    a slowly-adapting reference palm width, so the same physical punch reads
 *    the same whether the player sits close to the lens or far from it.
 */

/** How far back to difference for velocity. Long enough to be stable, short
 *  enough that a 250ms punch still peaks properly. */
const VELOCITY_WINDOW_MS = 55;

/** The reference palm size adapts over this many samples (~2s at 30Hz). */
const PALM_REF_SAMPLES = 60;

export interface MotionSample {
  pos: Vec2;
  /** Knuckle position, the best proxy for the fist. */
  palmSize: number;
  t: number;
}

class HandSlot {
  present = false;
  /** Smoothed knuckle position in game space. */
  pos: Vec2 = { x: 0.5, y: 0.5 };
  vel: Vec2 = { x: 0, y: 0 };
  speed = 0;
  accel = 0;
  palmSize = 0.11;
  /** Slowly-adapting reference used as the normalisation divisor. */
  palmRef = 0.11;
  openness = 0.5;
  confidence = 0;
  lastSeen = -1e9;
  lostForMs = 1e9;
  heightAboveFace = 0;

  readonly history = new TemporalBuffer<MotionSample>(VISION.motionWindowMs + 200, 60);
  private readonly filter = new OneEuroVec2(2.6, 0.035, 1.2);
  private readonly palmSamples: number[] = [];
  private prevSpeed = 0;

  constructor(readonly side: Side) {}

  reset(): void {
    this.present = false;
    this.speed = 0;
    this.accel = 0;
    this.vel = { x: 0, y: 0 };
    this.prevSpeed = 0;
    this.lastSeen = -1e9;
    this.lostForMs = 1e9;
    this.history.clear();
    this.filter.reset();
    this.palmSamples.length = 0;
  }

  markMissing(t: number): void {
    this.lostForMs = t - this.lastSeen;
    if (this.lostForMs > VISION.handGraceMs) {
      this.present = false;
      this.confidence = 0;
      // Decay motion so a hand that vanishes mid-swing cannot leave a stale
      // high velocity that fires a phantom punch when it reappears.
      this.speed *= 0.5;
      this.accel = 0;
      this.vel = { x: this.vel.x * 0.5, y: this.vel.y * 0.5 };
      if (this.lostForMs > VISION.handGraceMs * 3) {
        this.history.clear();
        this.filter.reset();
      }
    }
  }

  update(hand: RawHand, t: number): void {
    const wasLost = this.lostForMs > VISION.handGraceMs * 3;
    if (wasLost) this.filter.reset();

    // The knuckle centre moves less than the wrist when the hand rotates,
    // which keeps a twisting hook from reading as a huge translation.
    const smoothed = this.filter.filter(hand.knuckles, t);
    this.pos = smoothed;
    this.present = true;
    this.lastSeen = t;
    this.lostForMs = 0;
    this.openness = hand.openness;
    this.palmSize = hand.palmSize;
    this.confidence = hand.labelScore > 0 ? hand.labelScore : 0.6;

    this.palmSamples.push(hand.palmSize);
    if (this.palmSamples.length > PALM_REF_SAMPLES) this.palmSamples.shift();
    // Median, not mean: a motion-blurred frame can halve the apparent palm.
    this.palmRef = Math.max(0.03, median(this.palmSamples));

    this.history.push({ pos: smoothed, palmSize: hand.palmSize, t }, t);

    const past = this.history.sampleBefore(VELOCITY_WINDOW_MS, t);
    if (past && past.t < t) {
      const dt = (t - past.t) / 1000;
      const invScale = 1 / this.palmRef;
      const vx = ((smoothed.x - past.v.pos.x) / dt) * invScale;
      const vy = ((smoothed.y - past.v.pos.y) / dt) * invScale;
      this.vel = { x: vx, y: vy };
      const speed = Math.hypot(vx, vy);
      // Acceleration in the same normalised units; used to reject slow drifts
      // that eventually accumulate enough travel to look like a punch.
      this.accel = (speed - this.prevSpeed) / Math.max(0.008, dt);
      this.prevSpeed = speed;
      this.speed = speed;
    } else {
      this.vel = { x: 0, y: 0 };
      this.speed = 0;
      this.accel = 0;
    }
  }

  toSample(): HandSample {
    return {
      present: this.present,
      pos: this.pos,
      vel: this.vel,
      speed: this.speed,
      accel: this.accel,
      palmSize: this.palmRef,
      openness: this.openness,
      fistClosed: this.openness < 0.42,
      heightAboveFace: this.heightAboveFace,
      confidence: this.confidence,
      lostForMs: this.lostForMs,
    };
  }
}

export class MotionAnalyzer {
  readonly left = new HandSlot('left');
  readonly right = new HandSlot('right');

  private poseSample: PoseSample = emptyPose();
  private poseNeutralChest: Vec2 | null = null;
  private poseNeutralY = 0;
  private shoulderRefSamples: number[] = [];
  private shoulderRef = 0.32;
  private lastPoseAt = -1e9;
  private readonly poseFilter = new OneEuroVec2(2.2, 0.02, 1.1);

  reset(): void {
    this.left.reset();
    this.right.reset();
    this.poseSample = emptyPose();
    this.poseFilter.reset();
    this.shoulderRefSamples = [];
    this.lastPoseAt = -1e9;
  }

  /** Called by the calibration system once a neutral posture is measured. */
  setNeutral(chest: Vec2, shoulderWidth: number): void {
    this.poseNeutralChest = { ...chest };
    this.poseNeutralY = chest.y;
    if (shoulderWidth > 0.05) this.shoulderRef = shoulderWidth;
  }

  get slots(): Record<Side, HandSlot> {
    return { left: this.left, right: this.right };
  }

  get pose(): PoseSample {
    return this.poseSample;
  }

  get shoulderWidth(): number {
    return this.shoulderRef;
  }

  /**
   * Assigns the detected hands to the left/right slots.
   * Brute-forcing both permutations is trivial for two hands and strictly
   * better than greedy matching when the hands cross.
   */
  updateHands(hands: RawHand[], t: number): void {
    if (hands.length === 0) {
      this.left.markMissing(t);
      this.right.markMissing(t);
      return;
    }

    if (hands.length === 1) {
      const h = hands[0];
      const costL = this.assignmentCost(h, this.left, t);
      const costR = this.assignmentCost(h, this.right, t);
      if (costL <= costR) {
        this.left.update(h, t);
        this.right.markMissing(t);
      } else {
        this.right.update(h, t);
        this.left.markMissing(t);
      }
      return;
    }

    const [a, b] = hands;
    const straight = this.assignmentCost(a, this.left, t) + this.assignmentCost(b, this.right, t);
    const swapped = this.assignmentCost(b, this.left, t) + this.assignmentCost(a, this.right, t);
    if (straight <= swapped) {
      this.left.update(a, t);
      this.right.update(b, t);
    } else {
      this.left.update(b, t);
      this.right.update(a, t);
    }
  }

  private assignmentCost(hand: RawHand, slot: HandSlot, t: number): number {
    let cost = 0;

    // Continuity dominates while the slot is warm — a hand does not teleport.
    const age = t - slot.lastSeen;
    if (age < VISION.handGraceMs * 2) {
      const d = Math.hypot(hand.knuckles.x - slot.pos.x, hand.knuckles.y - slot.pos.y);
      const recency = clamp01(1 - age / (VISION.handGraceMs * 2));
      cost += d * 6 * recency;
    }

    // MediaPipe's own call, weighted by how sure it is.
    if (hand.labelled) {
      cost += hand.labelled === slot.side ? -0.9 * hand.labelScore : 0.9 * hand.labelScore;
    }

    // Weak spatial prior: in game space the right hand usually sits right.
    const sideBias = slot.side === 'right' ? 1 : -1;
    cost += -sideBias * (hand.knuckles.x - 0.5) * 0.5;

    return cost;
  }

  updatePose(pose: RawPose | null, t: number): void {
    if (!pose || !pose.chest) {
      const lost = t - this.lastPoseAt;
      if (lost > VISION.poseGraceMs) {
        this.poseSample = { ...this.poseSample, present: false, lostForMs: lost, confidence: 0, lean: 0, crouch: 0 };
      } else {
        this.poseSample = { ...this.poseSample, lostForMs: lost };
      }
      return;
    }

    this.lastPoseAt = t;
    const chest = this.poseFilter.filter(pose.chest, t);

    if (pose.shoulderWidth > 0.08) {
      this.shoulderRefSamples.push(pose.shoulderWidth);
      if (this.shoulderRefSamples.length > PALM_REF_SAMPLES) this.shoulderRefSamples.shift();
      const m = median(this.shoulderRefSamples);
      if (m > 0.08) this.shoulderRef = m;
    }

    // Establish a neutral on the fly if calibration was skipped, so lean/crouch
    // are always measured against *this* player rather than a magic constant.
    if (!this.poseNeutralChest) {
      this.poseNeutralChest = { ...chest };
      this.poseNeutralY = chest.y;
    } else {
      // Drift the neutral very slowly so a player who shifts their chair does
      // not end up permanently "dodging left".
      this.poseNeutralChest.x += (chest.x - this.poseNeutralChest.x) * 0.0016;
      this.poseNeutralY += (chest.y - this.poseNeutralY) * 0.0012;
    }

    const inv = 1 / Math.max(0.08, this.shoulderRef);
    const lean = clamp((chest.x - this.poseNeutralChest.x) * inv, -2, 2);
    const crouch = clamp((chest.y - this.poseNeutralY) * inv, -1, 2);

    this.poseSample = {
      present: true,
      nose: pose.nose,
      shoulderL: pose.shoulderL,
      shoulderR: pose.shoulderR,
      elbowL: pose.elbowL,
      elbowR: pose.elbowR,
      hipL: pose.hipL,
      hipR: pose.hipR,
      chest,
      shoulderWidth: this.shoulderRef,
      lean,
      crouch: Math.max(0, crouch),
      confidence: pose.confidence,
      lostForMs: 0,
    };

    this.updateHandHeights();
  }

  /** Hand height relative to the face, in palm widths — drives guard and rage. */
  private updateHandHeights(): void {
    const headY = this.headY();
    for (const slot of [this.left, this.right]) {
      slot.heightAboveFace = headY === null ? 0 : (headY - slot.pos.y) / Math.max(0.03, slot.palmRef);
    }
  }

  /** Best available head Y, falling back through pose then hands. */
  headY(): number | null {
    const p = this.poseSample;
    if (p.present && p.nose) return p.nose.y;
    if (p.present && p.chest) return p.chest.y - this.shoulderRef * 0.72;
    return null;
  }

  headX(): number | null {
    const p = this.poseSample;
    if (p.present && p.nose) return p.nose.x;
    if (p.present && p.chest) return p.chest.x;
    return null;
  }
}

export function emptyPose(): PoseSample {
  return {
    present: false,
    nose: null,
    shoulderL: null,
    shoulderR: null,
    elbowL: null,
    elbowR: null,
    hipL: null,
    hipR: null,
    chest: null,
    shoulderWidth: 0.32,
    lean: 0,
    crouch: 0,
    confidence: 0,
    lostForMs: 1e9,
  };
}

export type { HandSlot };
