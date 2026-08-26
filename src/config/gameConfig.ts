/**
 * Central tuning file. Everything that affects game feel lives here so the
 * balance can be adjusted without hunting through systems.
 */

/** Logical design resolution. The canvas letterboxes to preserve this aspect. */
export const WORLD = {
  width: 1600,
  height: 900,
  /** Y of the canvas mat where fighters stand. */
  floorY: 726,
  /** Playable horizontal bounds inside the ropes. */
  minX: 300,
  maxX: 1300,
  /** On-screen height of a 100-unit rig, in pixels. */
  fighterHeight: 330,
} as const;

export const COMBAT = {
  /** Distance between fighter centres at which most punches connect. */
  engageRange: 300,
  /** Where the AI likes to sit when not committed. */
  neutralGap: 360,
  minGap: 190,
  maxGap: 620,
  /** How fast fighters walk, px/sec. */
  walkSpeed: 210,
  dodgeSlide: 130,
  /** Damage multiplier while the defender is guarding. */
  guardDamageScale: 0.22,
  /** Extra reduction for a perfectly timed block. */
  perfectBlockScale: 0.0,
  perfectBlockWindowMs: 220,
  perfectDodgeWindowMs: 260,
  /** How long a counter window stays open after a perfect defence. */
  counterWindowMs: 900,
  counterDamageBonus: 0.25,
  criticalChanceBase: 0.06,
  criticalMultiplier: 1.6,
  /** Health fraction below which a big hit can floor you. */
  knockdownDamageThreshold: 16,
  knockdownCountSeconds: 3,
  getUpMs: 1100,
  maxKnockdownsPerRound: 3,
  hitStopMsBase: 55,
  staggerMs: 620,
  /** Multiplier applied to all damage while RAGE is active. */
  rageDamageScale: 1.55,
  rageSpeedScale: 1.3,
  rageDurationMs: 9000,
  rageDamageTakenScale: 0.8,
} as const;

export const STAMINA = {
  max: 100,
  /** Per second while idle. */
  regen: 15,
  /** Per second while guarding (a small drain). */
  guardDrain: 7,
  dodgeCost: 9,
  /** Below this fraction, punches weaken and recovery slows. */
  tiredThreshold: 0.3,
  exhaustedThreshold: 0.12,
  /** Damage scale applied when exhausted. */
  tiredDamageScale: 0.6,
  /** Delay before regen kicks in after acting, in ms. */
  regenDelayMs: 550,
} as const;

export const RAGE = {
  max: 100,
  onHitLanded: 4.5,
  onComboStep: 2.2,
  onBlock: 3,
  onPerfectBlock: 9,
  onDodge: 3,
  onPerfectDodge: 11,
  onCounter: 10,
  onDamageTaken: 0.25,
  /** Passive decay per second when not in rage. */
  decayPerSec: 0.6,
} as const;

export const COMBO = {
  windowMs: 1250,
  /** Extra damage per combo step, capped. */
  damagePerStep: 0.07,
  maxMultiplier: 1.7,
  /** Combo counts above this get the big on-screen treatment. */
  bigComboAt: 5,
} as const;

export const ROUNDS = {
  count: 3,
  durationSec: 120,
  intermissionSec: 12,
  introMs: 2600,
  roundCardMs: 2200,
  /** Points awarded for a round win on the judges' cards. */
  winPoints: 10,
  losePoints: 9,
  knockdownPenalty: 1,
} as const;

export const VISION = {
  /** Vision runs at most this often; rendering stays at full rate. */
  targetHz: 30,
  /** Pose is heavier than hands, so it runs at a lower cadence. */
  poseEveryNthFrame: 2,
  /** ms a hand can vanish before it is reported lost. */
  handGraceMs: 320,
  poseGraceMs: 600,
  /** ms of no tracking before the fight auto-pauses. */
  trackingLostMs: 1200,
  /** Per-hand cooldown between punches. */
  punchCooldownMs: 230,
  /** Global cooldown so both hands cannot fire on the same frame. */
  globalPunchCooldownMs: 90,
  /** Motion history window used for classification. */
  motionWindowMs: 300,
  /** Punch must complete within this window to count as one burst. */
  burstMaxMs: 420,
  guardHoldMs: 130,
  guardReleaseMs: 180,
  duckHoldMs: 110,
  dodgeCooldownMs: 420,
  rageGestureHoldMs: 420,
} as const;

export const FEEL = {
  shakeDecay: 6.5,
  maxShake: 34,
  hitFlashMs: 130,
  slowMoScale: 0.28,
  slowMoMs: 380,
  particleBudget: 420,
} as const;

export const CAREER_RANKS = ['ROOKIE', 'CONTENDER', 'PRO', 'CHAMPION'] as const;
export type CareerRank = (typeof CAREER_RANKS)[number];

/** Colour tokens shared between canvas rendering and the React UI. */
export const PALETTE = {
  bg: '#06070d',
  panel: '#0d0f19',
  panelEdge: '#1d2133',
  ink: '#eef1ff',
  inkDim: '#8a90ad',
  player: '#31e6c8',
  enemy: '#ff2d6f',
  warn: '#ffb020',
  rage: '#ff6a00',
  good: '#48e08a',
  crit: '#ffd34d',
  counter: '#7c5cff',
} as const;
