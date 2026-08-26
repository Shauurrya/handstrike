import type { Side } from '@/types/core';
import type { CalibrationProfile } from '@/types/vision';
import { DEFAULT_CALIBRATION } from '@/types/vision';
import { clamp, clamp01, median } from '@/utils/math';
import type { HandSlot, MotionAnalyzer } from './MotionAnalyzer';

/**
 * A 10-second warm-up that measures *this* player rather than assuming one.
 *
 * It captures the player's own resting scale and their own natural punch speed,
 * then derives every gameplay threshold from those. That is what lets the same
 * build work for a tall player far from a wide-angle laptop camera and a seated
 * player close to a narrow one. Skipping is always allowed: the defaults are
 * tuned to be playable, calibration just makes them fit.
 */

export interface CalibrationStepDef {
  id: string;
  title: string;
  instruction: string;
  seconds: number;
  /** Which signals this step is sampling. */
  collects: 'rest' | 'guard' | 'punchLeft' | 'punchRight' | 'dodge';
}

export const CALIBRATION_STEPS: CalibrationStepDef[] = [
  {
    id: 'neutral',
    title: 'NEUTRAL POSITION',
    instruction: 'Stand or sit comfortably with your hands down. Stay still.',
    seconds: 2.2,
    collects: 'rest',
  },
  {
    id: 'guard',
    title: 'RAISE BOTH HANDS',
    instruction: 'Bring both fists up beside your face, like a boxing guard.',
    seconds: 1.8,
    collects: 'guard',
  },
  {
    id: 'left',
    title: 'LEFT HAND PUNCHES',
    instruction: 'Throw three or four quick punches with your LEFT hand.',
    seconds: 2.8,
    collects: 'punchLeft',
  },
  {
    id: 'right',
    title: 'RIGHT HAND PUNCHES',
    instruction: 'Now three or four quick punches with your RIGHT hand.',
    seconds: 2.8,
    collects: 'punchRight',
  },
  {
    id: 'dodge',
    title: 'LEAN SIDE TO SIDE',
    instruction: 'Lean your upper body left, then right. Optional but recommended.',
    seconds: 2.4,
    collects: 'dodge',
  },
];

/** Finds the peak of each burst of motion, ignoring the noise between them. */
class PeakCollector {
  readonly peaks: number[] = [];
  readonly travels: number[] = [];
  private rising = false;
  private peak = 0;
  private startX = 0;
  private startY = 0;
  private peakX = 0;
  private peakY = 0;

  constructor(private readonly floor: number) {}

  push(slot: HandSlot): void {
    if (!slot.present) return;
    const speed = slot.speed;

    if (!this.rising) {
      if (speed > this.floor) {
        this.rising = true;
        this.peak = speed;
        this.startX = slot.pos.x;
        this.startY = slot.pos.y;
        this.peakX = slot.pos.x;
        this.peakY = slot.pos.y;
      }
      return;
    }

    if (speed > this.peak) {
      this.peak = speed;
      this.peakX = slot.pos.x;
      this.peakY = slot.pos.y;
      return;
    }

    // Speed has fallen well off the peak: that burst is over.
    if (speed < this.peak * 0.45) {
      this.peaks.push(this.peak);
      const scale = 1 / Math.max(0.03, slot.palmSize);
      this.travels.push(Math.hypot(this.peakX - this.startX, this.peakY - this.startY) * scale);
      this.rising = false;
      this.peak = 0;
    }
  }
}

export class CalibrationSystem {
  private index = 0;
  private running = false;
  private complete = false;

  /**
   * Time banked toward the current step, in ms.
   *
   * Deliberately NOT wall-clock elapsed. This only advances on frames the
   * camera actually delivered *and* in which the player was visible, because
   * a wall clock runs happily while the camera is denied, still starting, or
   * pointed at an empty room — and calibration would then march through all
   * five steps, measure nothing, and report success.
   */
  private stepElapsed = 0;
  private lastFrameAt = -1;

  private readonly palmSamples: number[] = [];
  private readonly shoulderSamples: number[] = [];
  private readonly chestX: number[] = [];
  private readonly chestY: number[] = [];
  private readonly headX: number[] = [];
  private readonly headY: number[] = [];
  private readonly guardHeights: number[] = [];
  private readonly leanSamples: number[] = [];
  private readonly crouchSamples: number[] = [];
  private left = new PeakCollector(1.6);
  private right = new PeakCollector(1.6);

  private goodFrames = 0;
  private totalFrames = 0;
  private hint: string | null = null;

  get stepIndex(): number {
    return this.index;
  }

  get steps(): CalibrationStepDef[] {
    return CALIBRATION_STEPS;
  }

  get done(): boolean {
    return this.complete;
  }

  get active(): boolean {
    return this.running;
  }

  get liveHint(): string | null {
    return this.hint;
  }

  /**
   * Whether tracking is actually usable right now.
   *
   * Returns false until enough frames have been seen to judge — the old
   * `totalFrames < 8 ? true` optimism meant a denied or missing camera, which
   * produces zero frames forever, reported "SIGNAL GOOD" indefinitely while
   * the preview beside it said NO SIGNAL.
   */
  get samplesGood(): boolean {
    if (this.totalFrames < 8) return false;
    return this.goodFrames / this.totalFrames > 0.55;
  }

  /** Frames the camera has delivered since calibration started. */
  get framesSeen(): number {
    return this.totalFrames;
  }

  stepProgress(): number {
    if (this.complete) return 1;
    if (!this.running) return 0;
    const step = CALIBRATION_STEPS[this.index];
    return clamp01(this.stepElapsed / (step.seconds * 1000));
  }

  progress(): number {
    if (this.complete) return 1;
    const per = 1 / CALIBRATION_STEPS.length;
    return clamp01(this.index * per + this.stepProgress() * per);
  }

  start(_t: number): void {
    this.index = 0;
    this.stepElapsed = 0;
    this.lastFrameAt = -1;
    this.running = true;
    this.complete = false;
    this.palmSamples.length = 0;
    this.shoulderSamples.length = 0;
    this.chestX.length = 0;
    this.chestY.length = 0;
    this.headX.length = 0;
    this.headY.length = 0;
    this.guardHeights.length = 0;
    this.leanSamples.length = 0;
    this.crouchSamples.length = 0;
    this.left = new PeakCollector(1.6);
    this.right = new PeakCollector(1.6);
    this.goodFrames = 0;
    this.totalFrames = 0;
    this.hint = null;
  }

  cancel(): void {
    this.running = false;
    this.complete = false;
  }

  update(analyzer: MotionAnalyzer, t: number): void {
    if (!this.running || this.complete) return;
    const step = CALIBRATION_STEPS[this.index];
    const { left, right } = analyzer;
    const pose = analyzer.pose;

    // Frame-to-frame delta, clamped so a hitch or a tab-switch cannot dump a
    // whole step's worth of time in at once.
    const dt = this.lastFrameAt < 0 ? 0 : Math.min(120, Math.max(0, t - this.lastFrameAt));
    this.lastFrameAt = t;

    this.totalFrames += 1;
    const handsSeen = (left.present ? 1 : 0) + (right.present ? 1 : 0);
    const wantTwoHands = step.collects === 'rest' || step.collects === 'guard';
    const enough = wantTwoHands ? handsSeen === 2 : handsSeen >= 1;
    if (enough) this.goodFrames += 1;

    this.hint = this.buildHint(step, handsSeen, pose.present);

    // The step only banks time while the player is actually in frame. Hands
    // OR body is enough — during the neutral step the hands rest at the sides
    // and may fall outside the view, and requiring both would deadlock it.
    const visible = handsSeen >= 1 || pose.present;
    if (visible) this.stepElapsed += dt;

    // Always accumulate scale: more samples means a steadier reference.
    if (left.present) this.palmSamples.push(left.palmSize);
    if (right.present) this.palmSamples.push(right.palmSize);
    if (pose.present && pose.shoulderWidth > 0.08) this.shoulderSamples.push(pose.shoulderWidth);

    switch (step.collects) {
      case 'rest':
        if (pose.present && pose.chest) {
          this.chestX.push(pose.chest.x);
          this.chestY.push(pose.chest.y);
        }
        if (pose.present && pose.nose) {
          this.headX.push(pose.nose.x);
          this.headY.push(pose.nose.y);
        }
        break;
      case 'guard':
        if (left.present) this.guardHeights.push(left.heightAboveFace);
        if (right.present) this.guardHeights.push(right.heightAboveFace);
        break;
      case 'punchLeft':
        this.left.push(left);
        break;
      case 'punchRight':
        this.right.push(right);
        break;
      case 'dodge':
        if (pose.present) {
          this.leanSamples.push(Math.abs(pose.lean));
          this.crouchSamples.push(pose.crouch);
        }
        break;
    }

    if (this.stepElapsed >= step.seconds * 1000) {
      this.index += 1;
      this.stepElapsed = 0;
      if (this.index >= CALIBRATION_STEPS.length) {
        this.index = CALIBRATION_STEPS.length - 1;
        this.complete = true;
        this.running = false;
      }
    }
  }

  private buildHint(step: CalibrationStepDef, handsSeen: number, poseSeen: boolean): string | null {
    if (handsSeen === 0) return 'No hands detected — move into the camera view.';
    if (handsSeen === 1 && (step.collects === 'rest' || step.collects === 'guard')) {
      return 'Only one hand visible — bring both hands into frame.';
    }
    if (step.collects === 'dodge' && !poseSeen) return 'Move back a little so your shoulders are visible.';
    if (step.collects === 'punchLeft' && this.left.peaks.length === 0) return 'Throw a few quick left punches.';
    if (step.collects === 'punchRight' && this.right.peaks.length === 0) return 'Throw a few quick right punches.';
    return null;
  }

  /** Derives the final profile. Any signal with too few samples keeps its default. */
  finish(sensitivity: number, analyzer?: MotionAnalyzer): CalibrationProfile {
    const base = DEFAULT_CALIBRATION;

    const palmSize = this.palmSamples.length >= 12 ? median(this.palmSamples) : base.palmSize;
    const shoulderWidth = this.shoulderSamples.length >= 12 ? median(this.shoulderSamples) : base.shoulderWidth;

    const allPeaks = [...this.left.peaks, ...this.right.peaks];
    const allTravels = [...this.left.travels, ...this.right.travels];

    let punchSpeed = base.punchSpeed;
    let punchSpeedMax = base.punchSpeedMax;
    if (allPeaks.length >= 3) {
      const typical = median(allPeaks);
      // Trigger at a little under half the player's natural peak, so a real
      // punch always clears it while a casual hand movement does not.
      punchSpeed = clamp(typical * 0.44, 2.6, 11);
      punchSpeedMax = clamp(typical * 1.22, punchSpeed * 2.1, 30);
    }

    let punchTravel = base.punchTravel;
    if (allTravels.length >= 3) {
      punchTravel = clamp(median(allTravels) * 0.52, 0.32, 2.2);
    }

    let guardHeight = base.guardHeight;
    if (this.guardHeights.length >= 8) {
      guardHeight = clamp(median(this.guardHeights) - 0.55, -1.4, 1.1);
    }

    let dodgeThreshold = base.dodgeThreshold;
    if (this.leanSamples.length >= 10) {
      // Half of the player's demonstrated comfortable lean.
      const reach = Math.max(...this.leanSamples);
      dodgeThreshold = clamp(reach * 0.5, 0.13, 0.72);
    }

    let duckThreshold = base.duckThreshold;
    if (this.crouchSamples.length >= 10) {
      const maxCrouch = Math.max(...this.crouchSamples);
      if (maxCrouch > 0.12) duckThreshold = clamp(maxCrouch * 0.55, 0.11, 0.6);
    }

    const neutralChest = this.chestX.length >= 6
      ? { x: median(this.chestX), y: median(this.chestY) }
      : { ...base.neutralChest };
    const neutralHead = this.headX.length >= 6
      ? { x: median(this.headX), y: median(this.headY) }
      : { ...base.neutralHead };

    analyzer?.setNeutral(neutralChest, shoulderWidth);

    return {
      palmSize,
      shoulderWidth,
      neutralChest,
      neutralHead,
      punchSpeed,
      punchSpeedMax,
      punchTravel,
      dodgeThreshold,
      duckThreshold,
      guardHeight,
      calibrated: true,
      sensitivity,
    };
  }

  /** The escape hatch: sensible defaults, no measurement. */
  static defaults(sensitivity: number): CalibrationProfile {
    return { ...DEFAULT_CALIBRATION, sensitivity, calibrated: false };
  }

  /** Per-hand summary shown on the calibration completion panel. */
  summary(): { hand: Side; punches: number; avgSpeed: number }[] {
    const mk = (hand: Side, c: PeakCollector) => ({
      hand,
      punches: c.peaks.length,
      avgSpeed: c.peaks.length ? median(c.peaks) : 0,
    });
    return [mk('left', this.left), mk('right', this.right)];
  }
}
