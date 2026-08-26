import { COMBAT } from '@/config/gameConfig';
import { ATTACKS, ATTACK_LIST } from '@/data/attacks';
import type { PlayerProfiler } from '@/game/PlayerProfiler';
import type { AIDecision, AIEvents, AIView } from '@/types/ai';
import type { AIState, AttackDef, AttackId, DifficultyProfile, EnemyDef } from '@/types/combat';
import type { Region, Side } from '@/types/core';
import type { PunchKind } from '@/types/vision';
import { clamp, clamp01, remap, Rng } from '@/utils/math';

/**
 * The opponent brain.
 *
 * Two ideas carry the whole thing.
 *
 * **Nothing is instant.** Every response to the player goes through a reaction
 * queue: `onPlayerAttackStart` only *schedules* a decision for `reactionMs +
 * jitter` in the future, and if the punch lands before that moment the AI wears
 * it. That single rule is what makes AMATEUR beatable and UNDISPUTED terrifying
 * without ever touching damage numbers, and it is why the AI never feels like it
 * is reading the input buffer.
 *
 * **Everything is a read.** The `PlayerProfiler` watches habits — a favourite
 * hand, a favourite punch, a slip that always goes the same way — and this
 * controller spends them: guarding the side you throw from, blocking the punch
 * you love, walking you down once you have burnt your tank. Every adaptation is
 * scaled by `model.confidence * profile.adaptationRate`, so a thin read never
 * swings behaviour and the fight only tightens once you have actually shown it
 * something.
 *
 * The state machine itself is deliberately boring: one committed action at a
 * time, a beat-based clock instead of per-frame dice, and a single mutated
 * decision object so `update` allocates nothing on the common path.
 */

type AttackMode = 'open' | 'chain' | 'counter' | 'reckless';

interface PendingRead {
  active: boolean;
  /** Absolute time the scheduled reaction is allowed to resolve. */
  fireAt: number;
  impactAt: number;
  kind: PunchKind;
  hand: Side;
  region: Region;
}

/** Slack around the preferred gap. Without it the AI paces like a metronome. */
const RANGE_DEADZONE = 46;

const LOW_STAMINA_ENTER = 0.25;
const LOW_STAMINA_EXIT = 0.5;
/** How often the read on the player is rebuilt. Per-frame would be pure noise. */
const ADAPT_REFRESH_MS = 150;
const CHAIN_WINDOW_MS = 820;
/** Each extra punch in a combination is markedly less likely than the last. */
const CHAIN_DECAY = 0.55;
const MAX_CHAIN = 4;
/** Opponent stamina fraction that turns a patient fighter into a hunter. */
const PUNISH_STAMINA = 0.35;

/** Tell thresholds — how lopsided a habit must be before it counts as a read. */
const HAND_TELL = 0.62;
const KIND_TELL = 0.34;
const DODGE_TELL = 0.62;
const WHIFF_TELL = 0.35;

const PUNCH_KINDS: PunchKind[] = ['jab', 'cross', 'hook', 'uppercut', 'straight'];

const HAND_LABEL: Record<Side, string> = { left: 'LEFT', right: 'RIGHT' };
const KIND_LABEL: Record<PunchKind, string> = {
  jab: 'JAB',
  cross: 'CROSS',
  hook: 'HOOK',
  uppercut: 'UPPERCUT',
  straight: 'STRAIGHT',
};

const mirrorSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');

/**
 * Fighters stand facing each other, so the player's RIGHT hand arrives on the
 * AI's LEFT. Slipping *away* from it means stepping to the AI's own right —
 * which, once mirrored, carries the same label as the punching hand. Slipping
 * the other way walks straight into the shot, which is exactly what the
 * deliberate-mistake path picks.
 */
const slipAway = (hand: Side): Side => hand;
const slipInto = (hand: Side): Side => mirrorSide(hand);

export class AIController implements AIEvents {
  private readonly def: EnemyDef;
  private readonly profile: DifficultyProfile;
  private readonly profiler: PlayerProfiler;
  private readonly seed: number;
  private rng: Rng;

  /** Attack pool with live weights, mutated in place so picking allocates nothing. */
  private readonly pool: [AttackDef, number][] = [];
  private readonly baseWeights: number[] = [];

  private readonly out: AIDecision = {
    state: 'IDLE',
    attack: null,
    move: 0,
    guard: false,
    dodge: null,
    reason: 'ready',
  };

  private readonly dbg: {
    state: AIState;
    reason: string;
    reactionMs: number;
    adaptation: string;
    nextActionInMs: number;
  } = { state: 'IDLE', reason: 'ready', reactionMs: 0, adaptation: 'feeling it out', nextActionInMs: 0 };

  /** Single-slot reaction queue: the AI can only track one incoming punch. */
  private readonly pending: PendingRead = {
    active: false,
    fireAt: 0,
    impactAt: 0,
    kind: 'jab',
    hand: 'left',
    region: 'head',
  };

  private readonly phrases: string[] = [];

  private st: AIState = 'IDLE';
  private reason = 'ready';
  private now = 0;
  private roundIndex = 0;

  // --- timers, all absolute against view.now -------------------------------
  private nextActionAt = 0;
  private busyUntil = 0;
  private busyGuard = false;
  private busyReason = 'committed';
  private guardUntil = 0;
  private dropGuardUntil = 0;
  private counterUntil = 0;
  private retreatUntil = 0;
  private getUpUntil = 0;
  private guardBreakUntil = 0;
  private staminaRollAt = 0;

  // --- offence bookkeeping -------------------------------------------------
  private chainUntil = 0;
  private chainP = 0;
  private comboStep = 0;
  private lastAttack: AttackId | null = null;
  private lowStamina = false;
  private recklessTank = false;
  private lastReactionMs = 0;

  // --- the read on the player ----------------------------------------------
  private adaptTimer = ADAPT_REFRESH_MS;
  private adaptTrust = 0;
  private adaptKey = -1;
  private adaptSummary = 'feeling it out';
  private adaptTellHand: Side | null = null;
  private adaptTellKind: PunchKind | null = null;
  private adaptFollowHand: Side | null = null;
  private adaptBlockBonus = 0;
  private adaptDodgeBonus = 0;
  private adaptCounterBonus = 0;
  private adaptBodyBias = 0;
  private adaptPatience = 0;
  private adaptDelayMs = 0;

  constructor(def: EnemyDef, profile: DifficultyProfile, profiler: PlayerProfiler, seed = 0x51f1a5) {
    this.def = def;
    this.profile = profile;
    this.profiler = profiler;
    this.seed = seed >>> 0 || 1;
    this.rng = new Rng(this.seed);

    for (const a of ATTACK_LIST) {
      const w = def.brain.attackWeights[a.id];
      if (w === undefined || w <= 0) continue;
      this.pool.push([a, w]);
      this.baseWeights.push(w);
    }
    // A fighter with an empty move list would stand there all night.
    if (!this.pool.length) {
      this.pool.push([ATTACKS.jab, 1]);
      this.baseWeights.push(1);
    }
  }

  // ==========================================================================
  // Frame loop
  // ==========================================================================

  update(dtMs: number, view: AIView): AIDecision {
    this.now = view.now;
    this.refreshAdaptation(dtMs);

    // --- states the AI does not get a vote in -------------------------------
    if (view.selfHp <= 0) {
      this.clearIntent();
      return this.emit('DEFEATED', 0, false, null, null, 'out on the canvas');
    }
    if (view.selfDowned) {
      this.clearIntent();
      this.getUpUntil = this.now + COMBAT.getUpMs;
      return this.emit('KNOCKED_DOWN', 0, false, null, null, 'down');
    }
    if (this.now < this.getUpUntil) {
      return this.emit('GET_UP', 0, false, null, null, 'finding the legs');
    }
    if (view.frozen) {
      // Hit-stop, round cards, lost tracking: hold whatever posture we had.
      return this.emit(this.st, 0, this.out.guard, null, null, 'frozen');
    }
    if (view.selfStaggered) {
      this.clearIntent();
      return this.emit('STAGGER', 0, false, null, null, 'rocked');
    }
    if (view.selfRecovering) {
      // Recovery frames are the player's punish window; the AI cannot act out of
      // them, and the halved guard score is what makes whiffing punishable.
      return this.emit('RECOVER', 0, this.guardWanted(view, 0.5), null, null, 'recovering');
    }
    if (view.opponentDowned) {
      return this.emit('OBSERVE', 0, false, null, null, 'neutral corner');
    }

    // --- the reaction queue: the entire difficulty curve lives here ----------
    if (this.pending.active && this.now >= this.pending.fireAt) {
      const reaction = this.resolveRead(view);
      if (reaction) return reaction;
    }

    // One committed action at a time — no cancelling a dodge into a punch.
    if (this.now < this.busyUntil) {
      return this.emit(this.st, 0, this.busyGuard, null, null, this.busyReason);
    }

    const staminaFrac = view.selfStamina / Math.max(1, view.selfStaminaMax);
    const hpFrac = view.selfHp / Math.max(1, view.selfHpMax);
    const oppHpFrac = view.opponentHp / Math.max(1, view.opponentHpMax);
    const oppStamFrac = view.opponentStamina / Math.max(1, view.opponentStaminaMax);

    this.lowStamina = staminaFrac < (this.lowStamina ? LOW_STAMINA_EXIT : LOW_STAMINA_ENTER);

    if (this.lowStamina) {
      // Whether an empty tank actually changes the plan is a discipline check,
      // re-rolled once a beat rather than every frame. AMATEUR fails it two
      // times in three and gasses itself in front of you.
      if (this.now >= this.staminaRollAt) {
        this.staminaRollAt = this.now + 1100;
        this.recklessTank = this.rng.chance(1 - this.profile.staminaDiscipline);
      }
      if (!this.recklessTank) {
        const back: -1 | 0 | 1 = view.gap < COMBAT.maxGap - 30 ? -1 : 0;
        return this.emit('LOW_STAMINA', back, this.now >= this.dropGuardUntil, null, null, 'blowing hard');
      }
    } else {
      this.staminaRollAt = 0;
      this.recklessTank = false;
    }

    // --- an open window beats everything else -------------------------------
    if (this.now < this.counterUntil) {
      const counter = this.pickAttack(view, 'counter');
      if (counter) {
        this.counterUntil = 0;
        this.startChain(view, 0.7);
        return this.fire(counter, 'COUNTER', 'punishing the opening');
      }
      if (view.gap > this.def.brain.preferredRange && view.gap > COMBAT.minGap + 20) {
        return this.emit('COUNTER', 1, false, null, null, 'closing to punish');
      }
      this.counterUntil = 0; // nothing affordable in reach — let it lapse
    }

    // --- combination continuation -------------------------------------------
    if (this.now < this.chainUntil && this.chainP > 0) {
      if (this.comboStep < MAX_CHAIN && this.rng.chance(this.chainP)) {
        const next = this.pickAttack(view, 'chain');
        if (next) {
          this.comboStep += 1;
          this.chainP *= CHAIN_DECAY;
          return this.fire(next, 'COMBO', 'stringing it together');
        }
      }
      // Rolled once per opening, not once per frame, so the chain either
      // continues now or is genuinely over.
      this.chainUntil = 0;
      this.chainP = 0;
    }

    // --- fresh offence -------------------------------------------------------
    if (this.now >= this.nextActionAt) {
      if (this.readyToAttack(view, oppStamFrac, hpFrac, oppHpFrac)) {
        const reckless = this.rng.chance(this.profile.mistakeChance);
        const attack = this.pickAttack(view, reckless ? 'reckless' : 'open');
        if (attack) {
          this.startChain(view, 1);
          return this.fire(attack, 'ATTACK', reckless ? 'mistake: reaching for it' : 'going to work');
        }
        // Nothing reaches from here — walk him down instead of punching air.
        this.nextActionAt = this.now + 160;
      } else {
        this.nextActionAt = this.now + 130 + this.def.brain.patience * 320;
      }
    }

    return this.position(view, hpFrac, oppHpFrac);
  }

  // ==========================================================================
  // Engine callbacks
  // ==========================================================================

  onPlayerAttackStart(info: { kind: PunchKind; hand: Side; region: Region; impactAtMs: number }): void {
    let reaction = this.profile.reactionMs + this.rng.range(-1, 1) * this.profile.reactionJitterMs;

    // Recognising the punch you have thrown twenty times is faster than seeing a
    // new one — the adaptation buys reaction time, never a free block.
    if (this.adaptTellKind === info.kind) reaction *= 1 - 0.28 * this.adaptTrust;
    if (this.adaptTellHand === info.hand) reaction *= 1 - 0.15 * this.adaptTrust;
    reaction /= clamp(this.def.speedScale, 0.7, 1.4);

    // Caught watching. The punch usually lands before the reaction ever fires.
    if (this.rng.chance(this.profile.mistakeChance)) reaction = reaction * 2.1 + 170;

    reaction = Math.max(70, reaction);
    this.lastReactionMs = Math.round(reaction);

    // A second punch overwrites an unresolved read: the AI tracks one thing at a
    // time, which is precisely why combinations work on it.
    const p = this.pending;
    p.active = true;
    p.fireAt = this.now + reaction;
    p.impactAt = info.impactAtMs;
    p.kind = info.kind;
    p.hand = info.hand;
    p.region = info.region;
  }

  onPlayerAttackResolved(info: { landed: boolean; blocked: boolean; dodged: boolean }): void {
    this.pending.active = false;
    // Landing is handled by onSelfHit; a stopped punch already opened its own
    // window inside resolveRead.
    if (info.landed || info.blocked || info.dodged) return;

    // A clean whiff is the cheapest punish in boxing. This is the counterpuncher
    // fantasy, so the roll is generous and it does not care about the cooldown.
    const p = clamp01(
      this.profile.counterChance * (0.6 + 1.1 * this.def.brain.counterBias) + this.adaptCounterBonus + 0.12,
    );
    if (this.rng.chance(p)) {
      this.openCounter(0.8);
      this.reason = 'he swung at air';
    }
  }

  onSelfHit(info: { damage: number; region: Region; staggered: boolean }): void {
    this.pending.active = false;
    this.chainUntil = 0;
    this.chainP = 0;
    this.comboStep = 0;

    if (info.staggered) {
      this.busyUntil = this.now + COMBAT.staggerMs;
      this.busyGuard = false;
      this.busyReason = 'rocked';
      this.counterUntil = 0;
      this.nextActionAt = this.now + COMBAT.staggerMs + this.def.brain.recoveryMs;
      this.retreatUntil = this.now + COMBAT.staggerMs + 420;
      return;
    }

    // Getting hit resets the plan: hands up, give ground on the heavy ones, and
    // fire back if this fighter is wired that way.
    const share = info.damage / Math.max(1, this.def.maxHp);
    // A dig to the ribs does not make you cover your head, it makes you move.
    this.guardUntil = this.now + (info.region === 'body' ? 170 : 260) + 700 * this.def.brain.blockBias;
    if (share > 0.05) this.retreatUntil = this.now + 260 + share * 2600;
    this.nextActionAt = Math.max(this.nextActionAt, this.now + this.def.brain.recoveryMs * 0.5);
    if (this.rng.chance(this.def.brain.counterBias * (0.4 + this.profile.counterChance))) this.openCounter(0.6);
  }

  onSelfLanded(info: { damage: number; blocked: boolean }): void {
    if (info.blocked) {
      // The guard held. Stop head-hunting and start digging downstairs.
      this.guardBreakUntil = this.now + 4000;
      this.chainP *= 0.6;
      return;
    }
    if (this.comboStep <= 0) return;
    // Smelling blood buys one more beat of chain than the dice alone would.
    this.chainUntil = Math.max(this.chainUntil, this.now + CHAIN_WINDOW_MS * 0.8);
    this.chainP = clamp01(this.chainP + this.profile.comboChance * 0.25 + info.damage * 0.004);
  }

  onKnockdown(who: 'self' | 'opponent'): void {
    this.clearIntent();
    if (who === 'self') {
      this.getUpUntil = this.now + COMBAT.getUpMs;
      this.st = 'KNOCKED_DOWN';
      this.reason = 'down';
      // Nobody comes off the canvas throwing. The first beat back is cautious.
      this.nextActionAt = this.now + COMBAT.getUpMs + 700;
      this.retreatUntil = this.now + COMBAT.getUpMs + 900;
    } else {
      this.st = 'OBSERVE';
      this.reason = 'neutral corner';
      this.nextActionAt = this.now + 900;
    }
  }

  onRoundStart(index: number): void {
    this.roundIndex = index;
    this.clearIntent();
    this.lowStamina = false;
    this.recklessTank = false;
    this.staminaRollAt = 0;
    this.getUpUntil = 0;
    this.retreatUntil = 0;
    this.guardUntil = 0;
    this.dropGuardUntil = 0;
    this.lastAttack = null;
    this.st = 'IDLE';
    this.reason = 'round start';
    // Everyone feels the first round out. By round three the read is already
    // made, so the opening beat gets shorter as the fight goes on. The player
    // model deliberately survives across rounds — that is the whole point.
    this.nextActionAt = this.now + (900 + 1100 * this.def.brain.patience) * Math.max(0.35, 1 - 0.3 * index);
  }

  // ==========================================================================
  // Introspection
  // ==========================================================================

  get state(): AIState {
    return this.st;
  }

  get debug(): { state: AIState; reason: string; reactionMs: number; adaptation: string; nextActionInMs: number } {
    const d = this.dbg;
    d.state = this.st;
    d.reason = this.reason;
    d.reactionMs = this.lastReactionMs;
    d.adaptation = this.adaptSummary;
    d.nextActionInMs = Math.max(0, Math.round(this.nextActionAt - this.now));
    return d;
  }

  reset(): void {
    // Re-seeding rather than reusing the stream keeps a restarted fight
    // reproducible, which is the only way AI bugs are ever pinned down.
    this.rng = new Rng(this.seed);
    this.clearIntent();

    this.st = 'IDLE';
    this.reason = 'ready';
    this.now = 0;
    this.roundIndex = 0;

    this.nextActionAt = 0;
    this.guardUntil = 0;
    this.dropGuardUntil = 0;
    this.retreatUntil = 0;
    this.getUpUntil = 0;
    this.guardBreakUntil = 0;
    this.staminaRollAt = 0;

    this.lowStamina = false;
    this.recklessTank = false;
    this.lastAttack = null;
    this.lastReactionMs = 0;

    this.adaptTimer = ADAPT_REFRESH_MS;
    this.adaptTrust = 0;
    this.adaptKey = -1;
    this.adaptSummary = 'feeling it out';
    this.adaptTellHand = null;
    this.adaptTellKind = null;
    this.adaptFollowHand = null;
    this.adaptBlockBonus = 0;
    this.adaptDodgeBonus = 0;
    this.adaptCounterBonus = 0;
    this.adaptBodyBias = 0;
    this.adaptPatience = 0;
    this.adaptDelayMs = 0;

    this.out.state = 'IDLE';
    this.out.attack = null;
    this.out.move = 0;
    this.out.guard = false;
    this.out.dodge = null;
    this.out.reason = 'ready';
  }

  // ==========================================================================
  // Defence
  // ==========================================================================

  /**
   * Fires when a scheduled read comes due. Returns a decision when the AI
   * actually does something about the punch, or null to fall through to normal
   * behaviour — which, when the read came too late, means eating it.
   */
  private resolveRead(view: AIView): AIDecision | null {
    const p = this.pending;
    p.active = false;

    // Prefer the live view: the punch may have been re-aimed since it started.
    const hand = view.incomingHand ?? p.hand;
    const kind = view.incomingKind ?? p.kind;
    const region = view.incomingRegion ?? p.region;
    const left = view.incomingImpactInMs ?? p.impactAt - this.now;

    if (left < 45) {
      // Too slow. The AI wears it, and this is the single biggest reason easy is
      // beatable by simply being first.
      this.reason = 'read it too late';
      return null;
    }

    if (this.rng.chance(this.profile.mistakeChance)) {
      // Mistakes have to be *visible*, so they take the shape of a dropped guard
      // or a slip in the wrong direction rather than an invisible dice nudge.
      if (this.rng.chance(0.5)) {
        this.dropGuardUntil = this.now + 320;
        this.reason = 'mistake: hands came down';
        return null;
      }
      this.commit(220, false, 'mistake: slipped into it');
      return this.emit('DODGE', 0, false, null, slipInto(hand), 'mistake: slipped into it');
    }

    const brain = this.def.brain;
    const handMatch = this.adaptTellHand !== null && this.adaptTellHand === hand;
    const kindMatch = this.adaptTellKind !== null && this.adaptTellKind === kind;

    let blockP = this.profile.blockChance * (0.55 + 0.9 * brain.blockBias);
    if (kindMatch) blockP += this.adaptBlockBonus;
    // A high guard does not stop a dig to the ribs.
    if (region === 'body') blockP *= 0.72;

    let dodgeP = this.profile.dodgeChance * (0.55 + 0.9 * brain.dodgeBias);
    if (handMatch) dodgeP += this.adaptDodgeBonus;
    // No room to slip once the punch is already inside.
    if (view.gap < COMBAT.minGap + 30) dodgeP *= 0.6;

    blockP = clamp01(blockP);
    dodgeP = clamp01(dodgeP);

    let counterP = this.profile.counterChance * (0.5 + brain.counterBias) + this.adaptCounterBonus;
    if (kindMatch) counterP += 0.12 * this.adaptTrust;
    counterP = clamp01(counterP);

    // One roll decides slip / block / eat, so the three never compete for the
    // same probability mass and a low-skill AI reliably does nothing.
    const roll = this.rng.next();

    if (roll < dodgeP) {
      const hold = clamp(left + 60, 140, 260);
      this.commit(hold, false, 'slipping');
      if (this.rng.chance(counterP)) this.openCounter(0.85);
      return this.emit('DODGE', 0, false, null, slipAway(hand), handMatch ? 'slipping the tell' : 'slipping');
    }

    if (roll < dodgeP + blockP) {
      this.guardUntil = this.now + clamp(left + 140, 180, 420);
      this.commit(clamp(left + 90, 120, 300), true, 'behind the gloves');
      if (this.rng.chance(counterP)) this.openCounter(1);
      return this.emit('BLOCK', 0, true, null, null, kindMatch ? 'saw that one coming' : 'blocking');
    }

    this.reason = 'took it clean';
    return null;
  }

  /** Opens the punish window a successful read (or a whiff) earned. */
  private openCounter(scale: number): void {
    this.counterUntil = this.now + COMBAT.counterWindowMs * scale;
  }

  // ==========================================================================
  // Offence
  // ==========================================================================

  /**
   * Rolled once per beat rather than once per frame — at 60fps a per-frame roll
   * would make any probability below 1 indistinguishable from certainty.
   */
  private readyToAttack(view: AIView, oppStamFrac: number, hpFrac: number, oppHpFrac: number): boolean {
    let drive = this.def.brain.aggression * this.profile.aggression;
    drive *= 1 + 0.05 * Math.max(this.roundIndex, view.roundIndex);

    if (this.adaptPatience > 0) {
      // Against a pressure fighter: wait, cover, and walk in the instant his
      // tank drops. Patience is only worth anything if it converts.
      drive *= oppStamFrac < PUNISH_STAMINA ? 1 + 0.7 * this.adaptPatience : 1 - 0.55 * this.adaptPatience;
    } else {
      // Against a turtle, standing off is a losing game. Go and break it.
      drive *= 1 - 0.8 * this.adaptPatience;
    }

    if (view.opponentIdleMs > 1400) drive *= 1.3; // nothing is coming back
    if (view.opponentGuarding) drive *= 0.9;
    if (view.opponentRage) drive *= 0.7;
    if (view.selfRage) drive *= 1.35;
    if (this.lowStamina) drive *= 0.6;
    if (oppHpFrac < 0.2) drive *= 1.3; // finish it
    if (hpFrac < 0.25 && hpFrac < oppHpFrac) drive *= 0.8;
    // Late in a round he is losing, a fighter starts pressing for the cards.
    if (view.roundProgress > 0.8 && hpFrac < oppHpFrac) drive *= 1.2;

    return this.rng.chance(clamp01(drive * 0.9));
  }

  /**
   * Weighted pick over the fighter's move list, re-weighted every call by reach,
   * the opponent's guard, the role the punch is playing and the current read.
   * Returns null when nothing in the list can legally be thrown from here.
   */
  private pickAttack(view: AIView, mode: AttackMode): AttackDef | null {
    const reckless = mode === 'reckless';
    // Never punch the tank empty. Counters are worth dipping into the reserve.
    const reserve = 10 * this.profile.staminaDiscipline * (mode === 'counter' ? 0.4 : 1);
    const budget = view.selfStamina - reserve;
    const finisher = view.opponentHp / Math.max(1, view.opponentHpMax) < 0.2;
    let total = 0;

    for (let i = 0; i < this.pool.length; i += 1) {
      const entry = this.pool[i];
      const a = entry[0];

      if (a.staminaCost > budget) {
        entry[1] = 0;
        continue;
      }

      const margin = a.range - view.gap;
      if (margin < 0 && !reckless) {
        entry[1] = 0;
        continue;
      }

      let w = this.baseWeights[i];

      // Reach fit. A punch thrown at the very edge of its range is the one that
      // gets countered, so comfortable margin is worth more than raw weight —
      // which is also why no uppercut ever comes out from the outside.
      w *= reckless ? (margin < 0 ? 1.6 : 0.35) : 0.5 + clamp01(margin / 90);

      // A high guard is beaten downstairs, not through.
      if (a.target === 'body') w *= (view.opponentGuarding ? 2.2 : 0.8) + this.adaptBodyBias;
      else if (view.opponentGuarding) w *= 0.55;

      if (mode === 'counter') {
        // Counters live inside a window; only fast hands get there in time.
        const speed = 300 / (a.startupMs + a.recoveryMs);
        w *= speed * speed;
      } else if (mode === 'chain') {
        w *= 0.6 + a.damage / 11; // finish the combination with the heavy one
      }

      if (finisher || view.selfRage) w *= 0.7 + a.damage / 13;
      if (this.adaptFollowHand !== null && a.hand === this.adaptFollowHand) w *= 1 + 0.5 * this.adaptTrust;
      // Stop the AI from becoming as readable as the player it is reading.
      if (a.id === this.lastAttack) w *= 0.55;

      entry[1] = w;
      total += w;
    }

    return total > 0 ? this.rng.weighted(this.pool) : null;
  }

  private startChain(view: AIView, scale: number): void {
    this.comboStep = 1;
    const base = this.profile.comboChance * (0.5 + 0.9 * this.def.brain.comboBias);
    this.chainP = clamp01(base * scale * (view.selfRage ? 1.25 : 1));
  }

  private fire(a: AttackDef, state: AIState, reason: string): AIDecision {
    this.lastAttack = a.id;
    // The internal commit only covers startup + active frames; the engine's own
    // `selfRecovering` flag takes over after that, so a stagger can still cut in.
    this.commit(a.startupMs + a.activeMs, false, 'committed');

    const cool = this.def.brain.attackCooldownMs / clamp(this.def.speedScale, 0.6, 1.6);
    const willingness = Math.max(0.4, this.profile.aggression);
    // adaptDelayMs is the slip read: throw a beat later so the punch arrives on
    // his recovery instead of on the slip itself.
    this.nextActionAt = this.now + (cool / willingness) * this.rng.range(0.85, 1.15) + this.adaptDelayMs;
    this.chainUntil = this.now + CHAIN_WINDOW_MS;

    return this.emit(state, 0, false, a.id, null, reason);
  }

  // ==========================================================================
  // Footwork and posture
  // ==========================================================================

  private position(view: AIView, hpFrac: number, oppHpFrac: number): AIDecision {
    const target = this.preferredGap(view, hpFrac, oppHpFrac);
    const delta = view.gap - target;

    let move: -1 | 0 | 1 = 0;
    if (delta > RANGE_DEADZONE && view.gap > COMBAT.minGap + 20) move = 1;
    else if (delta < -RANGE_DEADZONE && view.gap < COMBAT.maxGap - 20) move = -1;
    if (this.now < this.retreatUntil && view.gap < COMBAT.maxGap - 20) move = -1;

    const guard = this.guardWanted(view, 1);

    if (move === 1) {
      return this.emit(view.selfRage ? 'ENRAGED' : 'APPROACH', 1, guard, null, null, 'walking him down');
    }
    if (move === -1) {
      return this.emit('RETREAT', -1, guard, null, null, 'resetting the range');
    }
    if (guard && (view.opponentAttacking || this.now < this.guardUntil)) {
      return this.emit('BLOCK', 0, true, null, null, 'shelling up');
    }
    return this.emit(view.selfRage ? 'ENRAGED' : 'OBSERVE', 0, guard, null, null, 'reading him');
  }

  private preferredGap(view: AIView, hpFrac: number, oppHpFrac: number): number {
    let target = this.def.brain.preferredRange;
    // A patient read means letting the pressure fighter travel the distance.
    target += this.adaptPatience * 70;
    if (this.lowStamina) target += 90;
    if (view.opponentRage) target += 70;
    if (hpFrac < 0.3 && hpFrac < oppHpFrac - 0.12) target += 60; // survive first
    if (view.opponentIdleMs > 1400) target -= 55; // nothing to be afraid of
    if (oppHpFrac < 0.2) target -= 45; // go and get him
    return clamp(target, COMBAT.minGap + 20, COMBAT.maxGap - 40);
  }

  /**
   * The *resting* guard, which is personality rather than skill — the Iron Gate
   * stands behind his gloves, the Furnace does not. Reactive blocking is decided
   * exclusively by the reaction queue, so a slow AI can never cover a punch it
   * has not had time to see.
   */
  private guardWanted(view: AIView, scale: number): boolean {
    if (this.now < this.dropGuardUntil) return false;
    if (this.now < this.guardUntil) return true;
    if (this.lowStamina) return true;

    const brain = this.def.brain;
    const rest =
      (0.22 + 0.78 * brain.blockBias * (0.55 + 0.55 * brain.patience) + this.adaptPatience * 0.25) * scale;
    return rest > 0.5 && view.gap < brain.preferredRange + 120;
  }

  // ==========================================================================
  // Reading the player
  // ==========================================================================

  private refreshAdaptation(dtMs: number): void {
    this.adaptTimer += dtMs;
    if (this.adaptTimer < ADAPT_REFRESH_MS) return;
    this.adaptTimer = 0;

    const m = this.profiler.model;
    const brain = this.def.brain;

    // Weak reads must never swing behaviour: confidence gates everything,
    // difficulty decides how much of the read is allowed to matter at all, and
    // the fighter's own learningRate is the personality layered on top.
    const trust = clamp01(m.confidence * this.profile.adaptationRate * (0.55 + 0.9 * brain.learningRate));
    this.adaptTrust = trust;

    // 1. Hand tell — one hand doing all the work is the easiest read in boxing.
    const handSkew = Math.max(m.handBias.left, m.handBias.right);
    if (handSkew > HAND_TELL) {
      this.adaptTellHand = m.handBias.right >= m.handBias.left ? 'right' : 'left';
      this.adaptDodgeBonus = trust * remap(handSkew, HAND_TELL, 0.88, 0.06, 0.32);
    } else {
      this.adaptTellHand = null;
      this.adaptDodgeBonus = 0;
    }

    // 2. Punch tell — favourite shot gets blocked, then countered.
    let domKind: PunchKind = 'jab';
    let share = 0;
    for (const k of PUNCH_KINDS) {
      const v = m.kindBias[k];
      if (v > share) {
        share = v;
        domKind = k;
      }
    }
    if (share > KIND_TELL) {
      this.adaptTellKind = domKind;
      this.adaptBlockBonus = trust * remap(share, KIND_TELL, 0.62, 0.08, 0.34);
    } else {
      this.adaptTellKind = null;
      this.adaptBlockBonus = 0;
    }

    // 3. Whiffs — if he keeps throwing at air, punishing costs almost nothing.
    const punishWhiffs = m.whiffRate > WHIFF_TELL;
    this.adaptCounterBonus = punishWhiffs ? trust * remap(m.whiffRate, WHIFF_TELL, 0.75, 0.05, 0.3) : 0;

    // 4. Tempo — mirror him. Pressure earns patience, turtling earns pressure.
    let patience = 0;
    if (m.aggression > 0.62) {
      patience = trust * remap(m.aggression, 0.62, 1, 0.25, 1);
    } else if (m.aggression < 0.3 || m.guardRate > 0.45) {
      patience = -trust * Math.max(remap(m.aggression, 0.3, 0.05, 0.25, 1), remap(m.guardRate, 0.45, 0.8, 0.2, 1));
    }
    this.adaptPatience = clamp(patience, -1, 1);
    // A shell only opens from the body, and a guard that just ate a punch is
    // proof of it, so a recent blocked shot bumps the same dial.
    this.adaptBodyBias = Math.max(0, -this.adaptPatience) * 1.4 + (this.now < this.guardBreakUntil ? 0.6 : 0);

    // 5. Slip habit — follow him where he goes, and land on the recovery rather
    // than on the slip by throwing a beat late.
    const dodgeSkew = Math.max(m.dodgeBias.left, m.dodgeBias.right);
    if (dodgeSkew > DODGE_TELL) {
      const slip: Side = m.dodgeBias.right >= m.dodgeBias.left ? 'right' : 'left';
      this.adaptFollowHand = mirrorSide(slip);
      this.adaptDelayMs = trust * remap(dodgeSkew, DODGE_TELL, 0.85, 40, 130);
    } else {
      this.adaptFollowHand = null;
      this.adaptDelayMs = 0;
    }

    // Rebuilding the debug sentence allocates, so only do it when the read
    // actually changed shape rather than every 150ms.
    const key =
      (this.adaptTellHand === null ? 0 : this.adaptTellHand === 'left' ? 1 : 2) |
      ((this.adaptTellKind === null ? 0 : PUNCH_KINDS.indexOf(this.adaptTellKind) + 1) << 2) |
      ((this.adaptPatience > 0.2 ? 1 : this.adaptPatience < -0.2 ? 2 : 0) << 6) |
      ((this.adaptFollowHand === null ? 0 : this.adaptFollowHand === 'left' ? 1 : 2) << 8) |
      ((punishWhiffs ? 1 : 0) << 10) |
      ((trust > 0.15 ? 1 : 0) << 11);
    if (key !== this.adaptKey) {
      this.adaptKey = key;
      this.adaptSummary = this.buildSummary(punishWhiffs);
    }
  }

  private buildSummary(punishWhiffs: boolean): string {
    if (this.adaptTrust < 0.15) return 'feeling it out';

    const parts = this.phrases;
    parts.length = 0;
    if (this.adaptTellHand !== null) parts.push(`reading ${HAND_LABEL[this.adaptTellHand]} hand`);
    if (this.adaptTellKind !== null) parts.push(`expecting the ${KIND_LABEL[this.adaptTellKind]}`);
    if (this.adaptPatience > 0.2) parts.push('letting him burn out');
    else if (this.adaptPatience < -0.2) parts.push('breaking the shell');
    if (this.adaptFollowHand !== null) parts.push('tracking the slip');
    if (punishWhiffs) parts.push('punishing whiffs');

    if (!parts.length) return 'no clear tell yet';
    // Three clauses is the most a HUD line can carry without turning into prose.
    if (parts.length > 3) parts.length = 3;
    return parts.join(', ');
  }

  // ==========================================================================
  // Plumbing
  // ==========================================================================

  private commit(ms: number, guard: boolean, reason: string): void {
    this.busyUntil = this.now + ms;
    this.busyGuard = guard;
    this.busyReason = reason;
  }

  private clearIntent(): void {
    this.pending.active = false;
    this.busyUntil = 0;
    this.busyGuard = false;
    this.busyReason = 'committed';
    this.counterUntil = 0;
    this.chainUntil = 0;
    this.chainP = 0;
    this.comboStep = 0;
  }

  private emit(
    state: AIState,
    move: -1 | 0 | 1,
    guard: boolean,
    attack: AttackId | null,
    dodge: Side | null,
    reason: string,
  ): AIDecision {
    this.st = state;
    this.reason = reason;
    const out = this.out;
    out.state = state;
    out.move = move;
    out.guard = guard;
    out.attack = attack;
    out.dodge = dodge;
    out.reason = reason;
    return out;
  }
}
