import type { Region, Side } from './core';
import type { AIState, AttackId, PlayerModel } from './combat';
import type { PunchKind } from './vision';

/**
 * The read-only snapshot the AI is allowed to see. Keeping this narrow means the
 * AI reasons about the fight the way a fighter would rather than reaching into
 * engine internals — and it makes the controller trivially testable.
 */
export interface AIView {
  now: number;
  /** Centre-to-centre horizontal distance between the fighters, in world px. */
  gap: number;
  selfHp: number;
  selfHpMax: number;
  selfStamina: number;
  selfStaminaMax: number;
  selfRecovering: boolean;
  selfStaggered: boolean;
  selfDowned: boolean;
  selfRage: boolean;
  opponentHp: number;
  opponentHpMax: number;
  opponentStamina: number;
  opponentStaminaMax: number;
  opponentGuarding: boolean;
  opponentDowned: boolean;
  opponentRage: boolean;
  /** True while the player has an attack in startup or active frames. */
  opponentAttacking: boolean;
  /** ms until the incoming attack lands, or null when nothing is incoming. */
  incomingImpactInMs: number | null;
  incomingRegion: Region | null;
  incomingKind: PunchKind | null;
  incomingHand: Side | null;
  /** How long the player has gone without throwing anything, in ms. */
  opponentIdleMs: number;
  /** Rolling read on how the player fights. */
  model: PlayerModel;
  /** Fraction of the round elapsed, 0..1. */
  roundProgress: number;
  roundIndex: number;
  /** True when combat is frozen (hit-stop, knockdown, tracking lost). */
  frozen: boolean;
}

export interface AIDecision {
  state: AIState;
  /** Attack to commit to this frame, or null. */
  attack: AttackId | null;
  /** -1 backs off, 0 holds, 1 closes distance. */
  move: -1 | 0 | 1;
  guard: boolean;
  /** Sidestep to trigger this frame. */
  dodge: Side | null;
  /** Free-text reason, surfaced in the debug panel. */
  reason: string;
}

/** Everything the engine tells the AI about what just happened. */
export interface AIEvents {
  onPlayerAttackStart(info: { kind: PunchKind; hand: Side; region: Region; impactAtMs: number }): void;
  onPlayerAttackResolved(info: { landed: boolean; blocked: boolean; dodged: boolean }): void;
  onSelfHit(info: { damage: number; region: Region; staggered: boolean }): void;
  onSelfLanded(info: { damage: number; blocked: boolean }): void;
  onKnockdown(who: 'self' | 'opponent'): void;
  onRoundStart(index: number): void;
}
