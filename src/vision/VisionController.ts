import type { Side, Vec2 } from '@/types/core';
import type {
  CalibrationProfile,
  PunchEvent,
  TrackingQuality,
  TrackingStatus,
  VisionFrame,
  VisionStats,
} from '@/types/vision';
import { DEFAULT_CALIBRATION } from '@/types/vision';
import { VISION } from '@/config/gameConfig';
import { clamp01, RollingAverage } from '@/utils/math';
import { CalibrationSystem } from './CalibrationSystem';
import { CameraError, CameraManager, type CameraErrorKind } from './CameraManager';
import { GestureDetector } from './GestureDetector';
import { HAND_CONNECTIONS, HandTracker, type RawHand } from './HandTracker';
import { emptyPose, MotionAnalyzer } from './MotionAnalyzer';
import { POSE_CONNECTIONS, PoseTracker, type RawPose } from './PoseTracker';
import { PunchDetector } from './PunchDetector';

/**
 * The single entry point the game talks to.
 *
 * It owns the detection loop and runs it *outside* React: subscribers are called
 * on the vision thread's cadence, and the renderer reads the latest frame
 * whenever it likes. Vision is deliberately throttled below the render rate —
 * a 30Hz read of the camera is plenty for punch detection and leaves the main
 * thread free to hold 60fps.
 */

export type VisionSubscriber = (frame: VisionFrame) => void;

interface VideoFrameCallbackHost {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

/**
 * Where the camera image sits inside the preview canvas, in CSS pixels.
 * Normalised landmarks are mapped through this rect so the overlay stays
 * aligned no matter how the preview crops or letterboxes the sensor frame.
 */
export interface TrackingOverlayView {
  x: number;
  y: number;
  w: number;
  h: number;
  mirrored: boolean;
  /** L / R badges on each hand. On by default. */
  showLabels?: boolean;
  /**
   * Neon-glow styling for the "sketch" preview, where the skeleton is the only
   * thing on screen and has to carry the whole image rather than sit legibly
   * on top of a camera frame.
   */
  glow?: boolean;
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
  speed: number;
}

interface OverlayFlash {
  x: number;
  y: number;
  t: number;
  side: Side;
}

const SIDES: readonly Side[] = ['left', 'right'];
const TAU = Math.PI * 2;

/** How long a motion trail stays on screen, and how many points it may hold. */
const TRAIL_MS = 320;
const TRAIL_MAX = 26;
/** Lifetime of the burst drawn where a punch was recognised. */
const FLASH_MS = 420;
const FLASH_MAX = 8;

// Deliberately NOT the player/enemy palette: both hands belong to the player,
// so neither may wear the colour the game uses for the opponent.
const OVERLAY_LEFT_RGB = '49, 230, 200';
const OVERLAY_RIGHT_RGB = '255, 211, 77';
const OVERLAY_IDLE_RGB = '138, 144, 173';
const OVERLAY_FONT = "'IBM Plex Mono', ui-monospace, monospace";

const EMPTY_HAND = {
  present: false,
  pos: { x: 0.5, y: 0.5 },
  vel: { x: 0, y: 0 },
  speed: 0,
  accel: 0,
  palmSize: 0.11,
  openness: 0.5,
  fistClosed: false,
  heightAboveFace: 0,
  confidence: 0,
  lostForMs: 1e9,
} as const;

export class VisionController {
  readonly camera = new CameraManager();
  readonly hands = new HandTracker();
  readonly poseTracker = new PoseTracker();
  readonly analyzer = new MotionAnalyzer();
  readonly punches = new PunchDetector();
  readonly gestures = new GestureDetector();
  readonly calibration = new CalibrationSystem();

  private video: HTMLVideoElement | null = null;
  private running = false;
  private rafHandle = 0;
  private vfcHandle = 0;
  private lastVideoTime = -1;
  private lastInferenceAt = 0;
  private frameCounter = 0;
  private lastPose: RawPose | null = null;
  private lastHands: RawHand[] = [];

  /** Purely cosmetic history for the preview overlay. Gameplay never reads it. */
  private readonly trails: Record<Side, TrailPoint[]> = { left: [], right: [] };
  private readonly flashes: OverlayFlash[] = [];

  private readonly subscribers = new Set<VisionSubscriber>();
  private readonly errorHandlers = new Set<(e: CameraError) => void>();
  private readonly fpsWindow = new RollingAverage(30);
  private readonly latencyWindow = new RollingAverage(30);
  private lastFrameAt = 0;

  private profile: CalibrationProfile = { ...DEFAULT_CALIBRATION };
  private readonly punchBuffer: PunchEvent[] = [];
  private frame: VisionFrame = this.blankFrame(0);
  private cameraOn = false;
  private disposed = false;

  // ---------------------------------------------------------------- state

  get latest(): VisionFrame {
    return this.frame;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get cameraActive(): boolean {
    return this.cameraOn && this.camera.active;
  }

  getCalibration(): CalibrationProfile {
    return this.profile;
  }

  setCalibration(profile: CalibrationProfile): void {
    this.profile = { ...profile };
    this.analyzer.setNeutral(profile.neutralChest, profile.shoulderWidth);
  }

  setSensitivity(sensitivity: number): void {
    this.profile = { ...this.profile, sensitivity };
  }

  subscribe(fn: VisionSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onError(fn: (e: CameraError) => void): () => void {
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Loads the models. Hands are required; pose is best-effort. */
  async load(): Promise<void> {
    await this.hands.load();
    // Deliberately not awaited into a failure: the game plays without pose.
    await this.poseTracker.load();
  }

  async start(video: HTMLVideoElement): Promise<void> {
    if (this.disposed) return;
    this.video = video;
    await this.load();
    await this.camera.start(video);
    this.cameraOn = true;

    this.camera.onLost((err) => {
      this.cameraOn = false;
      this.stopLoop();
      this.clearOverlay();
      this.publish(this.blankFrame(performance.now()));
      for (const handler of this.errorHandlers) handler(err);
    });

    this.analyzer.reset();
    this.punches.reset();
    this.gestures.reset();
    this.clearOverlay();
    this.lastVideoTime = -1;
    this.running = true;
    this.scheduleNext();
  }

  /** Stops detection and releases the camera; models stay loaded for a fast restart. */
  stop(): void {
    this.stopLoop();
    this.camera.stop();
    this.cameraOn = false;
    this.analyzer.reset();
    this.punches.reset();
    this.gestures.reset();
    this.clearOverlay();
    this.fpsWindow.clear();
    this.latencyWindow.clear();
    this.publish(this.blankFrame(performance.now()));
  }

  private stopLoop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    const host = this.video as unknown as VideoFrameCallbackHost | null;
    if (this.vfcHandle && host?.cancelVideoFrameCallback) host.cancelVideoFrameCallback(this.vfcHandle);
    this.rafHandle = 0;
    this.vfcHandle = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.camera.dispose();
    this.hands.close();
    this.poseTracker.close();
    this.subscribers.clear();
    this.errorHandlers.clear();
  }

  // ---------------------------------------------------------------- loop

  private scheduleNext(): void {
    if (!this.running || !this.video) return;
    const host = this.video as unknown as VideoFrameCallbackHost;
    // requestVideoFrameCallback fires once per *camera* frame rather than once
    // per display refresh, which avoids running inference on duplicate frames.
    if (typeof host.requestVideoFrameCallback === 'function') {
      this.vfcHandle = host.requestVideoFrameCallback(() => this.tick());
    } else {
      this.rafHandle = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    if (!this.running || !this.video) return;
    const video = this.video;
    const now = performance.now();
    const minGap = 1000 / VISION.targetHz;

    const fresh = video.readyState >= 2 && video.currentTime !== this.lastVideoTime;
    const dueForInference = now - this.lastInferenceAt >= minGap - 1;

    if (fresh && dueForInference) {
      this.lastVideoTime = video.currentTime;
      this.lastInferenceAt = now;
      this.frameCounter += 1;

      const started = performance.now();
      const handFrame = this.hands.detect(video, now);
      // Pose is roughly twice the cost of hands, and defence does not need it
      // every frame, so it runs on a slower cadence and the last result is held.
      if (this.poseTracker.ready && this.frameCounter % VISION.poseEveryNthFrame === 0) {
        this.lastPose = this.poseTracker.detect(video, now + 0.5) ?? this.lastPose;
      }
      this.latencyWindow.push(performance.now() - started);

      if (this.lastFrameAt) {
        const delta = now - this.lastFrameAt;
        if (delta > 0) this.fpsWindow.push(1000 / delta);
      }
      this.lastFrameAt = now;

      this.lastHands = handFrame?.hands ?? [];
      this.process(now);
    }

    this.scheduleNext();
  }

  /** One full analysis pass: kinematics, gestures, punches, calibration. */
  private process(now: number): void {
    this.analyzer.updateHands(this.lastHands, now);
    this.analyzer.updatePose(this.lastPose, now);

    const gestures = this.gestures.update(this.analyzer, this.profile, now);

    this.punchBuffer.length = 0;
    // Calibration deliberately bypasses punch detection: it is measuring the
    // player's natural motion, not reacting to it.
    if (this.calibration.active) {
      this.calibration.update(this.analyzer, now);
    } else {
      this.punches.update(this.analyzer, this.profile, now, {
        guardHeld: gestures.guard,
        bothHandsAtFace: this.gestures.handsAtFaceRaw,
      }, this.punchBuffer);
    }

    this.recordOverlay(now);
    this.publish(this.buildFrame(now, gestures));
  }

  /** Feeds the preview overlay. Cosmetic only — never read by the engine. */
  private recordOverlay(now: number): void {
    for (const side of SIDES) {
      const slot = side === 'left' ? this.analyzer.left : this.analyzer.right;
      const trail = this.trails[side];
      if (slot.present) {
        trail.push({ x: slot.pos.x, y: slot.pos.y, t: now, speed: slot.speed });
      }
      while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
      while (trail.length > TRAIL_MAX) trail.shift();
    }

    for (const punch of this.punchBuffer) {
      const slot = punch.hand === 'left' ? this.analyzer.left : this.analyzer.right;
      this.flashes.push({ x: slot.pos.x, y: slot.pos.y, t: now, side: punch.hand });
    }
    while (this.flashes.length && now - this.flashes[0].t > FLASH_MS) this.flashes.shift();
    while (this.flashes.length > FLASH_MAX) this.flashes.shift();
  }

  private clearOverlay(): void {
    this.trails.left.length = 0;
    this.trails.right.length = 0;
    this.flashes.length = 0;
    this.lastHands = [];
    this.lastPose = null;
  }

  private buildFrame(now: number, gestures: VisionFrame['gestures']): VisionFrame {
    const left = this.analyzer.left;
    const right = this.analyzer.right;
    const pose = this.analyzer.pose;

    const leftTracked = left.present;
    const rightTracked = right.present;
    const poseTracked = pose.present;

    let quality: TrackingQuality = 'good';
    let hint: string | null = null;
    if (!this.cameraActive) {
      quality = 'lost';
      hint = 'Camera offline.';
    } else if (!leftTracked && !rightTracked) {
      quality = 'lost';
      hint = 'Hands not visible — step back into the camera view.';
    } else if (!leftTracked || !rightTracked) {
      quality = 'partial';
      hint = `${leftTracked ? 'Right' : 'Left'} hand lost — keep both hands in frame.`;
    } else if (!poseTracked) {
      quality = 'partial';
      hint = 'Body not visible — dodging and ducking need your shoulders in frame.';
    }

    const stats: VisionStats = {
      fps: Math.round(this.fpsWindow.average),
      inferenceMs: Math.round(this.latencyWindow.average * 10) / 10,
      backend: this.hands.delegate,
      assetSource: this.hands.assetSource,
      resolution: this.camera.resolution,
      handModel: this.hands.ready,
      poseModel: this.poseTracker.ready,
    };

    const tracking: TrackingStatus = {
      camera: this.cameraActive,
      leftHand: leftTracked,
      rightHand: rightTracked,
      pose: poseTracked,
      quality,
      hint,
    };

    return {
      t: now,
      hands: { left: left.toSample(), right: right.toSample() },
      pose,
      gestures,
      punches: this.punchBuffer.length ? [...this.punchBuffer] : EMPTY_PUNCHES,
      tracking,
      stats,
    };
  }

  private blankFrame(now: number): VisionFrame {
    return {
      t: now,
      hands: { left: { ...EMPTY_HAND }, right: { ...EMPTY_HAND } },
      pose: emptyPose(),
      gestures: { guard: false, dodge: null, duck: false, rageSignal: false, lean: 0 },
      punches: EMPTY_PUNCHES,
      tracking: {
        camera: false,
        leftHand: false,
        rightHand: false,
        pose: false,
        quality: 'lost',
        hint: 'Camera offline.',
      },
      stats: {
        fps: 0,
        inferenceMs: 0,
        backend: this.hands.delegate,
        assetSource: this.hands.assetSource,
        resolution: '-',
        handModel: this.hands.ready,
        poseModel: this.poseTracker.ready,
      },
    };
  }

  private publish(frame: VisionFrame): void {
    this.frame = frame;
    for (const fn of this.subscribers) fn(frame);
  }

  // ---------------------------------------------------------------- helpers

  takeDodge(): Side | null {
    return this.gestures.takeDodge();
  }

  takeRage(): boolean {
    return this.gestures.takeRage();
  }

  startCalibration(): void {
    this.calibration.start(performance.now());
  }

  finishCalibration(sensitivity: number): CalibrationProfile {
    const profile = this.calibration.finish(sensitivity, this.analyzer);
    this.setCalibration(profile);
    return profile;
  }

  skipCalibration(sensitivity: number): CalibrationProfile {
    this.calibration.cancel();
    const profile = CalibrationSystem.defaults(sensitivity);
    this.setCalibration(profile);
    return profile;
  }

  // ---------------------------------------------------------------- overlay

  /** The element the MediaStream is bound to. Previews read pixels from it. */
  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  /**
   * Draws the tracking visualisation the player actually sees: pose skeleton,
   * both hand skeletons, fading motion trails and a burst wherever a punch was
   * recognised.
   *
   * It does NOT clear — the caller has already painted the camera frame, and
   * this composites on top of it.
   *
   * `view` is the rect the camera image occupies inside the canvas, in CSS
   * pixels. Normalised landmarks are mapped through that rect rather than the
   * whole canvas, so the skeleton stays glued to the body when the preview
   * letterboxes or crops the 4:3 sensor image.
   */
  drawTracking(ctx: CanvasRenderingContext2D, view: TrackingOverlayView, now: number): void {
    if (!this.cameraActive) return;

    const { w, h, mirrored } = view;
    // Landmark arrays are in raw sensor space; RawPose and the analyzer slots
    // are already mirrored into game space. Two mappers, one for each.
    const rawX = mirrored ? (x: number): number => view.x + (1 - x) * w : (x: number): number => view.x + x * w;
    const gameX = mirrored ? (x: number): number => view.x + x * w : (x: number): number => view.x + (1 - x) * w;
    const toY = (y: number): number => view.y + y * h;

    // Everything scales off the preview width so the small in-fight panel and
    // the large calibration view read the same.
    const k = Math.max(0.55, w / 260);

    const glow = view.glow === true;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.drawPoseOverlay(ctx, gameX, toY, k, glow);
    this.drawTrailOverlay(ctx, gameX, toY, k, now);
    this.drawHandOverlay(ctx, rawX, toY, k, view.showLabels !== false, glow);
    this.drawFlashOverlay(ctx, gameX, toY, k, now);

    ctx.restore();
  }

  private drawPoseOverlay(
    ctx: CanvasRenderingContext2D,
    gx: (x: number) => number,
    gy: (y: number) => number,
    k: number,
    glow: boolean,
  ): void {
    const raw = this.lastPose;
    if (!raw) return;

    // POSE_CONNECTIONS indexes MediaPipe's 33-point topology; only the upper
    // body subset the game actually consumes is populated.
    const pts: (Vec2 | null)[] = [];
    pts[0] = raw.nose ?? null;
    pts[11] = raw.shoulderL ?? null;
    pts[12] = raw.shoulderR ?? null;
    pts[13] = raw.elbowL ?? null;
    pts[14] = raw.elbowR ?? null;
    pts[23] = raw.hipL ?? null;
    pts[24] = raw.hipR ?? null;

    ctx.strokeStyle = glow ? 'rgba(124, 92, 255, 0.85)' : 'rgba(124, 92, 255, 0.55)';
    ctx.lineWidth = (glow ? 3.2 : 2.4) * k;
    if (glow) {
      ctx.shadowColor = 'rgba(124, 92, 255, 0.9)';
      ctx.shadowBlur = 12 * k;
    }
    ctx.beginPath();
    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = pts[a];
      const pb = pts[b];
      if (!pa || !pb) continue;
      ctx.moveTo(gx(pa.x), gy(pa.y));
      ctx.lineTo(gx(pb.x), gy(pb.y));
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(196, 184, 255, 0.9)';
    for (const p of pts) {
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(gx(p.x), gy(p.y), 2.6 * k, 0, TAU);
      ctx.fill();
    }

    // A ring on the head reads instantly as "the game can see you".
    if (raw.nose) {
      ctx.strokeStyle = glow ? 'rgba(124, 92, 255, 0.7)' : 'rgba(124, 92, 255, 0.4)';
      ctx.lineWidth = 1.6 * k;
      ctx.beginPath();
      ctx.arc(gx(raw.nose.x), gy(raw.nose.y), 13 * k, 0, TAU);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  private drawTrailOverlay(
    ctx: CanvasRenderingContext2D,
    gx: (x: number) => number,
    gy: (y: number) => number,
    k: number,
    now: number,
  ): void {
    for (const side of SIDES) {
      const trail = this.trails[side];
      if (trail.length < 2) continue;
      const colour = side === 'left' ? OVERLAY_LEFT_RGB : OVERLAY_RIGHT_RGB;

      // Drawn as discrete segments so each one can carry its own age-alpha and
      // speed-driven width. A single stroked path could not taper.
      for (let i = 1; i < trail.length; i += 1) {
        const a = trail[i - 1];
        const b = trail[i];
        const age = now - b.t;
        if (age > TRAIL_MS) continue;
        const life = 1 - age / TRAIL_MS;
        // Slow drift should barely register; a real punch should streak.
        const heat = clamp01(b.speed / 9);
        ctx.strokeStyle = `rgba(${colour}, ${(0.1 + 0.55 * heat) * life * life})`;
        ctx.lineWidth = (1.2 + 4.2 * heat) * life * k;
        ctx.beginPath();
        ctx.moveTo(gx(a.x), gy(a.y));
        ctx.lineTo(gx(b.x), gy(b.y));
        ctx.stroke();
      }
    }
  }

  private drawHandOverlay(
    ctx: CanvasRenderingContext2D,
    rx: (x: number) => number,
    ry: (y: number) => number,
    k: number,
    showLabels: boolean,
    glow: boolean,
  ): void {
    for (const hand of this.lastHands) {
      const lm = hand.landmarks;
      if (!lm || lm.length < 21) continue;
      // Unlabelled hands still draw — neutral, so the player can see that the
      // camera has them even while the assignment is still settling.
      const rgb =
        hand.labelled === 'left' ? OVERLAY_LEFT_RGB : hand.labelled === 'right' ? OVERLAY_RIGHT_RGB : OVERLAY_IDLE_RGB;

      if (glow) {
        // Two passes: a wide soft bloom, then a tight bright core on top. One
        // stroke with a big shadowBlur just looks muddy.
        ctx.shadowColor = `rgba(${rgb}, 0.95)`;
        ctx.shadowBlur = 16 * k;
        ctx.strokeStyle = `rgba(${rgb}, 0.55)`;
        ctx.lineWidth = 4.4 * k;
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(rx(lm[a].x), ry(lm[a].y));
          ctx.lineTo(rx(lm[b].x), ry(lm[b].y));
        }
        ctx.stroke();
      }

      ctx.shadowBlur = glow ? 8 * k : 0;
      ctx.strokeStyle = glow ? `rgba(${rgb}, 1)` : `rgba(${rgb}, 0.9)`;
      ctx.lineWidth = (glow ? 2.4 : 2.1) * k;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(rx(lm[a].x), ry(lm[a].y));
        ctx.lineTo(rx(lm[b].x), ry(lm[b].y));
      }
      ctx.stroke();

      // Palm ring: the clearest read on whether the hand is open or fisted,
      // which is what the SHIELD / SPECIAL style gestures key off.
      if (glow) {
        const px = (rx(lm[0].x) + rx(lm[9].x)) / 2;
        const py = (ry(lm[0].y) + ry(lm[9].y)) / 2;
        const span = Math.hypot(rx(lm[5].x) - rx(lm[17].x), ry(lm[5].y) - ry(lm[17].y));
        ctx.strokeStyle = `rgba(${rgb}, ${0.35 + 0.5 * hand.openness})`;
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(4, span * (0.34 + 0.22 * hand.openness)), 0, TAU);
        ctx.stroke();
      }

      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = glow ? 7 * k : 0;
      ctx.fillStyle = 'rgba(255,255,255,0.97)';
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(rx(p.x), ry(p.y), (glow ? 2.4 : 1.9) * k, 0, TAU);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      if (!showLabels || !hand.labelled) continue;

      // An L / R tag on the hand itself: the single clearest way to show the
      // player which of their hands the game has mapped to which side.
      const cx = rx(lm[9].x);
      const cy = ry(lm[9].y) - 20 * k;
      const label = hand.labelled === 'left' ? 'L' : 'R';
      const r = 8.5 * k;

      ctx.fillStyle = `rgba(${rgb}, 0.92)`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();

      ctx.fillStyle = '#06070d';
      ctx.font = `700 ${Math.round(11 * k)}px ${OVERLAY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy + 0.5 * k);
    }
  }

  private drawFlashOverlay(
    ctx: CanvasRenderingContext2D,
    gx: (x: number) => number,
    gy: (y: number) => number,
    k: number,
    now: number,
  ): void {
    for (const f of this.flashes) {
      const age = now - f.t;
      if (age > FLASH_MS) continue;
      const t = age / FLASH_MS;
      const ease = 1 - (1 - t) * (1 - t);
      const rgb = f.side === 'left' ? OVERLAY_LEFT_RGB : OVERLAY_RIGHT_RGB;
      const x = gx(f.x);
      const y = gy(f.y);

      // Expanding ring, brightest at the moment of recognition.
      ctx.strokeStyle = `rgba(${rgb}, ${0.85 * (1 - t)})`;
      ctx.lineWidth = (3.4 - 2.4 * t) * k;
      ctx.beginPath();
      ctx.arc(x, y, (7 + 34 * ease) * k, 0, TAU);
      ctx.stroke();

      if (t < 0.55) {
        ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - t / 0.55)})`;
        ctx.beginPath();
        ctx.arc(x, y, 6 * k, 0, TAU);
        ctx.fill();
      }
    }
  }
}

const EMPTY_PUNCHES: PunchEvent[] = [];

export type { CameraErrorKind };
export { CameraError };
