import type { Side, Vec2 } from './core';

/**
 * Everything the vision layer publishes is expressed in **game space**:
 * the camera image is mirrored, so `x = 0` is the player's own left hand side
 * and `x = 1` is their right. Y grows downward (0 = top of frame).
 *
 * All velocities are **scale-normalised**: divided by the tracked palm size (or
 * shoulder width for pose), so a hand close to the lens and a hand far away
 * produce comparable numbers. Nothing here uses raw pixels.
 */

export type PunchKind = 'jab' | 'cross' | 'hook' | 'uppercut' | 'straight';

/** Confidence tier the classifier reached for a motion burst. */
export type DetectConfidence = 'high' | 'medium' | 'low';

export interface HandSample {
  present: boolean;
  /** Smoothed wrist/palm centre in game space, 0..1. */
  pos: Vec2;
  /** Scale-normalised velocity, units of "palm widths per second". */
  vel: Vec2;
  /** Magnitude of `vel`. */
  speed: number;
  /** Scale-normalised acceleration magnitude. */
  accel: number;
  /** Palm width in normalised frame units — the game's distance proxy. */
  palmSize: number;
  /** 0 = tight fist, 1 = fully open hand. */
  openness: number;
  fistClosed: boolean;
  /** How far above/below the tracked head the hand sits, in palm widths. */
  heightAboveFace: number;
  confidence: number;
  /** ms since this hand was last seen. */
  lostForMs: number;
}

export interface PoseSample {
  present: boolean;
  nose: Vec2 | null;
  shoulderL: Vec2 | null;
  shoulderR: Vec2 | null;
  elbowL: Vec2 | null;
  elbowR: Vec2 | null;
  hipL: Vec2 | null;
  hipR: Vec2 | null;
  /** Mid-shoulder point — the body anchor used for lean/duck. */
  chest: Vec2 | null;
  /** Shoulder separation in normalised frame units — the body scale proxy. */
  shoulderWidth: number;
  /** Sideways body offset from the calibrated neutral, -1 (left) .. 1 (right). */
  lean: number;
  /** Downward body offset from the calibrated neutral, 0 .. 1. */
  crouch: number;
  confidence: number;
  lostForMs: number;
}

/** A classified, gameplay-ready strike produced by the punch detector. */
export interface PunchEvent {
  id: number;
  hand: Side;
  kind: PunchKind;
  /** Display label, e.g. "RIGHT CROSS". */
  label: string;
  /** STRIKE POWER — a gameplay metric from 0-100. Not a physical force. */
  power: number;
  confidence: number;
  tier: DetectConfidence;
  /** Where the motion arc suggests the punch is aimed. */
  target: 'head' | 'body';
  /** Peak scale-normalised speed of the motion burst. */
  peakSpeed: number;
  at: number;
  source: 'vision' | 'keyboard';
}

export interface GestureState {
  /** Both hands held near the head. */
  guard: boolean;
  /** Momentary side-step, latched for a short window. */
  dodge: Side | null;
  duck: boolean;
  /** Both fists raised high — the rage trigger. */
  rageSignal: boolean;
  /** Continuous body lean used for subtle character sway, -1..1. */
  lean: number;
}

export type TrackingQuality = 'good' | 'partial' | 'lost';

export interface TrackingStatus {
  camera: boolean;
  leftHand: boolean;
  rightHand: boolean;
  pose: boolean;
  quality: TrackingQuality;
  /** Human-readable hint shown when quality degrades. */
  hint: string | null;
}

export interface VisionStats {
  fps: number;
  inferenceMs: number;
  backend: 'GPU' | 'CPU' | 'unknown';
  assetSource: 'local' | 'cdn' | 'unknown';
  resolution: string;
  handModel: boolean;
  poseModel: boolean;
}

export interface VisionFrame {
  t: number;
  hands: Record<Side, HandSample>;
  pose: PoseSample;
  gestures: GestureState;
  /** Punches classified on this frame (usually 0 or 1). */
  punches: PunchEvent[];
  tracking: TrackingStatus;
  stats: VisionStats;
}

/** Thresholds produced by calibration; every one is scale-relative. */
export interface CalibrationProfile {
  /** Median palm width observed at rest — the reference hand scale. */
  palmSize: number;
  /** Median shoulder width observed at rest. */
  shoulderWidth: number;
  /** Resting chest position in game space. */
  neutralChest: Vec2;
  /** Resting head position in game space. */
  neutralHead: Vec2;
  /** Speed (palm widths/sec) a hand must exceed to start a punch. */
  punchSpeed: number;
  /** Speed at which STRIKE POWER saturates at 100. */
  punchSpeedMax: number;
  /** Minimum travel distance in palm widths for a punch to count. */
  punchTravel: number;
  /** Lean magnitude (in shoulder widths) that reads as a dodge. */
  dodgeThreshold: number;
  /** Crouch depth (in shoulder widths) that reads as a duck. */
  duckThreshold: number;
  /** How high above the head hands must sit to read as a guard, in palm widths. */
  guardHeight: number;
  calibrated: boolean;
  /** Extra user-facing multiplier from Settings, 0.5 (easy) .. 1.6 (strict). */
  sensitivity: number;
}

export const DEFAULT_CALIBRATION: CalibrationProfile = {
  palmSize: 0.11,
  shoulderWidth: 0.32,
  neutralChest: { x: 0.5, y: 0.62 },
  neutralHead: { x: 0.5, y: 0.34 },
  punchSpeed: 5.2,
  punchSpeedMax: 16,
  punchTravel: 0.62,
  dodgeThreshold: 0.26,
  duckThreshold: 0.2,
  guardHeight: -0.35,
  calibrated: false,
  sensitivity: 1,
};
