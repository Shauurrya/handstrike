import type { Region, Side } from '@/types/core';
import type { AttackDef, AttackId } from '@/types/combat';
import type { PunchKind } from '@/types/vision';

/**
 * The move list. Every number here is balanced against `COMBAT.engageRange`
 * (300px) so range alone decides which punches are safe from the outside.
 *
 * The core trade is reach-and-speed versus payoff: the jab reaches past neutral
 * and recovers in 130ms, while an uppercut has to be walked into (235px) and
 * leaves you open for 280ms. Total frame cost (startup + active + recovery)
 * therefore scales with damage — a whiffed uppercut is a free counter for the
 * opponent, which is exactly what makes the counterpuncher scary.
 */

const def = (d: AttackDef): AttackDef => d;

export const ATTACKS: Record<AttackId, AttackDef> = {
  jab: def({
    id: 'jab',
    name: 'JAB',
    kind: 'jab',
    hand: 'left',
    anim: 'JAB_L',
    damage: 5,
    // Reaches exactly to neutral engage range: the only punch you can throw
    // without first committing to stepping in.
    range: 300,
    target: 'head',
    staminaCost: 4,
    startupMs: 70,
    activeMs: 90,
    recoveryMs: 130,
    knockback: 12,
    hitStop: 45,
    shake: 6,
    staggerChance: 0.02,
  }),
  cross: def({
    id: 'cross',
    name: 'CROSS',
    kind: 'cross',
    hand: 'right',
    anim: 'CROSS_R',
    damage: 9,
    // Rear hand travels further across the body, so it out-reaches the jab.
    range: 320,
    target: 'head',
    staminaCost: 7,
    startupMs: 110,
    activeMs: 100,
    recoveryMs: 210,
    knockback: 26,
    hitStop: 70,
    shake: 12,
    staggerChance: 0.1,
  }),
  hookL: def({
    id: 'hookL',
    name: 'LEFT HOOK',
    kind: 'hook',
    hand: 'left',
    anim: 'HOOK_L',
    damage: 8,
    range: 265,
    target: 'head',
    staminaCost: 7,
    startupMs: 120,
    activeMs: 100,
    recoveryMs: 220,
    knockback: 24,
    hitStop: 68,
    shake: 11,
    staggerChance: 0.12,
  }),
  hookR: def({
    id: 'hookR',
    name: 'RIGHT HOOK',
    kind: 'hook',
    hand: 'right',
    anim: 'HOOK_R',
    damage: 10,
    range: 270,
    target: 'head',
    staminaCost: 8,
    startupMs: 140,
    activeMs: 100,
    recoveryMs: 250,
    knockback: 30,
    hitStop: 78,
    shake: 14,
    staggerChance: 0.16,
  }),
  uppercutL: def({
    id: 'uppercutL',
    name: 'LEFT UPPERCUT',
    kind: 'uppercut',
    hand: 'left',
    anim: 'UPPERCUT_L',
    damage: 11,
    // Shortest reach in the game — an uppercut has to be earned on the inside.
    range: 235,
    target: 'head',
    staminaCost: 10,
    startupMs: 160,
    activeMs: 110,
    recoveryMs: 280,
    knockback: 34,
    hitStop: 90,
    shake: 17,
    staggerChance: 0.22,
  }),
  uppercutR: def({
    id: 'uppercutR',
    name: 'RIGHT UPPERCUT',
    kind: 'uppercut',
    hand: 'right',
    anim: 'UPPERCUT_R',
    damage: 13,
    range: 240,
    target: 'head',
    staminaCost: 12,
    startupMs: 180,
    activeMs: 110,
    recoveryMs: 300,
    knockback: 38,
    hitStop: 100,
    shake: 20,
    staggerChance: 0.26,
  }),
  bodyL: def({
    id: 'bodyL',
    name: 'LEFT BODY SHOT',
    kind: 'hook',
    hand: 'left',
    anim: 'HOOK_L',
    damage: 7,
    range: 255,
    target: 'body',
    staminaCost: 6,
    startupMs: 110,
    activeMs: 100,
    recoveryMs: 200,
    // Body shots trade knockback for stamina damage (applied by the resolver),
    // so they barely move the victim but wreck their ability to answer.
    knockback: 14,
    hitStop: 60,
    shake: 9,
    staggerChance: 0.06,
  }),
  bodyR: def({
    id: 'bodyR',
    name: 'RIGHT BODY SHOT',
    kind: 'hook',
    hand: 'right',
    anim: 'HOOK_R',
    damage: 9,
    range: 260,
    target: 'body',
    staminaCost: 8,
    startupMs: 130,
    activeMs: 100,
    recoveryMs: 230,
    knockback: 18,
    hitStop: 72,
    shake: 12,
    staggerChance: 0.09,
  }),
};

/** Display order: lead-hand light punches first, power shots last. */
const ORDER: AttackId[] = ['jab', 'cross', 'hookL', 'hookR', 'bodyL', 'bodyR', 'uppercutL', 'uppercutR'];

export const ATTACK_LIST: AttackDef[] = ORDER.map((id) => ATTACKS[id]);

/**
 * Turn a vision-detected punch into a concrete move.
 *
 * The classifier only reports a coarse kind plus an aimed region, so the
 * mapping is deliberately forgiving: any straight-line punch resolves to the
 * jab/cross pair by hand, and arcing punches thrown low become body shots.
 * Uppercuts always stay uppercuts — that arc is unambiguous and the player
 * should always be rewarded for it.
 */
export function attackForPunch(kind: PunchKind, hand: Side, target: Region): AttackDef {
  const left = hand === 'left';

  if (kind === 'uppercut') return left ? ATTACKS.uppercutL : ATTACKS.uppercutR;

  // A hook or straight aimed downstairs becomes the dedicated body variant.
  if (target === 'body' && (kind === 'hook' || kind === 'straight' || kind === 'cross')) {
    return left ? ATTACKS.bodyL : ATTACKS.bodyR;
  }

  if (kind === 'hook') return left ? ATTACKS.hookL : ATTACKS.hookR;

  // 'jab' | 'cross' | 'straight' — the hand decides, not the label, so a
  // right-handed "jab" still reads as the heavier rear-hand cross.
  return left ? ATTACKS.jab : ATTACKS.cross;
}
