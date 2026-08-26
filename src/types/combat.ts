import type { Region, Side } from './core';
import type { AnimState } from './fighter';
import type { PunchKind } from './vision';

export type AttackId = 'jab' | 'cross' | 'hookL' | 'hookR' | 'uppercutL' | 'uppercutR' | 'bodyL' | 'bodyR';

export interface AttackDef {
  id: AttackId;
  name: string;
  kind: PunchKind;
  hand: Side;
  anim: AnimState;
  /** Base damage before power, rage, guard and counter multipliers. */
  damage: number;
  /** Horizontal reach in world pixels, measured from the fighter's centre. */
  range: number;
  target: Region;
  staminaCost: number;
  /** Wind-up before the hitbox goes live. */
  startupMs: number;
  /** How long the hitbox stays live. */
  activeMs: number;
  /** Vulnerable window after the hitbox closes. */
  recoveryMs: number;
  /** Pixels the victim slides back. */
  knockback: number;
  /** Freeze-frame length in ms on a clean hit. */
  hitStop: number;
  /** Screen shake magnitude. */
  shake: number;
  /** Chance this attack staggers on a clean hit, before damage scaling. */
  staggerChance: number;
}

export type HitResult = 'clean' | 'counter' | 'blocked' | 'dodged' | 'whiff' | 'out_of_range';

export interface HitReport {
  attacker: 'player' | 'enemy';
  attack: AttackDef;
  result: HitResult;
  region: Region;
  damage: number;
  /** 0-100 gameplay STRIKE POWER that fed the damage roll. */
  power: number;
  critical: boolean;
  stagger: boolean;
  knockdown: boolean;
  at: number;
  /** World-space impact point for particles. */
  x: number;
  y: number;
}

export type FightPhase =
  | 'intro'
  | 'round_start'
  | 'fighting'
  | 'hit_stop'
  | 'knockdown'
  | 'round_end'
  | 'intermission'
  | 'ko'
  | 'finished'
  | 'paused'
  | 'tracking_lost';

export interface RoundState {
  index: number;
  total: number;
  /** Seconds remaining. */
  timeLeft: number;
  duration: number;
  /** Points scored per round, used for a decision win. */
  scores: { player: number; enemy: number }[];
  roundsWon: { player: number; enemy: number };
}

export interface ComboState {
  count: number;
  /** ms left before the combo drops. */
  window: number;
  best: number;
  /** Damage multiplier earned by the current chain. */
  multiplier: number;
  lastKind: PunchKind | null;
}

export interface FighterVitals {
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  rage: number;
  maxRage: number;
  rageActive: boolean;
  rageTimeLeft: number;
  knockdowns: number;
}

export interface FightStats {
  landed: number;
  missed: number;
  blockedByOpponent: number;
  damageDealt: number;
  damageTaken: number;
  blocks: number;
  dodges: number;
  perfectBlocks: number;
  perfectDodges: number;
  counters: number;
  bestCombo: number;
  knockdownsScored: number;
  knockdownsTaken: number;
  highestPower: number;
  /** Per-hand punch power samples, used for the analytics screen. */
  powerByHand: Record<Side, number[]>;
  /** How many of each punch kind were thrown. */
  kindCounts: Record<PunchKind, number>;
  handCounts: Record<Side, number>;
  comboLengths: number[];
  dodgeDirections: Record<Side, number>;
  timeGuardingMs: number;
  timeAggressiveMs: number;
  fightDurationMs: number;
}

export interface FightIQ {
  aggression: number;
  defense: number;
  countering: number;
  accuracy: number;
  /** e.g. "RIGHT CROSS" */
  favouriteAttack: string;
  preferredHand: Side;
  averageCombo: number;
  dodgePreference: Side | 'balanced';
}

export type Difficulty = 'easy' | 'normal' | 'hard' | 'champion';

export interface DifficultyProfile {
  id: Difficulty;
  name: string;
  description: string;
  /** ms the AI takes to notice and respond to a player action. */
  reactionMs: number;
  reactionJitterMs: number;
  /** Multiplier on how often the AI chooses to attack. */
  aggression: number;
  blockChance: number;
  dodgeChance: number;
  counterChance: number;
  comboChance: number;
  /** Probability the AI does something suboptimal on purpose. */
  mistakeChance: number;
  /** How fast the AI's read on the player converges, 0..1. */
  adaptationRate: number;
  damageMultiplier: number;
  staminaDiscipline: number;
}

export type AIState =
  | 'IDLE'
  | 'OBSERVE'
  | 'APPROACH'
  | 'RETREAT'
  | 'ATTACK'
  | 'COMBO'
  | 'BLOCK'
  | 'DODGE'
  | 'COUNTER'
  | 'RECOVER'
  | 'LOW_STAMINA'
  | 'STAGGER'
  | 'ENRAGED'
  | 'KNOCKED_DOWN'
  | 'GET_UP'
  | 'DEFEATED';

export type EnemyArchetype = 'brawler' | 'defender' | 'speedster' | 'counterpuncher' | 'champion';

export interface EnemyDef {
  id: string;
  name: string;
  archetype: EnemyArchetype;
  title: string;
  bio: string;
  styleId: string;
  maxHp: number;
  maxStamina: number;
  /** Personality knobs the AI controller reads. */
  brain: {
    aggression: number;
    patience: number;
    blockBias: number;
    dodgeBias: number;
    counterBias: number;
    comboBias: number;
    preferredRange: number;
    recoveryMs: number;
    attackCooldownMs: number;
    staminaRecovery: number;
    /** Weighted attack pool. */
    attackWeights: Partial<Record<AttackId, number>>;
    /** How quickly this fighter learns the player's habits. */
    learningRate: number;
  };
  /** Difficulty floor - some fighters are simply harder. */
  powerScale: number;
  speedScale: number;
}

/** Running read on how the player fights, used for adaptive AI. */
export interface PlayerModel {
  samples: number;
  handBias: Record<Side, number>;
  kindBias: Record<PunchKind, number>;
  avgComboLength: number;
  aggression: number;
  defensiveness: number;
  dodgeBias: Record<Side, number>;
  guardRate: number;
  /** Mean gap between the player's punches, in ms. */
  punchIntervalMs: number;
  /** How often the player whiffs — high means punishing is cheap. */
  whiffRate: number;
  /** Confidence in this model, 0..1. */
  confidence: number;
}

export interface FloatingText {
  id: number;
  text: string;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  weight: number;
  shadow?: string;
}
