import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Side } from '@/types/core';
import type { PunchEvent, PunchKind } from '@/types/vision';
import { DEFAULT_CALIBRATION } from '@/types/vision';
import type { RawHand } from './HandTracker';
import type { RawPose } from './PoseTracker';
import { MotionAnalyzer } from './MotionAnalyzer';
import { PunchDetector } from './PunchDetector';
import { GestureDetector } from './GestureDetector';

/**
 * Synthetic harness for the motion pipeline.
 *
 * Punch detection is the one system that cannot be verified by clicking around
 * the UI, so this drives MotionAnalyzer -> PunchDetector -> GestureDetector with
 * fabricated landmark streams and asserts the classifications. It runs entirely
 * offline (no camera, no model) and is safe to call from the browser console:
 *
 *   const { runVisionSelfTest } = await import('/src/vision/visionSelfTest.ts');
 *   console.table(runVisionSelfTest().cases);
 */

export interface SelfTestCase {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
  detail: string;
}

export interface SelfTestReport {
  passed: number;
  failed: number;
  cases: SelfTestCase[];
}

/** Builds a plausible 21-landmark hand centred on (cx, cy) at the given scale. */
function makeHand(cx: number, cy: number, palm: number, labelled: Side): RawHand {
  // Landmarks live in raw (unmirrored) image space; game space mirrors X.
  const rawX = 1 - cx;
  const lm: NormalizedLandmark[] = [];
  for (let i = 0; i < 21; i += 1) {
    lm.push({ x: rawX, y: cy, z: 0, visibility: 1 } as NormalizedLandmark);
  }
  return {
    wrist: { x: cx, y: cy + palm * 0.4 },
    palm: { x: cx, y: cy + palm * 0.2 },
    knuckles: { x: cx, y: cy },
    palmSize: palm,
    openness: 0.2,
    labelled,
    labelScore: 0.95,
    landmarks: lm,
  };
}

function makePose(chestX: number, chestY: number, shoulderWidth: number, noseY: number): RawPose {
  const half = shoulderWidth / 2;
  return {
    nose: { x: chestX, y: noseY },
    shoulderL: { x: chestX - half, y: chestY },
    shoulderR: { x: chestX + half, y: chestY },
    elbowL: { x: chestX - half, y: chestY + 0.1 },
    elbowR: { x: chestX + half, y: chestY + 0.1 },
    hipL: { x: chestX - half * 0.8, y: chestY + 0.22 },
    hipR: { x: chestX + half * 0.8, y: chestY + 0.22 },
    chest: { x: chestX, y: chestY },
    shoulderWidth,
    confidence: 0.95,
    t: 0,
  };
}

interface Rig {
  analyzer: MotionAnalyzer;
  detector: PunchDetector;
  gestures: GestureDetector;
  t: number;
  out: PunchEvent[];
}

const PALM = 0.11;
const NEUTRAL = { chestX: 0.5, chestY: 0.62, shoulders: 0.32, noseY: 0.34 };
/** 30Hz, matching the real vision cadence. */
const STEP = 33;

function newRig(): Rig {
  const rig: Rig = {
    analyzer: new MotionAnalyzer(),
    detector: new PunchDetector(),
    gestures: new GestureDetector(),
    t: 0,
    out: [],
  };
  rig.analyzer.setNeutral({ x: NEUTRAL.chestX, y: NEUTRAL.chestY }, NEUTRAL.shoulders);
  return rig;
}

/** Advances one frame with explicit hand and pose state. */
function step(
  rig: Rig,
  hands: RawHand[],
  pose: RawPose | null,
  collect = true,
): void {
  rig.t += STEP;
  rig.analyzer.updateHands(hands, rig.t);
  rig.analyzer.updatePose(pose, rig.t);
  const g = rig.gestures.update(rig.analyzer, DEFAULT_CALIBRATION, rig.t);
  if (collect) {
    rig.detector.update(rig.analyzer, DEFAULT_CALIBRATION, rig.t, {
      guardHeld: g.guard,
      bothHandsAtFace: rig.gestures.handsAtFaceRaw,
    }, rig.out);
  }
}

/** Settles the rig so the reference palm size and neutral pose are established. */
function settle(rig: Rig, left: { x: number; y: number }, right: { x: number; y: number }, frames = 30): void {
  const pose = makePose(NEUTRAL.chestX, NEUTRAL.chestY, NEUTRAL.shoulders, NEUTRAL.noseY);
  for (let i = 0; i < frames; i += 1) {
    step(rig, [makeHand(left.x, left.y, PALM, 'left'), makeHand(right.x, right.y, PALM, 'right')], pose);
  }
  rig.out.length = 0;
}

/**
 * Drives one hand along a path over `frames` steps while the other holds still.
 * `growth` scales the apparent palm size at the end, standing in for a fist
 * coming towards the lens.
 */
function sweep(
  rig: Rig,
  hand: Side,
  path: { x: number; y: number }[],
  other: { x: number; y: number },
  growth = 1,
): void {
  const pose = makePose(NEUTRAL.chestX, NEUTRAL.chestY, NEUTRAL.shoulders, NEUTRAL.noseY);
  for (let i = 0; i < path.length; i += 1) {
    const p = path[i];
    const k = path.length > 1 ? i / (path.length - 1) : 1;
    const palm = PALM * (1 + (growth - 1) * k);
    const moving = makeHand(p.x, p.y, palm, hand);
    const still = makeHand(other.x, other.y, PALM, hand === 'left' ? 'right' : 'left');
    step(rig, hand === 'left' ? [moving, still] : [still, moving], pose);
  }
}

/** Straight-line path between two points. */
function line(from: { x: number; y: number }, to: { x: number; y: number }, n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 1; i <= n; i += 1) {
    const k = i / n;
    pts.push({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
  }
  return pts;
}

/** Curved arc, used to make a hook read as a hook rather than a straight. */
function arc(
  from: { x: number; y: number },
  to: { x: number; y: number },
  bow: number,
  n: number,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 1; i <= n; i += 1) {
    const k = i / n;
    const bend = Math.sin(k * Math.PI) * bow;
    pts.push({
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k + bend,
    });
  }
  return pts;
}

const describe = (e: PunchEvent | undefined): string =>
  e ? `${e.hand}/${e.kind} pow=${e.power} conf=${e.confidence.toFixed(2)} ${e.tier}` : 'none';

export function runVisionSelfTest(): SelfTestReport {
  const cases: SelfTestCase[] = [];

  const record = (name: string, expected: string, actual: string, pass: boolean, detail = ''): void => {
    cases.push({ name, expected, actual, pass, detail });
  };

  const expectKind = (name: string, e: PunchEvent | undefined, hand: Side, kinds: PunchKind[]): void => {
    const ok = !!e && e.hand === hand && kinds.includes(e.kind);
    record(name, `${hand}/${kinds.join('|')}`, describe(e), ok);
  };

  // --- 1. a committed left straight ---------------------------------------
  {
    const rig = newRig();
    const start = { x: 0.30, y: 0.50 };
    settle(rig, start, { x: 0.64, y: 0.52 });
    // A straight is a committed line across the frame with the fist visibly
    // growing: ~1.5 palm widths in 4 frames (132ms).
    sweep(rig, 'left', line(start, { x: 0.47, y: 0.492 }, 4), { x: 0.64, y: 0.52 }, 1.2);
    // Decelerate so the burst closes.
    sweep(rig, 'left', line({ x: 0.47, y: 0.492 }, { x: 0.472, y: 0.492 }, 4), { x: 0.64, y: 0.52 });
    expectKind('left straight fires as a jab', rig.out[0], 'left', ['jab', 'straight']);
  }

  // --- 2. a committed right straight --------------------------------------
  {
    const rig = newRig();
    const start = { x: 0.70, y: 0.50 };
    settle(rig, { x: 0.36, y: 0.52 }, start);
    sweep(rig, 'right', line(start, { x: 0.53, y: 0.492 }, 4), { x: 0.36, y: 0.52 }, 1.2);
    sweep(rig, 'right', line({ x: 0.53, y: 0.492 }, { x: 0.528, y: 0.492 }, 4), { x: 0.36, y: 0.52 });
    expectKind('right straight fires as a cross', rig.out[0], 'right', ['cross', 'straight']);
  }

  // --- 3. a wide curved hook ----------------------------------------------
  {
    const rig = newRig();
    const start = { x: 0.30, y: 0.50 };
    settle(rig, start, { x: 0.64, y: 0.52 });
    sweep(rig, 'left', arc(start, { x: 0.56, y: 0.48 }, 0.075, 7), { x: 0.64, y: 0.52 }, 1.0);
    sweep(rig, 'left', line({ x: 0.56, y: 0.48 }, { x: 0.562, y: 0.48 }, 4), { x: 0.64, y: 0.52 });
    expectKind('wide lateral arc reads as a hook', rig.out[0], 'left', ['hook']);
  }

  // --- 4. a rising uppercut -------------------------------------------------
  {
    const rig = newRig();
    const start = { x: 0.60, y: 0.68 };
    settle(rig, { x: 0.36, y: 0.52 }, start);
    sweep(rig, 'right', line(start, { x: 0.615, y: 0.44 }, 6), { x: 0.36, y: 0.52 }, 1.0);
    sweep(rig, 'right', line({ x: 0.615, y: 0.44 }, { x: 0.615, y: 0.438 }, 4), { x: 0.36, y: 0.52 });
    expectKind('rising motion reads as an uppercut', rig.out[0], 'right', ['uppercut']);
  }

  // --- 5. slow drift must NOT fire -----------------------------------------
  {
    const rig = newRig();
    const start = { x: 0.36, y: 0.52 };
    settle(rig, start, { x: 0.64, y: 0.52 });
    // Same distance as the jab, but spread over 40 frames (1.3s).
    sweep(rig, 'left', line(start, { x: 0.36, y: 0.42 }, 40), { x: 0.64, y: 0.52 });
    record('slow drift is ignored', 'none', describe(rig.out[0]), rig.out.length === 0);
  }

  // --- 6. tiny jitter must NOT fire ----------------------------------------
  {
    const rig = newRig();
    const start = { x: 0.36, y: 0.52 };
    settle(rig, start, { x: 0.64, y: 0.52 });
    for (let i = 0; i < 24; i += 1) {
      const jx = start.x + Math.sin(i * 1.7) * 0.004;
      const jy = start.y + Math.cos(i * 2.3) * 0.004;
      sweep(rig, 'left', [{ x: jx, y: jy }], { x: 0.64, y: 0.52 });
    }
    record('landmark jitter is ignored', 'none', describe(rig.out[0]), rig.out.length === 0);
  }

  // --- 7. scale invariance: same gesture, hand twice as far from the lens --
  {
    const near = newRig();
    const nStart = { x: 0.30, y: 0.50 };
    settle(near, nStart, { x: 0.64, y: 0.52 });
    sweep(near, 'left', line(nStart, { x: 0.47, y: 0.492 }, 4), { x: 0.64, y: 0.52 }, 1.2);
    sweep(near, 'left', line({ x: 0.47, y: 0.492 }, { x: 0.472, y: 0.492 }, 4), { x: 0.64, y: 0.52 });

    // Half the apparent size, half the pixel travel — the same physical punch.
    const far: Rig = {
      analyzer: new MotionAnalyzer(),
      detector: new PunchDetector(),
      gestures: new GestureDetector(),
      t: 0,
      out: [],
    };
    far.analyzer.setNeutral({ x: NEUTRAL.chestX, y: NEUTRAL.chestY }, NEUTRAL.shoulders);
    const smallPalm = PALM / 2;
    const pose = makePose(NEUTRAL.chestX, NEUTRAL.chestY, NEUTRAL.shoulders, NEUTRAL.noseY);
    const drive = (x: number, y: number, palm: number): void => {
      far.t += STEP;
      far.analyzer.updateHands(
        [makeHand(x, y, palm, 'left'), makeHand(0.58, 0.52, smallPalm, 'right')],
        far.t,
      );
      far.analyzer.updatePose(pose, far.t);
      const g = far.gestures.update(far.analyzer, DEFAULT_CALIBRATION, far.t);
      far.detector.update(far.analyzer, DEFAULT_CALIBRATION, far.t, {
        guardHeld: g.guard,
        bothHandsAtFace: far.gestures.handsAtFaceRaw,
      }, far.out);
    };
    // Half the apparent scale and half the pixel travel: the same punch, twice
    // as far from the lens.
    for (let i = 0; i < 30; i += 1) drive(0.40, 0.50, smallPalm);
    far.out.length = 0;
    for (let i = 1; i <= 4; i += 1) drive(0.40 + 0.085 * (i / 4), 0.496, smallPalm * (1 + 0.2 * (i / 4)));
    for (let i = 0; i < 4; i += 1) drive(0.4855, 0.496, smallPalm * 1.2);

    const bothFired = near.out.length > 0 && far.out.length > 0;
    record(
      'same gesture fires near AND far from the lens',
      'both fire',
      `near=${describe(near.out[0])} far=${describe(far.out[0])}`,
      bothFired,
      'proves velocity is normalised by palm size, not measured in pixels',
    );
  }

  // --- 8. guard latches when both hands sit at the face --------------------
  {
    const rig = newRig();
    settle(rig, { x: 0.42, y: 0.34 }, { x: 0.58, y: 0.34 }, 20);
    let guard = false;
    for (let i = 0; i < 12; i += 1) {
      sweep(rig, 'left', [{ x: 0.42, y: 0.34 }], { x: 0.58, y: 0.34 });
      guard = rig.gestures.current.guard;
    }
    record('both hands at the face latch GUARD', 'guard=true', `guard=${guard}`, guard);
  }

  // --- 9. raising into the guard must not read as a double uppercut --------
  {
    const rig = newRig();
    settle(rig, { x: 0.42, y: 0.56 }, { x: 0.58, y: 0.56 });
    const pose = makePose(NEUTRAL.chestX, NEUTRAL.chestY, NEUTRAL.shoulders, NEUTRAL.noseY);
    // Both hands come up together, briskly, into the shell.
    for (let i = 1; i <= 6; i += 1) {
      const y = 0.56 - (0.56 - 0.34) * (i / 6);
      rig.t += STEP;
      rig.analyzer.updateHands([makeHand(0.42, y, PALM, 'left'), makeHand(0.58, y, PALM, 'right')], rig.t);
      rig.analyzer.updatePose(pose, rig.t);
      const g = rig.gestures.update(rig.analyzer, DEFAULT_CALIBRATION, rig.t);
      rig.detector.update(rig.analyzer, DEFAULT_CALIBRATION, rig.t, {
        guardHeld: g.guard,
        bothHandsAtFace: rig.gestures.handsAtFaceRaw,
      }, rig.out);
    }
    for (let i = 0; i < 8; i += 1) {
      sweep(rig, 'left', [{ x: 0.42, y: 0.34 }], { x: 0.58, y: 0.34 });
    }
    const uppercuts = rig.out.filter((e) => e.kind === 'uppercut').length;
    record('raising the guard is not an uppercut', '0 uppercuts', `${uppercuts} uppercuts`, uppercuts === 0);
  }

  // --- 10. a body lean registers a dodge -----------------------------------
  {
    const rig = newRig();
    settle(rig, { x: 0.36, y: 0.52 }, { x: 0.64, y: 0.52 });
    let dodge: Side | null = null;
    let peakLean = 0;
    for (let i = 1; i <= 16; i += 1) {
      const shift = -0.15 * Math.min(1, i / 7);
      rig.t += STEP;
      rig.analyzer.updateHands(
        [makeHand(0.36 + shift, 0.52, PALM, 'left'), makeHand(0.64 + shift, 0.52, PALM, 'right')],
        rig.t,
      );
      rig.analyzer.updatePose(
        makePose(NEUTRAL.chestX + shift, NEUTRAL.chestY, NEUTRAL.shoulders, NEUTRAL.noseY),
        rig.t,
      );
      const g = rig.gestures.update(rig.analyzer, DEFAULT_CALIBRATION, rig.t);
      peakLean = Math.max(peakLean, Math.abs(rig.analyzer.pose.lean));
      if (g.dodge) dodge = g.dodge;
    }
    record(
      'leaning left registers DODGE LEFT',
      'left',
      `${dodge} (peak lean ${peakLean.toFixed(3)} vs threshold ${DEFAULT_CALIBRATION.dodgeThreshold})`,
      dodge === 'left',
    );
  }

  // --- 11. crouching registers a duck --------------------------------------
  {
    const rig = newRig();
    settle(rig, { x: 0.36, y: 0.52 }, { x: 0.64, y: 0.52 });
    let duck = false;
    for (let i = 1; i <= 14; i += 1) {
      const drop = 0.1 * Math.min(1, i / 6);
      rig.t += STEP;
      rig.analyzer.updateHands(
        [makeHand(0.36, 0.52 + drop, PALM, 'left'), makeHand(0.64, 0.52 + drop, PALM, 'right')],
        rig.t,
      );
      rig.analyzer.updatePose(
        makePose(NEUTRAL.chestX, NEUTRAL.chestY + drop, NEUTRAL.shoulders, NEUTRAL.noseY + drop),
        rig.t,
      );
      const g = rig.gestures.update(rig.analyzer, DEFAULT_CALIBRATION, rig.t);
      if (g.duck) duck = true;
    }
    record('dropping the body registers DUCK', 'duck=true', `duck=${duck}`, duck);
  }

  // --- 12. handedness survives the hands crossing over --------------------
  {
    const rig = newRig();
    settle(rig, { x: 0.36, y: 0.52 }, { x: 0.64, y: 0.52 });
    const pose = makePose(NEUTRAL.chestX, NEUTRAL.chestY, NEUTRAL.shoulders, NEUTRAL.noseY);
    // Swap sides but keep the labels honest — continuity should track them.
    for (let i = 1; i <= 12; i += 1) {
      const k = i / 12;
      rig.t += STEP;
      rig.analyzer.updateHands(
        [
          makeHand(0.36 + 0.28 * k, 0.52, PALM, 'left'),
          makeHand(0.64 - 0.28 * k, 0.52, PALM, 'right'),
        ],
        rig.t,
      );
      rig.analyzer.updatePose(pose, rig.t);
    }
    const leftX = rig.analyzer.left.pos.x;
    const rightX = rig.analyzer.right.pos.x;
    const ok = leftX > rightX; // they crossed, so left is now on the right
    record(
      'hands stay identified after crossing',
      'left tracked past right',
      `left=${leftX.toFixed(2)} right=${rightX.toFixed(2)}`,
      ok,
    );
  }

  const passed = cases.filter((c) => c.pass).length;
  return { passed, failed: cases.length - passed, cases };
}
