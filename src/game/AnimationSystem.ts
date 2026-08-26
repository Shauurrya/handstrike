import type { Vec2 } from '@/types/core';
import type { AnimClip, AnimLibrary, AnimState, Ease, JointName, RigPose } from '@/types/fighter';
import { JOINT_NAMES } from '@/types/fighter';
import { ANIM_LIBRARY, BASE_STANCE } from '@/data/animations';
import { easeBack, easeIn, easeInOut, easeOut, easeSnap, lerp } from '@/utils/math';

/**
 * Plays and blends the skeletal clips.
 *
 * Three things make the fighters read as animated rather than posed:
 *  - clips store *sparse* overrides, so a jab only says what the jab arm does
 *    and everything else keeps breathing from the base stance;
 *  - entering a clip cross-fades from whatever was on screen, so states never
 *    pop; and
 *  - clips carry priorities, so a knockdown cannot be interrupted by an idle
 *    bob but a hit reaction can cut an attack short.
 */

export interface AnimSample {
  pose: RigPose;
  root: Vec2;
  rot: number;
  scale: number;
}

type EaseFn = (t: number) => number;

const EASE_FNS: Record<Ease, EaseFn> = {
  linear: (t) => t,
  in: easeIn,
  out: easeOut,
  inout: easeInOut,
  snap: easeSnap,
  back: easeBack,
};

/** Per-clip index of which keyframes touch which joint, built once per clip. */
interface ClipIndex {
  /** For each joint, the ascending list of keyframe indices that define it. */
  joints: Map<JointName, number[]>;
  rootFrames: number[];
  rotFrames: number[];
  scaleFrames: number[];
}

const clipIndexCache = new WeakMap<AnimClip, ClipIndex>();

function buildIndex(clip: AnimClip): ClipIndex {
  const joints = new Map<JointName, number[]>();
  const rootFrames: number[] = [];
  const rotFrames: number[] = [];
  const scaleFrames: number[] = [];

  for (let i = 0; i < clip.frames.length; i += 1) {
    const f = clip.frames[i];
    for (const name of JOINT_NAMES) {
      if (f.pose[name]) {
        let list = joints.get(name);
        if (!list) {
          list = [];
          joints.set(name, list);
        }
        list.push(i);
      }
    }
    if (f.root) rootFrames.push(i);
    if (f.rot !== undefined) rotFrames.push(i);
    if (f.scale !== undefined) scaleFrames.push(i);
  }

  return { joints, rootFrames, rotFrames, scaleFrames };
}

function indexFor(clip: AnimClip): ClipIndex {
  let idx = clipIndexCache.get(clip);
  if (!idx) {
    idx = buildIndex(clip);
    clipIndexCache.set(clip, idx);
  }
  return idx;
}

const clonePose = (src: RigPose): RigPose => {
  const out = {} as RigPose;
  for (const name of JOINT_NAMES) out[name] = { x: src[name].x, y: src[name].y };
  return out;
};

const copyPoseInto = (dst: RigPose, src: RigPose): void => {
  for (const name of JOINT_NAMES) {
    dst[name].x = src[name].x;
    dst[name].y = src[name].y;
  }
};

export class AnimationSystem {
  private library: AnimLibrary;
  private base: RigPose;
  private clip: AnimClip;
  private state: AnimState = 'STANCE';

  /** Elapsed ms inside the current clip, already speed-scaled. */
  private time = 0;
  private clipSpeed = 1;
  private speedScale = 1;
  private done = false;

  private impactFired = false;
  private impactPending = false;

  /** Cross-fade bookkeeping. */
  private blendMs = 0;
  private blendDur = 0;
  private readonly blendPose: RigPose;
  private blendRoot: Vec2 = { x: 0, y: 0 };
  private blendRot = 0;
  private blendScale = 1;

  /** Reused every frame — callers must not retain the returned object. */
  private readonly out: AnimSample;

  constructor(library: AnimLibrary = ANIM_LIBRARY, base: RigPose = BASE_STANCE) {
    this.library = library;
    this.base = base;
    this.clip = library.STANCE;
    this.blendPose = clonePose(base);
    this.out = { pose: clonePose(base), root: { x: 0, y: 0 }, rot: 0, scale: 1 };
  }

  get current(): AnimState {
    return this.state;
  }

  get phase(): number {
    const d = this.clip.duration / this.effectiveSpeed();
    return d > 0 ? Math.min(1, this.time / d) : 1;
  }

  get finished(): boolean {
    return this.done;
  }

  private effectiveSpeed(): number {
    return Math.max(0.1, this.clipSpeed * this.speedScale);
  }

  setSpeedScale(s: number): void {
    this.speedScale = Math.max(0.1, s);
  }

  setLibrary(library: AnimLibrary, base?: RigPose): void {
    this.library = library;
    if (base) this.base = base;
    this.clip = library[this.state] ?? library.STANCE;
  }

  /**
   * Requests a state. Returns false when the current clip outranks it —
   * that is what stops an idle bob cancelling a knockdown.
   */
  play(state: AnimState, opts?: { force?: boolean; speed?: number }): boolean {
    const next = this.library[state];
    if (!next) return false;
    const force = opts?.force ?? false;

    if (state === this.state && !force) return true;

    if (!force && !this.clip.loop && !this.done && next.priority < this.clip.priority) {
      return false;
    }

    // Snapshot whatever is currently on screen so the new clip fades in from
    // the real pose rather than from its own first keyframe.
    const blend = next.blendIn ?? 0;
    if (blend > 0) {
      this.writeSample();
      copyPoseInto(this.blendPose, this.out.pose);
      this.blendRoot = { x: this.out.root.x, y: this.out.root.y };
      this.blendRot = this.out.rot;
      this.blendScale = this.out.scale;
      this.blendDur = blend;
      this.blendMs = 0;
    } else {
      this.blendDur = 0;
      this.blendMs = 0;
    }

    this.state = state;
    this.clip = next;
    this.time = 0;
    this.done = false;
    this.clipSpeed = opts?.speed ?? 1;
    this.impactFired = false;
    this.impactPending = false;
    return true;
  }

  /** True exactly once, on the update that crosses the clip's impact marker. */
  consumeImpact(): boolean {
    if (!this.impactPending) return false;
    this.impactPending = false;
    return true;
  }

  update(dtMs: number): void {
    const duration = this.clip.duration / this.effectiveSpeed();
    const before = this.time;
    this.time += dtMs;

    if (this.blendDur > 0) {
      this.blendMs += dtMs;
      if (this.blendMs >= this.blendDur) this.blendDur = 0;
    }

    const impactAt = this.clip.impactAt;
    if (impactAt !== undefined && !this.impactFired) {
      const marker = impactAt * duration;
      if (before < marker && this.time >= marker) {
        this.impactFired = true;
        this.impactPending = true;
      }
    }

    if (this.time >= duration) {
      if (this.clip.loop) {
        this.time = duration > 0 ? this.time % duration : 0;
        this.impactFired = false;
      } else if (!this.done) {
        this.done = true;
        this.time = duration;
        // Only fall through when the clip names a successor. A clip with no
        // `next` holds its final frame — that is how KNOCKDOWN keeps the
        // fighter on the canvas while the referee counts.
        const next = this.clip.next;
        if (next && next !== this.state) this.play(next, { force: true });
      }
    }
  }

  sample(): AnimSample {
    this.writeSample();
    return this.out;
  }

  private writeSample(): void {
    const clip = this.clip;
    const duration = clip.duration / this.effectiveSpeed();
    const t = duration > 0 ? Math.min(1, this.time / duration) : 1;
    const idx = indexFor(clip);
    const frames = clip.frames;

    // --- joints -----------------------------------------------------------
    for (const name of JOINT_NAMES) {
      const list = idx.joints.get(name);
      const target = this.out.pose[name];
      const baseJoint = this.base[name];

      if (!list || list.length === 0) {
        target.x = baseJoint.x;
        target.y = baseJoint.y;
        continue;
      }

      let prevIdx = -1;
      let nextIdx = -1;
      for (let i = 0; i < list.length; i += 1) {
        const fi = list[i];
        if (frames[fi].t <= t) prevIdx = fi;
        else {
          nextIdx = fi;
          break;
        }
      }

      if (prevIdx === -1) {
        // Before the first keyframe that mentions this joint: ease out of the
        // base stance into it.
        const nf = frames[nextIdx];
        const nv = nf.pose[name] as Vec2;
        const span = nf.t;
        const k = span > 1e-6 ? EASE_FNS[nf.ease ?? 'inout'](t / span) : 1;
        target.x = lerp(baseJoint.x, nv.x, k);
        target.y = lerp(baseJoint.y, nv.y, k);
        continue;
      }

      const pf = frames[prevIdx];
      const pv = pf.pose[name] as Vec2;

      if (nextIdx === -1) {
        target.x = pv.x;
        target.y = pv.y;
        continue;
      }

      const nf = frames[nextIdx];
      const nv = nf.pose[name] as Vec2;
      const span = nf.t - pf.t;
      const k = span > 1e-6 ? EASE_FNS[nf.ease ?? 'inout']((t - pf.t) / span) : 1;
      target.x = lerp(pv.x, nv.x, k);
      target.y = lerp(pv.y, nv.y, k);
    }

    // --- root / rotation / scale -------------------------------------------
    this.out.root.x = this.scalarPair(idx.rootFrames, t, (f) => f.root?.x ?? 0, 0);
    this.out.root.y = this.scalarPair(idx.rootFrames, t, (f) => f.root?.y ?? 0, 0);
    this.out.rot = this.scalarPair(idx.rotFrames, t, (f) => f.rot ?? 0, 0);
    this.out.scale = this.scalarPair(idx.scaleFrames, t, (f) => f.scale ?? 1, 1);

    // --- cross-fade ---------------------------------------------------------
    if (this.blendDur > 0) {
      const k = easeOut(Math.min(1, this.blendMs / this.blendDur));
      for (const name of JOINT_NAMES) {
        const target = this.out.pose[name];
        const from = this.blendPose[name];
        target.x = lerp(from.x, target.x, k);
        target.y = lerp(from.y, target.y, k);
      }
      this.out.root.x = lerp(this.blendRoot.x, this.out.root.x, k);
      this.out.root.y = lerp(this.blendRoot.y, this.out.root.y, k);
      this.out.rot = lerp(this.blendRot, this.out.rot, k);
      this.out.scale = lerp(this.blendScale, this.out.scale, k);
    }
  }

  /** Interpolates one scalar channel across the keyframes that define it. */
  private scalarPair(
    list: number[],
    t: number,
    read: (f: AnimClip['frames'][number]) => number,
    fallback: number,
  ): number {
    if (list.length === 0) return fallback;
    const frames = this.clip.frames;

    let prevIdx = -1;
    let nextIdx = -1;
    for (let i = 0; i < list.length; i += 1) {
      const fi = list[i];
      if (frames[fi].t <= t) prevIdx = fi;
      else {
        nextIdx = fi;
        break;
      }
    }

    if (prevIdx === -1) {
      const nf = frames[nextIdx];
      const span = nf.t;
      const k = span > 1e-6 ? EASE_FNS[nf.ease ?? 'inout'](t / span) : 1;
      return lerp(fallback, read(nf), k);
    }
    if (nextIdx === -1) return read(frames[prevIdx]);

    const pf = frames[prevIdx];
    const nf = frames[nextIdx];
    const span = nf.t - pf.t;
    const k = span > 1e-6 ? EASE_FNS[nf.ease ?? 'inout']((t - pf.t) / span) : 1;
    return lerp(read(pf), read(nf), k);
  }

  reset(state: AnimState = 'STANCE'): void {
    this.state = state;
    this.clip = this.library[state] ?? this.library.STANCE;
    this.time = 0;
    this.done = false;
    this.clipSpeed = 1;
    this.blendDur = 0;
    this.blendMs = 0;
    this.impactFired = false;
    this.impactPending = false;
    copyPoseInto(this.out.pose, this.base);
    this.out.root.x = 0;
    this.out.root.y = 0;
    this.out.rot = 0;
    this.out.scale = 1;
  }
}
