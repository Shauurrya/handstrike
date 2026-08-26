import type { Facing, Region, Side, Vec2 } from './core';

/**
 * Animation + rendering contracts.
 *
 * Fighters are driven by a 2D skeletal rig rather than a stretched static image,
 * so every state below is a genuinely different pose rather than a transform of
 * the same picture. A `FighterSkin` turns a posed rig into pixels — the
 * procedural skin ships today, a sprite-sheet skin can be dropped in later
 * without touching combat code (see `src/render/skins`).
 */

export type AnimState =
  | 'IDLE'
  | 'STANCE'
  | 'WALK_FWD'
  | 'WALK_BACK'
  | 'JAB_L'
  | 'CROSS_R'
  | 'HOOK_L'
  | 'HOOK_R'
  | 'UPPERCUT_L'
  | 'UPPERCUT_R'
  | 'GUARD'
  | 'BLOCK_IMPACT'
  | 'DODGE_LEFT'
  | 'DODGE_RIGHT'
  | 'DUCK'
  | 'HIT_HEAD'
  | 'HIT_BODY'
  | 'STAGGER'
  | 'KNOCKDOWN'
  | 'GET_UP'
  | 'RAGE'
  | 'VICTORY'
  | 'DEFEAT';

export type JointName =
  | 'pelvis'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'elbowL'
  | 'handL'
  | 'shoulderR'
  | 'elbowR'
  | 'handR'
  | 'hipL'
  | 'kneeL'
  | 'footL'
  | 'hipR'
  | 'kneeR'
  | 'footR';

export const JOINT_NAMES: JointName[] = [
  'pelvis', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'handL',
  'shoulderR', 'elbowR', 'handR',
  'hipL', 'kneeL', 'footL',
  'hipR', 'kneeR', 'footR',
];

/**
 * Joint positions in fighter-local units. Origin is between the feet, +X points
 * the way the fighter faces, +Y points UP. A fighter is ~100 units tall, so the
 * same rig scales to any on-screen size.
 */
export type RigPose = Record<JointName, Vec2>;

export type Ease = 'linear' | 'in' | 'out' | 'inout' | 'snap' | 'back';

export interface AnimFrame {
  /** Normalised time within the clip, 0..1. */
  t: number;
  /** Sparse override on top of the fighter's base stance. */
  pose: Partial<RigPose>;
  ease?: Ease;
  /** Whole-body translation in local units. */
  root?: Vec2;
  /** Whole-body rotation in radians (positive = leaning forward). */
  rot?: number;
  /** Squash/stretch multiplier. */
  scale?: number;
}

export interface AnimClip {
  duration: number;
  loop: boolean;
  frames: AnimFrame[];
  /** Normalised time at which an attack's hitbox goes live. */
  impactAt?: number;
  /** Higher priority clips interrupt lower ones. */
  priority: number;
  /** Cross-fade duration in ms when entering this clip. */
  blendIn?: number;
  /** Where the clip lands when it finishes (defaults to STANCE). */
  next?: AnimState;
}

export type AnimLibrary = Record<AnimState, AnimClip>;

/** Purely cosmetic identity — swap these to make a new-looking fighter. */
export interface FighterStyle {
  id: string;
  name: string;
  /** Short tagline shown on the select screen. */
  tagline: string;
  skin: string;
  skinShadow: string;
  trunks: string;
  trunksTrim: string;
  glove: string;
  gloveTrim: string;
  boots: string;
  accent: string;
  hair: string;
  /** Optional cosmetic extras the procedural skin knows how to draw. */
  features: {
    headgear?: boolean;
    beard?: boolean;
    hairStyle?: 'buzz' | 'afro' | 'mohawk' | 'topknot' | 'bald' | 'short';
    tattoo?: 'none' | 'sleeve' | 'chest';
    mask?: boolean;
    /** Body proportion multipliers to give silhouettes real variety. */
    bulk?: number;
    height?: number;
    reach?: number;
  };
}

export interface RenderState {
  /** Final blended rig for this frame. */
  pose: RigPose;
  root: Vec2;
  rot: number;
  scale: number;
  state: AnimState;
  /** Progress through the current clip, 0..1. */
  phase: number;
  facing: Facing;
  /** Screen-space position of the fighter's feet. */
  worldX: number;
  worldY: number;
  /** On-screen height in pixels. */
  height: number;
  /** 0..1 white flash applied on hit. */
  flash: number;
  /** 0..1 rage aura intensity. */
  rage: number;
  guarding: boolean;
  downed: boolean;
  /** Fades the whole fighter, used for KO fade-outs. */
  alpha: number;
}

/** Anything that can paint a fighter. Implemented by the procedural skin today. */
export interface FighterSkin {
  readonly id: string;
  /** Called once per frame with the fully blended rig. */
  draw(ctx: CanvasRenderingContext2D, rs: RenderState, style: FighterStyle, timeMs: number): void;
  /** Small portrait used in menus and the HUD. */
  drawPortrait(ctx: CanvasRenderingContext2D, style: FighterStyle, box: { x: number; y: number; w: number; h: number }, timeMs: number): void;
}

/** Live hurtboxes, recomputed from the posed rig every frame. */
export interface Hurtbox {
  region: Region;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a fighter's gloves currently are in world space. */
export type GlovePositions = Record<Side, Vec2>;
