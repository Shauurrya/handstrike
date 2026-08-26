import { PoseLandmarker, type NormalizedLandmark, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Vec2 } from '@/types/core';
import { CDN_POSE_MODEL, LOCAL_POSE_MODEL, resolveFileset, resolveModelPath, type AssetSource } from './assets';

/**
 * Upper-body pose, used purely as an *additional* input layer for defence.
 * The game never requires pose to be present: if it drops out, GestureDetector
 * falls back to hand positions. Pose is also the heavier of the two models, so
 * VisionController runs it at a lower cadence than hands.
 */

const NOSE = 0;
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_HIP = 23;
const R_HIP = 24;

/** Landmarks below this visibility are treated as absent rather than guessed. */
const MIN_VISIBILITY = 0.5;

export interface RawPose {
  nose: Vec2 | null;
  /** Mirrored into game space, so shoulderL really is the player's left shoulder. */
  shoulderL: Vec2 | null;
  shoulderR: Vec2 | null;
  elbowL: Vec2 | null;
  elbowR: Vec2 | null;
  hipL: Vec2 | null;
  hipR: Vec2 | null;
  chest: Vec2 | null;
  shoulderWidth: number;
  confidence: number;
  t: number;
}

function pick(lm: NormalizedLandmark[] | undefined, index: number): Vec2 | null {
  const p = lm?.[index];
  if (!p) return null;
  const vis = p.visibility ?? 1;
  if (vis < MIN_VISIBILITY) return null;
  // Mirror X so the pose lives in the same game space as the hands.
  return { x: 1 - p.x, y: p.y };
}

function visibilityOf(lm: NormalizedLandmark[] | undefined, index: number): number {
  return lm?.[index]?.visibility ?? 0;
}

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null;
  private source: AssetSource = 'unknown';
  private lastTimestamp = 0;
  private failed = false;

  get ready(): boolean {
    return this.landmarker !== null;
  }

  get unavailable(): boolean {
    return this.failed;
  }

  get assetSource(): AssetSource {
    return this.source;
  }

  /**
   * Pose is optional, so a load failure is swallowed: the game keeps working
   * on hands alone rather than refusing to start.
   */
  async load(): Promise<boolean> {
    if (this.landmarker) return true;
    if (this.failed) return false;
    try {
      const { fileset, source: wasmSource } = await resolveFileset();
      const { path, source } = await resolveModelPath(LOCAL_POSE_MODEL, CDN_POSE_MODEL);
      this.source = wasmSource === 'local' && source === 'local' ? 'local' : 'cdn';

      const create = (delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: path, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        });

      try {
        this.landmarker = await create('GPU');
      } catch {
        this.landmarker = await create('CPU');
      }
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  detect(video: HTMLVideoElement, nowMs: number): RawPose | null {
    if (!this.landmarker) return null;
    const ts = Math.max(nowMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;

    let result: PoseLandmarkerResult | null = null;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch {
      return null;
    }

    const lm = result?.landmarks?.[0];
    if (!lm || lm.length < 25) return null;

    const shoulderL = pick(lm, L_SHOULDER);
    const shoulderR = pick(lm, R_SHOULDER);
    const chest = shoulderL && shoulderR
      ? { x: (shoulderL.x + shoulderR.x) / 2, y: (shoulderL.y + shoulderR.y) / 2 }
      : null;

    const shoulderWidth = shoulderL && shoulderR ? Math.hypot(shoulderL.x - shoulderR.x, shoulderL.y - shoulderR.y) : 0;

    const confidence =
      (visibilityOf(lm, NOSE) + visibilityOf(lm, L_SHOULDER) + visibilityOf(lm, R_SHOULDER)) / 3;

    return {
      nose: pick(lm, NOSE),
      shoulderL,
      shoulderR,
      elbowL: pick(lm, L_ELBOW),
      elbowR: pick(lm, R_ELBOW),
      hipL: pick(lm, L_HIP),
      hipR: pick(lm, R_HIP),
      chest,
      shoulderWidth,
      confidence,
      t: nowMs,
    };
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** Upper-body bones for the debug overlay. Indices are MediaPipe pose indices. */
export const POSE_CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
];

export const POSE_LANDMARK_INDICES = { NOSE, L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_HIP, R_HIP } as const;
