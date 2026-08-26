import type { EnemyDef } from '@/types/combat';

/**
 * The five opponents, in ladder order.
 *
 * Each one is a lesson. The brawler teaches you to move, the speedster teaches
 * you to time, the defender teaches you to break a guard, the counterpuncher
 * punishes everything the first three taught you, and the champion does all of
 * it at once. The brain knobs below are the whole personality — the controller
 * is generic, so if a fighter feels wrong the fix belongs in this file.
 *
 * `preferredRange` is in world px against `COMBAT.engageRange` = 300: below it
 * the fighter is crowding you, above it they are working behind the jab.
 * `staminaRecovery` and `powerScale`/`speedScale` are multipliers on the
 * shared baselines in gameConfig.
 */

export const ENEMIES: EnemyDef[] = [
  {
    id: 'brawler',
    name: 'BOILER RUIZ',
    archetype: 'brawler',
    title: 'THE FURNACE',
    bio: 'A former dockyard fighter who never learned to back up and has never needed to.',
    styleId: 'brawler',
    maxHp: 185,
    maxStamina: 100,
    brain: {
      aggression: 0.9,
      // Almost no patience and almost no guard: he answers everything with a
      // swing, which is what makes him the right first opponent to learn on.
      patience: 0.14,
      blockBias: 0.16,
      dodgeBias: 0.1,
      counterBias: 0.15,
      comboBias: 0.55,
      preferredRange: 235,
      recoveryMs: 220,
      attackCooldownMs: 520,
      // Burns hot: the slowest recovery in the field, so round three is yours.
      staminaRecovery: 0.85,
      attackWeights: { hookR: 1.15, hookL: 1, uppercutR: 0.85, uppercutL: 0.6, bodyR: 0.7, bodyL: 0.5, cross: 0.4, jab: 0.2 },
      learningRate: 0.12,
    },
    powerScale: 1.18,
    speedScale: 0.95,
  },
  {
    id: 'speedster',
    name: 'JETTA KANE',
    archetype: 'speedster',
    title: 'THE BLUR',
    bio: 'Fights at double time and dares you to keep up, betting you tire before she does.',
    styleId: 'speedster',
    maxHp: 165,
    maxStamina: 125,
    brain: {
      aggression: 0.78,
      patience: 0.3,
      blockBias: 0.22,
      // Slips instead of blocking — punishing her means predicting the slip.
      dodgeBias: 0.8,
      counterBias: 0.4,
      comboBias: 0.88,
      preferredRange: 288,
      recoveryMs: 150,
      attackCooldownMs: 380,
      staminaRecovery: 1.15,
      attackWeights: { jab: 1.4, hookL: 0.9, hookR: 0.8, cross: 0.7, bodyL: 0.45, bodyR: 0.4, uppercutL: 0.3, uppercutR: 0.22 },
      learningRate: 0.35,
    },
    // Volume over violence: fastest hands, softest hands.
    powerScale: 0.72,
    speedScale: 1.35,
  },
  {
    id: 'defender',
    name: 'ATLAS BRUNE',
    archetype: 'defender',
    title: 'THE IRON GATE',
    bio: 'Twelve years unbroken on the amateur circuit, built entirely out of refusing to be hit.',
    styleId: 'defender',
    maxHp: 210,
    maxStamina: 118,
    brain: {
      aggression: 0.42,
      patience: 0.82,
      // The wall. Guard up by default; the long cooldown is the only window.
      blockBias: 0.8,
      dodgeBias: 0.3,
      counterBias: 0.45,
      comboBias: 0.28,
      preferredRange: 330,
      recoveryMs: 380,
      attackCooldownMs: 950,
      // Blocking costs stamina, so a wall that cannot refill is not a wall.
      staminaRecovery: 1.35,
      attackWeights: { jab: 1.3, cross: 1.1, bodyR: 0.45, hookR: 0.35, hookL: 0.28, uppercutR: 0.2 },
      learningRate: 0.4,
    },
    powerScale: 1,
    speedScale: 0.9,
  },
  {
    id: 'counterpuncher',
    name: 'SILAS VEYNE',
    archetype: 'counterpuncher',
    title: 'THE MIRROR',
    bio: 'Studies three rounds of footage in the first thirty seconds and spends the rest of the night charging you for it.',
    styleId: 'counterpuncher',
    maxHp: 190,
    maxStamina: 112,
    brain: {
      aggression: 0.48,
      // Near-total patience plus the highest counter bias below champion: he
      // is not throwing first, he is waiting for your recovery frames.
      patience: 0.95,
      blockBias: 0.72,
      dodgeBias: 0.6,
      counterBias: 0.88,
      comboBias: 0.5,
      preferredRange: 375,
      recoveryMs: 300,
      attackCooldownMs: 780,
      staminaRecovery: 1.1,
      attackWeights: { cross: 1.5, uppercutR: 1.1, uppercutL: 0.7, jab: 0.55, hookR: 0.5, bodyR: 0.35 },
      // Reads habits fast — repeat a combo twice and the third one gets eaten.
      learningRate: 0.75,
    },
    powerScale: 1.1,
    speedScale: 1.02,
  },
  {
    id: 'champion',
    name: 'VALE AUGUST',
    archetype: 'champion',
    title: 'THE UNDISPUTED',
    bio: 'Nine title defences, no rematches granted, and a habit of finishing the round he decides to finish.',
    styleId: 'champion',
    maxHp: 230,
    maxStamina: 130,
    brain: {
      aggression: 0.8,
      patience: 0.7,
      blockBias: 0.66,
      dodgeBias: 0.62,
      counterBias: 0.7,
      comboBias: 0.85,
      preferredRange: 320,
      recoveryMs: 240,
      attackCooldownMs: 560,
      staminaRecovery: 1.25,
      // Uses the entire move list, so nothing about him is a safe read.
      attackWeights: { jab: 1, cross: 1.15, hookL: 0.85, hookR: 0.95, uppercutL: 0.6, uppercutR: 0.8, bodyL: 0.55, bodyR: 0.7 },
      learningRate: 0.9,
    },
    powerScale: 1.15,
    speedScale: 1.1,
  },
];

const BY_ID = new Map<string, EnemyDef>(ENEMIES.map((e) => [e.id, e]));

/** A missing id must never strand the fight screen — fall back to the opener. */
export function getEnemy(id: string): EnemyDef {
  return BY_ID.get(id) ?? ENEMIES[0];
}
