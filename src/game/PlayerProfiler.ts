import type { FightIQ, FightStats, PlayerModel } from '@/types/combat';
import type { Side } from '@/types/core';
import type { PunchEvent, PunchKind } from '@/types/vision';
import { clamp, clamp01, lerp, mean, remap } from '@/utils/math';

/**
 * Rolling read on how the player fights.
 *
 * Everything here is exponentially weighted: a fighter who spent round one
 * head-hunting with the right hand and then switched to the body in round three
 * should read as a body puncher, not as an average of the two. Nothing is a
 * plain lifetime mean.
 *
 * The same instance feeds two very different consumers — the AI (via `model`,
 * every frame) and the post-fight analytics screen (via `toFightIQ`, once). The
 * AI path is deliberately allocation-free: `model` hands back the same mutable
 * object every call.
 */

const PUNCH_KINDS: PunchKind[] = ['jab', 'cross', 'hook', 'uppercut', 'straight'];

const KIND_LABEL: Record<PunchKind, string> = {
  jab: 'JAB',
  cross: 'CROSS',
  hook: 'HOOK',
  uppercut: 'UPPERCUT',
  straight: 'STRAIGHT',
};

/** Blend rates for the running estimates. Lower = longer memory. */
const HAND_ALPHA = 0.14;
const KIND_ALPHA = 0.1;
const DODGE_ALPHA = 0.2;
const INTERVAL_ALPHA = 0.22;
const WHIFF_ALPHA = 0.16;
const COMBO_ALPHA = 0.25;

/** Half-life of the behaviour window used for rates and time shares. */
const WINDOW_HALF_LIFE_MS = 9000;
/** Converts a decay-weighted event count into events per second. */
const RATE_K = (Math.LN2 / WINDOW_HALF_LIFE_MS) * 1000;
/** Stops a long stretch of pressure from pinning the rate estimate. */
const MAX_EVENT_WEIGHT = 40;

/** Actions needed before the AI is allowed to fully trust a read. */
const CONFIDENCE_ACTIONS = 25;

/** Plausible bounds on a punch gap — anything outside is a pause, not a rhythm. */
const MIN_GAP_MS = 120;
const MAX_GAP_MS = 4000;

const createModel = (): PlayerModel => ({
  samples: 0,
  handBias: { left: 0.5, right: 0.5 },
  kindBias: { jab: 0.2, cross: 0.2, hook: 0.2, uppercut: 0.2, straight: 0.2 },
  avgComboLength: 1,
  aggression: 0.4,
  defensiveness: 0.4,
  dodgeBias: { left: 0.5, right: 0.5 },
  guardRate: 0,
  punchIntervalMs: 900,
  whiffRate: 0.25,
  confidence: 0,
});

/** Push a normalised distribution towards `hit`, keeping the total at 1. */
function biasTowards<K extends string>(dist: Record<K, number>, keys: K[], hit: K, alpha: number): void {
  for (const k of keys) dist[k] = dist[k] * (1 - alpha) + (k === hit ? alpha : 0);
}

const dominant = <K extends string>(dist: Record<K, number>, keys: K[]): K => {
  let best = keys[0];
  for (const k of keys) if (dist[k] > dist[best]) best = k;
  return best;
};

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export class PlayerProfiler {
  private readonly m: PlayerModel = createModel();

  /** Decay-weighted time shares. Ratios survive the decay, absolute values do not. */
  private activeMs = 0;
  private idleMs = 0;
  private guardMs = 0;

  /** Decay-weighted event counts, turned into rates through RATE_K. */
  private punchWeight = 0;
  private dodgeWeight = 0;

  private lastPunchAt = 0;
  private actions = 0;
  private dirty = true;

  recordPunch(e: PunchEvent, outcome: 'landed' | 'blocked' | 'dodged' | 'whiff'): void {
    this.m.samples += 1;
    this.actions += 1;

    biasTowards(this.m.handBias, ['left', 'right'] as Side[], e.hand, HAND_ALPHA);
    biasTowards(this.m.kindBias, PUNCH_KINDS, e.kind, KIND_ALPHA);

    if (this.lastPunchAt > 0) {
      const gap = clamp(e.at - this.lastPunchAt, MIN_GAP_MS, MAX_GAP_MS);
      this.m.punchIntervalMs = lerp(this.m.punchIntervalMs, gap, INTERVAL_ALPHA);
    }
    this.lastPunchAt = e.at;

    // A dodged punch counts as half a whiff: the player was baited rather than
    // simply throwing at air, so it is worth less to the AI as punish evidence.
    const missed = outcome === 'whiff' ? 1 : outcome === 'dodged' ? 0.5 : 0;
    this.m.whiffRate = lerp(this.m.whiffRate, missed, WHIFF_ALPHA);

    this.punchWeight = Math.min(MAX_EVENT_WEIGHT, this.punchWeight + 1);
    this.dirty = true;
  }

  recordComboEnd(length: number): void {
    this.m.avgComboLength = lerp(this.m.avgComboLength, Math.max(1, length), COMBO_ALPHA);
    this.dirty = true;
  }

  recordDodge(dir: Side): void {
    this.actions += 1;
    biasTowards(this.m.dodgeBias, ['left', 'right'] as Side[], dir, DODGE_ALPHA);
    this.dodgeWeight = Math.min(MAX_EVENT_WEIGHT, this.dodgeWeight + 1);
    this.dirty = true;
  }

  recordGuard(dtMs: number): void {
    if (!(dtMs > 0)) return;
    this.decay(dtMs);
    this.guardMs += dtMs;
  }

  recordActive(dtMs: number): void {
    if (!(dtMs > 0)) return;
    this.decay(dtMs);
    this.activeMs += dtMs;
  }

  recordIdle(dtMs: number): void {
    if (!(dtMs > 0)) return;
    this.decay(dtMs);
    this.idleMs += dtMs;
  }

  /** Live model object — reused between calls so the AI can poll it per frame. */
  get model(): PlayerModel {
    this.refresh();
    return this.m;
  }

  toFightIQ(stats: FightStats): FightIQ {
    const model = this.model;

    let thrown = 0;
    for (const k of PUNCH_KINDS) thrown += stats.kindCounts[k];
    if (thrown <= 0) thrown = stats.landed + stats.missed;

    const minutes = Math.max(0.25, stats.fightDurationMs / 60000);
    const duration = Math.max(1, stats.fightDurationMs);

    // AGGRESSION — output rate plus how much of the fight was spent pressing.
    const rateScore = remap(thrown / minutes, 6, 60, 0, 100);
    const activeScore = remap(stats.timeAggressiveMs / duration, 0, 0.55, 0, 100);
    const aggression = Math.round(clamp(0.62 * rateScore + 0.38 * activeScore, 0, 100));

    // DEFENSE — successful stops and time behind the gloves, discounted by what
    // still got through. Turtling without stopping anything should not score.
    const stopScore = remap(stats.blocks + stats.dodges, 0, 22, 0, 100);
    const perfectScore = remap(stats.perfectBlocks + stats.perfectDodges, 0, 8, 0, 100);
    const guardScore = remap(stats.timeGuardingMs / duration, 0, 0.4, 0, 100);
    const soakScore = 100 - remap(stats.damageTaken, 0, 260, 0, 100);
    const defense = Math.round(
      clamp(0.36 * stopScore + 0.2 * perfectScore + 0.18 * guardScore + 0.26 * soakScore, 0, 100),
    );

    // COUNTERING — conversion rate on openings the player actually created. One
    // counter off one perfect block is promising, not mastery, so `trust` scales
    // the ratio by sample size and raw volume carries the rest.
    const openings = stats.perfectBlocks + stats.perfectDodges;
    const conversion = openings > 0 ? clamp01(stats.counters / openings) : 0;
    const trust = remap(openings, 0, 6, 0.35, 1);
    const volume = remap(stats.counters, 0, 8, 0, 1);
    const countering = Math.round(clamp(100 * (0.6 * conversion * trust + 0.4 * volume), 0, 100));

    const attempts = stats.landed + stats.missed;
    const accuracy = attempts > 0 ? Math.round(clamp01(stats.landed / attempts) * 100) : 0;

    const handCounts = stats.handCounts;
    const preferredHand: Side =
      handCounts.right === handCounts.left
        ? model.handBias.right >= model.handBias.left
          ? 'right'
          : 'left'
        : handCounts.right > handCounts.left
          ? 'right'
          : 'left';

    let favKind = dominant(model.kindBias, PUNCH_KINDS);
    let bestCount = 0;
    for (const k of PUNCH_KINDS) {
      if (stats.kindCounts[k] > bestCount) {
        bestCount = stats.kindCounts[k];
        favKind = k;
      }
    }

    const dodgeTotal = stats.dodgeDirections.left + stats.dodgeDirections.right;
    const leftShare = dodgeTotal > 0 ? stats.dodgeDirections.left / dodgeTotal : model.dodgeBias.left;
    const dodgePreference: Side | 'balanced' =
      dodgeTotal === 0 && model.samples === 0
        ? 'balanced'
        : leftShare > 0.6
          ? 'left'
          : leftShare < 0.4
            ? 'right'
            : 'balanced';

    const averageCombo = stats.comboLengths.length ? mean(stats.comboLengths) : model.avgComboLength;

    return {
      aggression,
      defense,
      countering,
      accuracy,
      favouriteAttack: `${preferredHand.toUpperCase()} ${KIND_LABEL[favKind]}`,
      preferredHand,
      averageCombo: Math.round(averageCombo * 10) / 10,
      dodgePreference,
    };
  }

  reset(): void {
    const fresh = createModel();
    // Copy in place: the AI holds a long-lived reference to this object.
    this.m.samples = fresh.samples;
    this.m.handBias.left = fresh.handBias.left;
    this.m.handBias.right = fresh.handBias.right;
    for (const k of PUNCH_KINDS) this.m.kindBias[k] = fresh.kindBias[k];
    this.m.avgComboLength = fresh.avgComboLength;
    this.m.aggression = fresh.aggression;
    this.m.defensiveness = fresh.defensiveness;
    this.m.dodgeBias.left = fresh.dodgeBias.left;
    this.m.dodgeBias.right = fresh.dodgeBias.right;
    this.m.guardRate = fresh.guardRate;
    this.m.punchIntervalMs = fresh.punchIntervalMs;
    this.m.whiffRate = fresh.whiffRate;
    this.m.confidence = fresh.confidence;

    this.activeMs = 0;
    this.idleMs = 0;
    this.guardMs = 0;
    this.punchWeight = 0;
    this.dodgeWeight = 0;
    this.lastPunchAt = 0;
    this.actions = 0;
    this.dirty = true;
  }

  /** Age every windowed accumulator so recent behaviour dominates the read. */
  private decay(dtMs: number): void {
    const k = Math.pow(0.5, dtMs / WINDOW_HALF_LIFE_MS);
    this.activeMs *= k;
    this.idleMs *= k;
    this.guardMs *= k;
    this.punchWeight *= k;
    this.dodgeWeight *= k;
    this.dirty = true;
  }

  private refresh(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const total = this.activeMs + this.idleMs + this.guardMs;
    const guardShare = total > 0 ? this.guardMs / total : 0;
    const activeShare = total > 0 ? this.activeMs / total : 0;
    const idleShare = total > 0 ? this.idleMs / total : 0;

    const punchesPerSec = this.punchWeight * RATE_K;
    const dodgesPerSec = this.dodgeWeight * RATE_K;

    this.m.guardRate = guardShare;
    this.m.aggression = clamp01(
      0.6 * clamp01(remap(punchesPerSec, 0.15, 1.5, 0, 1)) + 0.4 * activeShare - 0.3 * idleShare,
    );
    this.m.defensiveness = clamp01(
      0.6 * clamp01(guardShare * 1.6) + 0.4 * clamp01(remap(dodgesPerSec, 0, 0.55, 0, 1)),
    );
    this.m.confidence = smoothstep(clamp01(this.actions / CONFIDENCE_ACTIONS));
  }
}
