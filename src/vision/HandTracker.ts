import { HandLandmarker, type HandLandmarkerResult, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Side, Vec2 } from '@/types/core';
import { CameraError } from './CameraManager';
import { CDN_HAND_MODEL, LOCAL_HAND_MODEL, resolveFileset, resolveModelPath, type AssetSource } from './assets';

/** Landmark indices we actually care about. */
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_TIP = 20;

/** One hand as the rest of the game wants it: mirrored into game space. */
export interface RawHand {
  /** Wrist in game space (x already mirrored, 0 = player's left). */
  wrist: Vec2;
  /** Centre of the palm — steadier than the wrist during a punch. */
  palm: Vec2;
  /** Knuckle centre, the best single proxy for "where the fist is". */
  knuckles: Vec2;
  /** Apparent palm width in normalised frame units. Doubles as a distance proxy. */
  palmSize: number;
  /** 0 = tight fist, 1 = open hand. */
  openness: number;
  /** MediaPipe's own handedness call, already corrected for the mirror. */
  labelled: Side | null;
  labelScore: number;
  landmarks: NormalizedLandmark[];
}

export interface HandFrame {
  hands: RawHand[];
  /** Wall-clock timestamp the frame was inferred at. */
  t: number;
}

const dist = (a: NormalizedLandmark, b: NormalizedLandmark): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * MediaPipe reports handedness as if the image were a selfie (mirrored).
 * getUserMedia hands us the *unmirrored* sensor image, so its "Left" is really
 * the user's right hand. We flip it here once, and never think about it again.
 */
function correctHandedness(category: string | undefined): Side | null {
  if (category === 'Left') return 'right';
  if (category === 'Right') return 'left';
  return null;
}

/**
 * Openness from finger extension, scale-normalised against the palm so it works
 * at any distance. Used only for the fist check — punches never require a pose.
 */
function computeOpenness(lm: NormalizedLandmark[], palmSize: number): number {
  if (palmSize < 1e-4) return 0.5;
  const tips = [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
  const mcps = [INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  let sum = 0;
  for (let i = 0; i < tips.length; i += 1) {
    // A curled finger puts the tip close to its own knuckle.
    sum += Math.min(1.6, dist(lm[tips[i]], lm[mcps[i]]) / palmSize);
  }
  const avg = sum / tips.length;
  // ~0.35 palm widths is a closed fist, ~1.25 is a flat hand.
  return Math.max(0, Math.min(1, (avg - 0.4) / 0.75));
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private source: AssetSource = 'unknown';
  private backend: 'GPU' | 'CPU' | 'unknown' = 'unknown';
  private lastTimestamp = 0;

  get ready(): boolean {
    return this.landmarker !== null;
  }

  get assetSource(): AssetSource {
    return this.source;
  }

  get delegate(): 'GPU' | 'CPU' | 'unknown' {
    return this.backend;
  }

  async load(): Promise<void> {
    if (this.landmarker) return;
    const { fileset, source: wasmSource } = await resolveFileset();
    const { path, source } = await resolveModelPath(LOCAL_HAND_MODEL, CDN_HAND_MODEL);
    this.source = wasmSource === 'local' && source === 'local' ? 'local' : 'cdn';

    const create = (delegate: 'GPU' | 'CPU'): Promise<HandLandmarker> =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: path, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        // Deliberately permissive: a missed hand costs the player a punch,
        // while a slightly noisy hand is smoothed downstream.
        minHandDetectionConfidence: 0.45,
        minHandPresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      });

    try {
      this.landmarker = await create('GPU');
      this.backend = 'GPU';
    } catch {
      try {
        this.landmarker = await create('CPU');
        this.backend = 'CPU';
      } catch (err) {
        throw new CameraError(
          'MODEL_FAILED',
          `Hand tracking failed to initialise (${err instanceof Error ? err.message : 'unknown error'}).`,
        );
      }
    }
  }

  /** Runs inference on one video frame. Returns null if the model is not ready. */
  detect(video: HTMLVideoElement, nowMs: number): HandFrame | null {
    if (!this.landmarker) return null;
    // MediaPipe requires strictly increasing timestamps or it throws.
    const ts = Math.max(nowMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;

    let result: HandLandmarkerResult | null = null;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch {
      return null;
    }
    if (!result) return null;

    const hands: RawHand[] = [];
    const count = result.landmarks?.length ?? 0;
    for (let i = 0; i < count; i += 1) {
      const lm = result.landmarks[i];
      if (!lm || lm.length < 21) continue;

      // Palm width from the knuckle span plus the wrist-to-middle-knuckle
      // length; averaging two spans is far steadier than either alone.
      const knuckleSpan = dist(lm[INDEX_MCP], lm[PINKY_MCP]);
      const palmLength = dist(lm[WRIST], lm[MIDDLE_MCP]);
      const palmSize = Math.max(0.012, (knuckleSpan * 1.15 + palmLength) * 0.5);

      const knuckles = {
        x: 1 - (lm[INDEX_MCP].x + lm[MIDDLE_MCP].x + lm[RING_MCP].x + lm[PINKY_MCP].x) / 4,
        y: (lm[INDEX_MCP].y + lm[MIDDLE_MCP].y + lm[RING_MCP].y + lm[PINKY_MCP].y) / 4,
      };
      const wrist = { x: 1 - lm[WRIST].x, y: lm[WRIST].y };
      const palm = { x: (wrist.x + knuckles.x) / 2, y: (wrist.y + knuckles.y) / 2 };

      const category = result.handednesses?.[i]?.[0];
      hands.push({
        wrist,
        palm,
        knuckles,
        palmSize,
        openness: computeOpenness(lm, palmSize),
        labelled: correctHandedness(category?.categoryName),
        labelScore: category?.score ?? 0,
        landmarks: lm,
      });
    }

    return { hands, t: nowMs };
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

export const HAND_LANDMARK_INDICES = {
  WRIST,
  THUMB_TIP,
  INDEX_MCP,
  INDEX_TIP,
  MIDDLE_MCP,
  MIDDLE_TIP,
  RING_MCP,
  RING_TIP,
  PINKY_MCP,
  PINKY_TIP,
} as const;

/** Bone pairs for the debug landmark overlay. */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
