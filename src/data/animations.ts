import type { Vec2 } from '@/types/core';
import type { AnimClip, AnimFrame, AnimLibrary, AnimState, Ease, JointName, RigPose } from '@/types/fighter';
import { JOINT_NAMES } from '@/types/fighter';

/**
 * The pose library.
 *
 * Rig space: origin between the feet on the floor, +Y UP, +X in the direction
 * the fighter faces. A standing fighter is ~100 units tall, so one rig drives
 * every fighter at any on-screen size.
 *
 * Clips store SPARSE offsets from the base stance. Anything a clip does not
 * mention keeps breathing from the stance, which is what stops a jab from
 * freezing the legs.
 */

const v = (x: number, y: number): Vec2 => ({ x, y });

/** Orthodox stance, 3/4 side view. The L joints are the LEAD side. */
export const BASE_STANCE: RigPose = {
  pelvis: v(0, 50),
  chest: v(1, 68),
  neck: v(2, 80),
  head: v(3, 90),

  shoulderL: v(8, 76),
  elbowL: v(13, 66),
  handL: v(19, 79),

  shoulderR: v(-6, 77),
  elbowR: v(-3, 66),
  handR: v(3, 83),

  hipL: v(5, 49),
  kneeL: v(12, 26),
  footL: v(14, 3),

  hipR: v(-5, 50),
  kneeR: v(-13, 27),
  footR: v(-16, 3),
};

/** Widens the stance and thickens the frame for heavier fighters. */
export function buildStance(bulk = 1): RigPose {
  if (Math.abs(bulk - 1) < 0.02) return BASE_STANCE;
  const out = {} as RigPose;
  const spread = 1 + (bulk - 1) * 0.55;
  for (const name of JOINT_NAMES) {
    const j = BASE_STANCE[name];
    const widen = name.startsWith('foot') || name.startsWith('knee') || name.startsWith('hip');
    out[name] = v(widen ? j.x * spread : j.x, j.y);
  }
  return out;
}

type Deltas = Partial<Record<JointName, [number, number]>>;

interface Step {
  t: number;
  d?: Deltas;
  ease?: Ease;
  root?: [number, number];
  rot?: number;
  scale?: number;
}

const off = (deltas: Deltas): Partial<RigPose> => {
  const out: Partial<RigPose> = {};
  for (const key of Object.keys(deltas) as JointName[]) {
    const d = deltas[key];
    if (!d) continue;
    const base = BASE_STANCE[key];
    out[key] = v(base.x + d[0], base.y + d[1]);
  }
  return out;
};

/**
 * Turns authored steps into keyframes.
 *
 * Auto-completes the timeline so every joint the clip touches is also pinned at
 * t=0 (and, for loops, at t=1). Without that a joint mentioned only mid-clip
 * would snap on entry and never return.
 */
function build(steps: Step[], loop: boolean): AnimFrame[] {
  const touched = new Set<JointName>();
  for (const s of steps) {
    if (!s.d) continue;
    for (const key of Object.keys(s.d) as JointName[]) touched.add(key);
  }

  const frames: AnimFrame[] = steps.map((s) => {
    const frame: AnimFrame = { t: s.t, pose: s.d ? off(s.d) : {} };
    if (s.ease) frame.ease = s.ease;
    if (s.root) frame.root = v(s.root[0], s.root[1]);
    if (s.rot !== undefined) frame.rot = s.rot;
    if (s.scale !== undefined) frame.scale = s.scale;
    return frame;
  });

  if (frames.length === 0 || frames[0].t > 0) {
    frames.unshift({ t: 0, pose: {}, ease: 'inout' });
  }
  const first = frames[0];
  for (const name of touched) {
    if (!first.pose[name]) first.pose[name] = v(BASE_STANCE[name].x, BASE_STANCE[name].y);
  }

  if (loop) {
    let last = frames[frames.length - 1];
    if (last.t < 1) {
      last = { t: 1, pose: {}, ease: 'inout' };
      frames.push(last);
    }
    for (const name of touched) {
      if (!last.pose[name]) {
        const start = first.pose[name] as Vec2;
        last.pose[name] = v(start.x, start.y);
      }
    }
  }

  return frames;
}

interface ClipSpec {
  duration: number;
  loop?: boolean;
  priority: number;
  blendIn?: number;
  impactAt?: number;
  next?: AnimState;
  steps: Step[];
}

const clip = (spec: ClipSpec): AnimClip => ({
  duration: spec.duration,
  loop: spec.loop ?? false,
  frames: build(spec.steps, spec.loop ?? false),
  priority: spec.priority,
  ...(spec.blendIn !== undefined ? { blendIn: spec.blendIn } : {}),
  ...(spec.impactAt !== undefined ? { impactAt: spec.impactAt } : {}),
  ...(spec.next !== undefined ? { next: spec.next } : {}),
});

// --------------------------------------------------------------------------
// The library
// --------------------------------------------------------------------------

function makeLibrary(): AnimLibrary {
  return {
    // ---- idle -------------------------------------------------------------
    STANCE: clip({
      duration: 1400,
      loop: true,
      priority: 10,
      blendIn: 140,
      steps: [
        { t: 0, ease: 'inout' },
        {
          t: 0.5,
          ease: 'inout',
          d: {
            pelvis: [0, 1.6], chest: [0.3, 1.9], neck: [0.4, 1.7], head: [0.5, 1.6],
            shoulderL: [0.3, 1.5], shoulderR: [0.3, 1.5],
            elbowL: [0.5, 1.3], elbowR: [0.4, 1.3],
            handL: [0.8, 1.5], handR: [0.5, 1.4],
            kneeL: [0, 0.7], kneeR: [0, 0.7],
          },
        },
      ],
    }),

    IDLE: clip({
      duration: 1900,
      loop: true,
      priority: 10,
      blendIn: 160,
      steps: [
        { t: 0, ease: 'inout' },
        {
          t: 0.5,
          ease: 'inout',
          d: {
            pelvis: [0, 1.2], chest: [0.2, 1.4], neck: [0.3, 1.3], head: [0.4, 1.2],
            shoulderL: [0.2, 1.1], shoulderR: [0.2, 1.1],
            handL: [0.5, 1.1], handR: [0.4, 1.0],
            elbowL: [0.3, 0.9], elbowR: [0.3, 0.9],
          },
        },
      ],
    }),

    // ---- footwork ---------------------------------------------------------
    WALK_FWD: clip({
      duration: 700,
      loop: true,
      priority: 12,
      blendIn: 110,
      steps: [
        { t: 0, ease: 'inout' },
        {
          t: 0.3,
          ease: 'out',
          d: { footL: [7, 1.6], kneeL: [3.5, 0.9], pelvis: [1.8, -0.5], chest: [1.4, -0.3], handL: [1, -0.4] },
        },
        {
          t: 0.62,
          ease: 'inout',
          d: { footL: [7, 0], kneeL: [3.5, 0], footR: [5, 1.6], kneeR: [2.5, 0.9], pelvis: [3.4, 0], chest: [2.6, 0.2] },
        },
      ],
    }),

    WALK_BACK: clip({
      duration: 720,
      loop: true,
      priority: 12,
      blendIn: 110,
      steps: [
        { t: 0, ease: 'inout' },
        {
          t: 0.3,
          ease: 'out',
          d: { footR: [-7, 1.6], kneeR: [-3.5, 0.9], pelvis: [-1.8, -0.5], chest: [-1.4, -0.3] },
        },
        {
          t: 0.62,
          ease: 'inout',
          d: { footR: [-7, 0], kneeR: [-3.5, 0], footL: [-5, 1.6], kneeL: [-2.5, 0.9], pelvis: [-3.4, 0], chest: [-2.6, 0.2] },
        },
      ],
    }),

    // ---- straights --------------------------------------------------------
    JAB_L: clip({
      duration: 260,
      priority: 50,
      blendIn: 40,
      impactAt: 0.34,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out' },
        {
          t: 0.34,
          ease: 'snap',
          d: {
            handL: [25, 1.4], elbowL: [14, 1.8], shoulderL: [3.4, 0.4],
            chest: [2, 0], pelvis: [1, 0], neck: [1.4, -0.3], head: [1.4, -0.6],
            handR: [0.6, 0], elbowR: [0.4, 0],
          },
        },
        { t: 0.56, ease: 'out', d: { handL: [21, 1.1], elbowL: [11.5, 1.5], shoulderL: [2.6, 0.3], chest: [1.4, 0] } },
        { t: 1, ease: 'inout' },
      ],
    }),

    CROSS_R: clip({
      duration: 360,
      priority: 50,
      blendIn: 40,
      impactAt: 0.4,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out' },
        // Load the rear side before it fires — the wind-up is what sells the power.
        { t: 0.16, ease: 'out', d: { handR: [-3, -1.6], elbowR: [-2, -1.2], shoulderR: [-1.4, 0], pelvis: [-1.2, 0] } },
        {
          t: 0.4,
          ease: 'snap',
          d: {
            handR: [47, -3], elbowR: [24, -1.4], shoulderR: [13, -0.6],
            chest: [5, -0.6], neck: [3.4, -0.7], head: [3.2, -1.1], pelvis: [3.2, -0.6],
            footR: [3.4, 0], kneeR: [3.6, 0.4],
            shoulderL: [-3, -1], elbowL: [-4.5, -2], handL: [-5.5, -1.4],
          },
        },
        {
          t: 0.64,
          ease: 'out',
          d: { handR: [37, -2.4], elbowR: [19, -1], shoulderR: [10, -0.4], chest: [3.8, -0.4], handL: [-3, -0.8] },
        },
        { t: 1, ease: 'inout' },
      ],
    }),

    // ---- hooks ------------------------------------------------------------
    HOOK_L: clip({
      duration: 380,
      priority: 50,
      blendIn: 40,
      impactAt: 0.45,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out' },
        // Elbow lifts to shoulder height first — that is what makes the arc a
        // hook instead of a wide straight.
        { t: 0.15, ease: 'out', d: { handL: [-6, 3.2], elbowL: [-4, 6], shoulderL: [-2, 1.2], chest: [-1, 0] } },
        { t: 0.3, ease: 'inout', d: { handL: [4, 6.4], elbowL: [2.4, 8.4], shoulderL: [0.4, 1.8], chest: [-0.4, 0.2] } },
        {
          t: 0.45,
          ease: 'snap',
          d: {
            handL: [22, 3], elbowL: [10.5, 6], shoulderL: [4.4, 0.6],
            chest: [3.2, 0], pelvis: [2.2, 0], neck: [1.6, -0.4], head: [1.6, -0.8],
            footL: [1.6, 0], kneeL: [1.8, 0],
          },
        },
        { t: 0.64, ease: 'out', d: { handL: [15, 0.6], elbowL: [7, 3], shoulderL: [2.4, 0.2], chest: [1.8, 0] } },
        { t: 1, ease: 'inout' },
      ],
    }),

    HOOK_R: clip({
      duration: 420,
      priority: 50,
      blendIn: 40,
      impactAt: 0.45,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out' },
        { t: 0.16, ease: 'out', d: { handR: [-6, 1.4], elbowR: [-5, 5], shoulderR: [-3, 1.2], pelvis: [-2, 0] } },
        { t: 0.32, ease: 'inout', d: { handR: [6, 4.4], elbowR: [3.4, 8.4], shoulderR: [2.4, 1.6], chest: [0.6, 0.2] } },
        {
          t: 0.45,
          ease: 'snap',
          d: {
            handR: [30, 1.2], elbowR: [15, 5], shoulderR: [11, -0.2],
            chest: [5, -0.5], neck: [3.4, -0.6], head: [3.2, -1], pelvis: [4, 0],
            footR: [4, 0], kneeR: [4.2, 0.4],
            handL: [-4, -1.2], elbowL: [-4, -2],
          },
        },
        { t: 0.66, ease: 'out', d: { handR: [21, 0.4], elbowR: [11, 3], shoulderR: [8, -0.2], chest: [3, -0.3] } },
        { t: 1, ease: 'inout' },
      ],
    }),

    // ---- uppercuts --------------------------------------------------------
    UPPERCUT_L: clip({
      duration: 420,
      priority: 50,
      blendIn: 40,
      impactAt: 0.48,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out' },
        // Dip first: the legs load the punch, then the whole body extends.
        {
          t: 0.22,
          ease: 'out',
          d: {
            pelvis: [0, -5], chest: [0.4, -5.2], neck: [0.4, -4.8], head: [0.6, -4.6],
            hipL: [0, -5], hipR: [0, -5], kneeL: [0.8, -3], kneeR: [-0.8, -3],
            handL: [-2.4, -8], elbowL: [-1.4, -6], shoulderL: [0.2, -4.4],
            handR: [-0.4, -3], elbowR: [-0.4, -3], shoulderR: [0.2, -4.4],
          },
        },
        {
          t: 0.48,
          ease: 'snap',
          d: {
            pelvis: [2, 3], chest: [3, 4.2], neck: [3, 4.4], head: [3.2, 4.4],
            hipL: [1.6, 3], hipR: [1.6, 3], kneeL: [1.2, 1.2], kneeR: [1, 1.2],
            handL: [14, 18], elbowL: [9, 4.4], shoulderL: [4.2, 3.2],
            handR: [1, 2.4], elbowR: [1, 1.4], shoulderR: [2, 3],
          },
        },
        {
          t: 0.7,
          ease: 'out',
          d: { handL: [10, 12], elbowL: [7, 2.4], shoulderL: [3, 1.6], chest: [2, 2], head: [2.2, 2.2], pelvis: [1.2, 1.2] },
        },
        { t: 1, ease: 'inout' },
      ],
    }),

    UPPERCUT_R: clip({
      duration: 440,
      priority: 50,
      blendIn: 40,
      impactAt: 0.48,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out' },
        {
          t: 0.22,
          ease: 'out',
          d: {
            pelvis: [-1, -5.5], chest: [-0.6, -5.6], neck: [-0.4, -5.2], head: [-0.4, -5],
            hipL: [-1, -5.5], hipR: [-1, -5.5], kneeL: [0.6, -3.4], kneeR: [-1, -3.4],
            handR: [-3, -8.5], elbowR: [-2, -6], shoulderR: [-1, -4.6],
            handL: [-1, -3.4], elbowL: [-1, -3.4], shoulderL: [-0.4, -4.6],
          },
        },
        {
          t: 0.48,
          ease: 'snap',
          d: {
            pelvis: [3.4, 3.2], chest: [4.6, 4.6], neck: [4, 4.8], head: [3.8, 4.8],
            hipL: [2.6, 3.2], hipR: [2.6, 3.2], kneeL: [1.6, 1.4], kneeR: [2.4, 1.4],
            handR: [18, 16.5], elbowR: [11, 4.6], shoulderR: [7.5, 3.4],
            handL: [-2, 2.4], elbowL: [-2, 1.2], shoulderL: [0.6, 3],
            footR: [3, 0],
          },
        },
        {
          t: 0.7,
          ease: 'out',
          d: { handR: [12, 11], elbowR: [8, 2.6], shoulderR: [5, 1.8], chest: [3, 2.2], head: [2.6, 2.4], pelvis: [2, 1.4] },
        },
        { t: 1, ease: 'inout' },
      ],
    }),

    // ---- defence ----------------------------------------------------------
    GUARD: clip({
      duration: 1100,
      loop: true,
      priority: 20,
      blendIn: 110,
      steps: [
        {
          t: 0,
          ease: 'inout',
          d: {
            handL: [-8, 6], handR: [-3, 3],
            elbowL: [-5, 2], elbowR: [-1, 2],
            shoulderL: [-1, 0.6], shoulderR: [-0.6, 0.6],
            head: [-1.4, -2], neck: [-1, -1.6], chest: [-1, -1.4],
            pelvis: [0, -2], hipL: [0, -2], hipR: [0, -2],
            kneeL: [0, -1.6], kneeR: [0, -1.6],
          },
        },
        {
          t: 0.5,
          ease: 'inout',
          d: {
            handL: [-8, 6.9], handR: [-3, 3.9],
            elbowL: [-5, 2.8], elbowR: [-1, 2.8],
            shoulderL: [-1, 1.4], shoulderR: [-0.6, 1.4],
            head: [-1.4, -1.2], neck: [-1, -0.8], chest: [-1, -0.6],
            pelvis: [0, -1.3], hipL: [0, -1.3], hipR: [0, -1.3],
            kneeL: [0, -1], kneeR: [0, -1],
          },
        },
      ],
    }),

    BLOCK_IMPACT: clip({
      duration: 190,
      priority: 40,
      blendIn: 25,
      next: 'GUARD',
      steps: [
        {
          t: 0,
          ease: 'snap',
          d: {
            handL: [-8, 6], handR: [-3, 3], elbowL: [-5, 2], elbowR: [-1, 2],
            head: [-1.4, -2], chest: [-1, -1.4], pelvis: [0, -2],
          },
        },
        {
          t: 0.32,
          ease: 'snap',
          d: {
            handL: [-13, 5], handR: [-8, 2], elbowL: [-9, 1], elbowR: [-5, 1],
            head: [-3.6, -3], chest: [-3.4, -2], pelvis: [-1.4, -2.4],
            shoulderL: [-3, 0], shoulderR: [-2.6, 0],
          },
        },
        {
          t: 1,
          ease: 'out',
          d: {
            handL: [-8, 6], handR: [-3, 3], elbowL: [-5, 2], elbowR: [-1, 2],
            head: [-1.4, -2], chest: [-1, -1.4], pelvis: [0, -2],
          },
        },
      ],
    }),

    DODGE_LEFT: clip({
      duration: 380,
      priority: 45,
      blendIn: 45,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out', rot: 0 },
        {
          t: 0.34,
          ease: 'out',
          rot: 0.11,
          d: {
            pelvis: [-2, -2], chest: [-7, -4.2], neck: [-8, -4.4], head: [-9.5, -5],
            shoulderL: [-6, -3], shoulderR: [-7, -3],
            elbowL: [-5, -2.4], elbowR: [-5, -2.4],
            handL: [-6.5, -2.4], handR: [-5.5, -2.4],
            kneeL: [-1, -1.4], kneeR: [-1, -1.4],
          },
        },
        {
          t: 0.62,
          ease: 'inout',
          rot: 0.09,
          d: {
            pelvis: [-1.6, -1.6], chest: [-6, -3.6], neck: [-6.8, -3.8], head: [-8, -4.4],
            shoulderL: [-5, -2.6], shoulderR: [-6, -2.6], handL: [-5.5, -2], handR: [-4.5, -2],
          },
        },
        { t: 1, ease: 'inout', rot: 0 },
      ],
    }),

    DODGE_RIGHT: clip({
      duration: 380,
      priority: 45,
      blendIn: 45,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out', rot: 0 },
        {
          t: 0.34,
          ease: 'out',
          rot: -0.11,
          d: {
            pelvis: [2, -2], chest: [7, -4.2], neck: [8, -4.4], head: [9.5, -5],
            shoulderL: [6, -3], shoulderR: [7, -3],
            elbowL: [5, -2.4], elbowR: [5, -2.4],
            handL: [4.5, -2.4], handR: [5.5, -2.4],
            kneeL: [1, -1.4], kneeR: [1, -1.4],
          },
        },
        {
          t: 0.62,
          ease: 'inout',
          rot: -0.09,
          d: {
            pelvis: [1.6, -1.6], chest: [6, -3.6], neck: [6.8, -3.8], head: [8, -4.4],
            shoulderL: [5, -2.6], shoulderR: [6, -2.6], handL: [4, -2], handR: [4.5, -2],
          },
        },
        { t: 1, ease: 'inout', rot: 0 },
      ],
    }),

    DUCK: clip({
      duration: 900,
      loop: true,
      priority: 45,
      blendIn: 80,
      steps: [
        {
          t: 0,
          ease: 'out',
          d: {
            pelvis: [0, -14], hipL: [0, -14], hipR: [0, -14],
            chest: [1, -15], neck: [1.4, -15.4], head: [2, -16],
            kneeL: [2.4, -8], kneeR: [-2.4, -8],
            shoulderL: [1, -14.4], shoulderR: [1, -14.4],
            elbowL: [0, -11], elbowR: [0, -11],
            handL: [-4, -8], handR: [-2, -6],
          },
        },
        {
          t: 0.5,
          ease: 'inout',
          d: {
            pelvis: [0, -13], hipL: [0, -13], hipR: [0, -13],
            chest: [1, -14], neck: [1.4, -14.4], head: [2, -15],
            kneeL: [2.4, -7.2], kneeR: [-2.4, -7.2],
            shoulderL: [1, -13.4], shoulderR: [1, -13.4],
            elbowL: [0, -10.2], elbowR: [0, -10.2],
            handL: [-4, -7.2], handR: [-2, -5.2],
          },
        },
      ],
    }),

    // ---- reactions --------------------------------------------------------
    HIT_HEAD: clip({
      duration: 300,
      priority: 70,
      blendIn: 20,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'snap', rot: 0 },
        {
          t: 0.26,
          ease: 'snap',
          rot: 0.09,
          d: {
            head: [-7.5, 3], neck: [-5.4, 2.2], chest: [-4, 0.6],
            shoulderL: [-4, 1], shoulderR: [-4.2, 1],
            elbowL: [-6, -2], elbowR: [-5.4, -2],
            handL: [-8.5, -4], handR: [-7.5, -3.4],
            pelvis: [-2, 0],
          },
        },
        {
          t: 0.6,
          ease: 'out',
          rot: 0.03,
          d: { head: [-3, 1], neck: [-2.2, 0.8], chest: [-2, 0], handL: [-4, -2], handR: [-3.4, -1.6] },
        },
        { t: 1, ease: 'inout', rot: 0 },
      ],
    }),

    HIT_BODY: clip({
      duration: 300,
      priority: 70,
      blendIn: 20,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'snap', rot: 0 },
        {
          t: 0.26,
          ease: 'snap',
          rot: -0.15,
          d: {
            chest: [3, -6], neck: [4.4, -7.4], head: [6, -9.4],
            pelvis: [-2, -3], hipL: [-2, -3], hipR: [-2, -3],
            kneeL: [0.6, -3.4], kneeR: [-0.6, -3.4],
            elbowL: [-2, -5], elbowR: [-2, -5],
            handL: [-6, -8], handR: [-4.4, -7],
            shoulderL: [1, -6], shoulderR: [1, -6],
          },
        },
        {
          t: 0.62,
          ease: 'out',
          rot: -0.06,
          d: { chest: [1.4, -2.6], neck: [2, -3], head: [2.6, -4], pelvis: [-1, -1.4], handL: [-3, -3.4], handR: [-2, -3] },
        },
        { t: 1, ease: 'inout', rot: 0 },
      ],
    }),

    STAGGER: clip({
      duration: 620,
      priority: 80,
      blendIn: 30,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'snap', rot: 0, root: [0, 0] },
        {
          t: 0.2,
          ease: 'snap',
          rot: 0.17,
          root: [-4, 0],
          d: {
            head: [-9, 2.4], neck: [-7, 1.4], chest: [-6, 0.4],
            handL: [-10, -6], handR: [-9, -5], elbowL: [-9, -4], elbowR: [-8, -4],
            footR: [-6, 0], kneeR: [-4, 0.6],
          },
        },
        {
          t: 0.5,
          ease: 'inout',
          rot: 0.1,
          root: [-7, 0],
          d: {
            head: [-5, -1], neck: [-4, -1], chest: [-4, -1.2],
            handL: [-12, -4], handR: [-10, -3.4], elbowL: [-10, -2.4], elbowR: [-9, -2.4],
            footL: [-5, 0], kneeL: [-4, 0.4], footR: [-8, 0], kneeR: [-6, 0.4],
          },
        },
        {
          t: 0.78,
          ease: 'out',
          rot: 0.04,
          root: [-4, 0],
          d: { head: [-2, 0], chest: [-2, -0.4], handL: [-6, -2], handR: [-5, -1.4] },
        },
        { t: 1, ease: 'inout', rot: 0, root: [0, 0] },
      ],
    }),

    // ---- canvas -----------------------------------------------------------
    // No `next`: the clip holds its final frame while the referee counts.
    KNOCKDOWN: clip({
      duration: 900,
      priority: 100,
      blendIn: 30,
      steps: [
        { t: 0, ease: 'in', rot: 0, root: [0, 0] },
        {
          t: 0.24,
          ease: 'in',
          rot: 0.34,
          root: [-2, -3],
          d: {
            pelvis: [0, -5], chest: [-2.4, -4], head: [-4.4, -3], neck: [-3.4, -3.4],
            kneeL: [2.4, -2], kneeR: [-2.4, -2],
            handL: [-6, 2.4], handR: [-5, 2.4], elbowL: [-4, 1], elbowR: [-3.4, 1],
          },
        },
        {
          t: 0.58,
          ease: 'linear',
          rot: 0.95,
          root: [-5, -24],
          d: {
            pelvis: [0, -8], chest: [-4, -6], head: [-7, -5], neck: [-5.4, -5.4],
            kneeL: [6, -5], kneeR: [-3.4, -5], footL: [7, -1], footR: [-2, -1],
            handL: [-9, -3], handR: [-7.4, -3], elbowL: [-7, -2], elbowR: [-6, -2],
            shoulderL: [-2.4, -4], shoulderR: [-3.4, -4],
          },
        },
        {
          t: 1,
          ease: 'out',
          rot: 1.46,
          root: [-6, -46],
          d: {
            pelvis: [0, -10], chest: [-5, -8], head: [-9, -7], neck: [-7, -7.4],
            kneeL: [10, -9], kneeR: [-1, -11], footL: [13, -3], footR: [3, -4],
            handL: [-12, -8], handR: [-9, -7], elbowL: [-9, -5], elbowR: [-7.4, -5],
            shoulderL: [-3.4, -7], shoulderR: [-4.6, -7],
            hipL: [1, -9], hipR: [-1, -9],
          },
        },
      ],
    }),

    GET_UP: clip({
      duration: 1100,
      priority: 95,
      blendIn: 60,
      next: 'STANCE',
      steps: [
        {
          t: 0,
          ease: 'inout',
          rot: 1.46,
          root: [-6, -46],
          d: {
            pelvis: [0, -10], chest: [-5, -8], head: [-9, -7], neck: [-7, -7.4],
            kneeL: [10, -9], kneeR: [-1, -11], footL: [13, -3], footR: [3, -4],
            handL: [-12, -8], handR: [-9, -7], elbowL: [-9, -5], elbowR: [-7.4, -5],
            shoulderL: [-3.4, -7], shoulderR: [-4.6, -7], hipL: [1, -9], hipR: [-1, -9],
          },
        },
        {
          t: 0.34,
          ease: 'inout',
          rot: 0.92,
          root: [-4, -30],
          d: {
            pelvis: [0, -12], chest: [-3, -10], head: [-5, -9], neck: [-4, -9.4],
            kneeL: [7, -8], kneeR: [-2, -9], footL: [9, -2], footR: [1, -2],
            handL: [-8, -6], handR: [-6, -5], elbowL: [-6, -4], elbowR: [-5, -4],
            hipL: [1, -11], hipR: [-1, -11],
          },
        },
        {
          t: 0.68,
          ease: 'inout',
          rot: 0.3,
          root: [-2, -12],
          d: {
            // Up onto one knee before standing.
            pelvis: [0, -16], hipL: [0, -16], hipR: [0, -16],
            chest: [1.4, -15], neck: [1.4, -15], head: [2, -15],
            kneeL: [3.4, -8], kneeR: [-4, -14], footR: [-6, -2],
            handL: [-2, -12], handR: [-1, -11], elbowL: [-1, -11], elbowR: [-1, -11],
            shoulderL: [1, -14], shoulderR: [1, -14],
          },
        },
        { t: 1, ease: 'out', rot: 0, root: [0, 0] },
      ],
    }),

    // ---- flourishes -------------------------------------------------------
    RAGE: clip({
      duration: 900,
      priority: 85,
      blendIn: 50,
      next: 'STANCE',
      steps: [
        { t: 0, ease: 'out', rot: 0, scale: 1 },
        {
          t: 0.3,
          ease: 'out',
          rot: -0.1,
          scale: 1.03,
          d: {
            chest: [-1, 2.4], neck: [-2.4, 2.4], head: [-4.4, 2.4],
            handL: [-4, 10], handR: [-2, 10], elbowL: [-4, 6], elbowR: [-3, 6],
            shoulderL: [-2, 2.4], shoulderR: [-2, 2.4], pelvis: [0, -1],
          },
        },
        {
          t: 0.56,
          ease: 'inout',
          rot: -0.14,
          scale: 1.05,
          d: {
            chest: [-1, 3.4], neck: [-2.6, 3.4], head: [-5, 3.4],
            handL: [-2, 16], handR: [0, 15], elbowL: [-2, 10], elbowR: [-1, 10],
            shoulderL: [-2, 3], shoulderR: [-2, 3], pelvis: [0, -0.6],
          },
        },
        { t: 1, ease: 'inout', rot: 0, scale: 1 },
      ],
    }),

    VICTORY: clip({
      duration: 1500,
      loop: true,
      priority: 110,
      blendIn: 180,
      steps: [
        {
          t: 0,
          ease: 'inout',
          root: [0, 0],
          d: {
            handL: [-2, 22], handR: [0, 20], elbowL: [-2, 14], elbowR: [-1, 14],
            shoulderL: [0, 2], shoulderR: [0, 2], head: [0, 1], chest: [0, 1.4],
          },
        },
        {
          t: 0.5,
          ease: 'inout',
          root: [0, 3],
          d: {
            handL: [-2, 25], handR: [0, 23], elbowL: [-2, 16.4], elbowR: [-1, 16.4],
            shoulderL: [0, 3.4], shoulderR: [0, 3.4], head: [0, 2.4], chest: [0, 2.6],
          },
        },
      ],
    }),

    DEFEAT: clip({
      duration: 2400,
      loop: true,
      priority: 110,
      blendIn: 200,
      steps: [
        {
          t: 0,
          ease: 'inout',
          rot: -0.22,
          d: {
            pelvis: [0, -22], hipL: [0, -22], hipR: [0, -22],
            chest: [2, -24], neck: [3, -26], head: [5, -29.4],
            shoulderL: [2, -24], shoulderR: [2, -24],
            elbowL: [0, -22], elbowR: [0, -22],
            handL: [-6, -24], handR: [-4.4, -24],
            kneeL: [4, -18], kneeR: [-6, -24], footR: [-8, -2],
          },
        },
        {
          t: 0.5,
          ease: 'inout',
          rot: -0.2,
          d: {
            pelvis: [0, -21], hipL: [0, -21], hipR: [0, -21],
            chest: [2, -22.8], neck: [3, -24.8], head: [5, -28.2],
            shoulderL: [2, -22.8], shoulderR: [2, -22.8],
            elbowL: [0, -21], elbowR: [0, -21],
            handL: [-6, -23], handR: [-4.4, -23],
            kneeL: [4, -17.4], kneeR: [-6, -23.4], footR: [-8, -2],
          },
        },
      ],
    }),
  };
}

/** Joints whose forward extension scales with a fighter's reach. */
const REACH_JOINTS: JointName[] = ['handL', 'handR', 'elbowL', 'elbowR'];
const ATTACK_STATES: AnimState[] = [
  'JAB_L', 'CROSS_R', 'HOOK_L', 'HOOK_R', 'UPPERCUT_L', 'UPPERCUT_R',
];

/**
 * Builds a library tuned for one fighter. `reach` stretches how far punches
 * extend, `speed` scales every clip's duration.
 */
export function buildAnimLibrary(opts?: { reach?: number; bulk?: number; speed?: number }): AnimLibrary {
  const reach = opts?.reach ?? 1;
  const speed = opts?.speed ?? 1;
  const library = makeLibrary();

  if (Math.abs(reach - 1) > 0.01) {
    for (const state of ATTACK_STATES) {
      for (const frame of library[state].frames) {
        for (const joint of REACH_JOINTS) {
          const p = frame.pose[joint];
          if (!p) continue;
          const base = BASE_STANCE[joint];
          p.x = base.x + (p.x - base.x) * reach;
        }
      }
    }
  }

  if (Math.abs(speed - 1) > 0.01) {
    for (const key of Object.keys(library) as AnimState[]) {
      library[key].duration = Math.max(60, library[key].duration / speed);
    }
  }

  return library;
}

export const ANIM_LIBRARY: AnimLibrary = buildAnimLibrary();
