import type { Side } from '@/types/core';
import type { CalibrationProfile, GestureState } from '@/types/vision';
import { VISION } from '@/config/gameConfig';
import { clamp, clamp01 } from '@/utils/math';
import { Hysteresis } from '@/utils/smoothing';
import type { MotionAnalyzer } from './MotionAnalyzer';

/**
 * Defensive gestures: guard, dodge, duck and the rage trigger.
 *
 * Pose is used where it helps (it is the honest signal for a duck), but nothing
 * here *requires* pose: when the pose model is missing or the player's torso is
 * out of frame, each gesture degrades to a hand-only fallback rather than
 * disappearing. Every threshold is relative to the player's own body scale.
 */

/** Hands must be within this many palm widths of the head, horizontally. */
const GUARD_X_SPREAD = 2.2;
/** Vertical band around the face, in palm widths, that counts as a guard. */
const GUARD_Y_LOW = -1.05;
const GUARD_Y_HIGH = 1.35;
/** Both fists this far above the head triggers rage. */
const RAGE_Y = 1.7;
/** Hands must be reasonably still to read as a held posture. */
const POSTURE_MAX_SPEED = 3.4;

export class GestureDetector {
  private readonly guardLatch = new Hysteresis(VISION.guardHoldMs, VISION.guardReleaseMs);
  private readonly duckLatch = new Hysteresis(VISION.duckHoldMs, 170);
  private readonly rageLatch = new Hysteresis(VISION.rageGestureHoldMs, 260);

  private dodge: Side | null = null;
  private dodgeUntil = 0;
  private dodgeReadyAt = 0;
  private lean = 0;

  /** Slowly-adapting neutral for the hand-only dodge fallback. */
  private handNeutralX: number | null = null;

  private state: GestureState = { guard: false, dodge: null, duck: false, rageSignal: false, lean: 0 };

  reset(): void {
    this.guardLatch.reset();
    this.duckLatch.reset();
    this.rageLatch.reset();
    this.dodge = null;
    this.dodgeUntil = 0;
    this.dodgeReadyAt = 0;
    this.lean = 0;
    this.handNeutralX = null;
    this.state = { guard: false, dodge: null, duck: false, rageSignal: false, lean: 0 };
  }

  get current(): GestureState {
    return this.state;
  }

  /** True while both hands sit in the guard zone this instant (no latching). */
  get handsAtFaceRaw(): boolean {
    return this.rawGuard;
  }

  private rawGuard = false;

  update(analyzer: MotionAnalyzer, cal: CalibrationProfile, t: number): GestureState {
    const sens = clamp(cal.sensitivity, 0.5, 1.8);
    const left = analyzer.left;
    const right = analyzer.right;
    const bothHands = left.present && right.present;

    const headX = analyzer.headX();
    const headY = analyzer.headY();

    // ---- guard -----------------------------------------------------------
    let rawGuard = false;
    if (bothHands && headY !== null) {
      const inBand = (hAbove: number): boolean => hAbove > GUARD_Y_LOW && hAbove < GUARD_Y_HIGH;
      const nearX = (x: number, palm: number): boolean =>
        headX === null || Math.abs(x - headX) < GUARD_X_SPREAD * Math.max(0.03, palm);

      rawGuard =
        inBand(left.heightAboveFace) &&
        inBand(right.heightAboveFace) &&
        nearX(left.pos.x, left.palmSize) &&
        nearX(right.pos.x, right.palmSize) &&
        left.speed < POSTURE_MAX_SPEED &&
        right.speed < POSTURE_MAX_SPEED;
    } else if (bothHands && headY === null) {
      // No head reference: fall back to "both hands high in frame and close
      // together", which is what a shell looks like from the camera.
      const close = Math.abs(left.pos.x - right.pos.x) < 3.2 * Math.max(left.palmSize, right.palmSize);
      rawGuard =
        left.pos.y < cal.neutralHead.y + 0.14 &&
        right.pos.y < cal.neutralHead.y + 0.14 &&
        close &&
        left.speed < POSTURE_MAX_SPEED &&
        right.speed < POSTURE_MAX_SPEED;
    }
    this.rawGuard = rawGuard;
    const guard = this.guardLatch.update(rawGuard, t);

    // ---- rage ------------------------------------------------------------
    // Deliberately a *different* height band from the guard so the two cannot
    // be confused: fists clearly above the head, not beside the face.
    let rawRage = false;
    if (bothHands && headY !== null) {
      rawRage =
        left.heightAboveFace > RAGE_Y &&
        right.heightAboveFace > RAGE_Y &&
        left.speed < POSTURE_MAX_SPEED * 1.6 &&
        right.speed < POSTURE_MAX_SPEED * 1.6;
    } else if (bothHands) {
      rawRage = left.pos.y < cal.neutralHead.y - 0.1 && right.pos.y < cal.neutralHead.y - 0.1;
    }
    const rageSignal = this.rageLatch.update(rawRage, t);

    // ---- lean / dodge ----------------------------------------------------
    const pose = analyzer.pose;
    let leanRaw = 0;
    if (pose.present) {
      leanRaw = pose.lean;
    } else if (bothHands) {
      // Hand-only fallback: the midpoint of both hands tracks the upper body
      // well enough to read a committed slip.
      const mid = (left.pos.x + right.pos.x) / 2;
      if (this.handNeutralX === null) this.handNeutralX = mid;
      else this.handNeutralX += (mid - this.handNeutralX) * 0.004;
      const scale = 1 / Math.max(0.08, analyzer.shoulderWidth);
      leanRaw = clamp((mid - this.handNeutralX) * scale, -2, 2);
    } else {
      this.handNeutralX = null;
    }

    this.lean = this.lean + (leanRaw - this.lean) * 0.35;

    const dodgeThreshold = cal.dodgeThreshold * sens;
    if (t >= this.dodgeReadyAt && Math.abs(this.lean) > dodgeThreshold) {
      const dir: Side = this.lean < 0 ? 'left' : 'right';
      this.dodge = dir;
      this.dodgeUntil = t + 260;
      this.dodgeReadyAt = t + VISION.dodgeCooldownMs;
    }
    if (this.dodge && t > this.dodgeUntil) this.dodge = null;

    // ---- duck ------------------------------------------------------------
    // This one genuinely wants pose: hands say nothing useful about a level
    // change, and guessing would produce constant false ducks.
    const duckThreshold = cal.duckThreshold * sens;
    const rawDuck = pose.present && pose.crouch > duckThreshold;
    const duck = this.duckLatch.update(rawDuck, t);

    this.state = {
      guard: guard && !duck,
      dodge: this.dodge,
      duck,
      rageSignal,
      lean: clamp(this.lean / Math.max(0.12, dodgeThreshold * 1.6), -1, 1),
    };
    return this.state;
  }

  /** Consumes the latched dodge so the engine only acts on it once. */
  takeDodge(): Side | null {
    const d = this.dodge;
    if (d) {
      this.dodge = null;
      this.state = { ...this.state, dodge: null };
    }
    return d;
  }

  /** Consumes the rage signal so holding the pose cannot re-trigger it. */
  takeRage(): boolean {
    if (!this.rageLatch.value) return false;
    this.rageLatch.reset();
    this.state = { ...this.state, rageSignal: false };
    return true;
  }

  get guardStrength(): number {
    return clamp01(this.guardLatch.value ? 1 : 0);
  }
}
