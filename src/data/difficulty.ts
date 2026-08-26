import type { Difficulty, DifficultyProfile } from '@/types/combat';

/**
 * Difficulty changes how the opponent *thinks*, not how much health it carries.
 *
 * The dominant lever is `reactionMs` + `reactionJitterMs`: on easy the AI needs
 * over half a second to notice a punch, which is longer than most attacks take
 * to land, so the player wins by simply throwing. On champion it reacts inside
 * 170ms and the jitter is small enough that feints stop working.
 *
 * `mistakeChance` never reaches zero — a flawless opponent reads as a cheating
 * opponent, and the occasional dropped guard is what makes a champion win feel
 * earned rather than granted.
 */

export const DIFFICULTIES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    id: 'easy',
    name: 'AMATEUR',
    description: 'Slow to react and easy to read — the place to learn what your hands can do.',
    // Longer than a cross takes to land: on easy, being first is enough.
    reactionMs: 560,
    reactionJitterMs: 220,
    aggression: 0.6,
    blockChance: 0.2,
    dodgeChance: 0.12,
    counterChance: 0.08,
    comboChance: 0.15,
    mistakeChance: 0.35,
    adaptationRate: 0.1,
    damageMultiplier: 0.75,
    // Throws itself empty and then stands there, which is the exploit.
    staminaDiscipline: 0.35,
  },
  normal: {
    id: 'normal',
    name: 'PRO',
    description: 'Blocks the obvious, punishes the lazy, and makes you work the body.',
    reactionMs: 380,
    reactionJitterMs: 130,
    aggression: 0.85,
    blockChance: 0.38,
    dodgeChance: 0.28,
    counterChance: 0.22,
    comboChance: 0.32,
    mistakeChance: 0.18,
    adaptationRate: 0.3,
    damageMultiplier: 1,
    staminaDiscipline: 0.6,
  },
  hard: {
    id: 'hard',
    name: 'CONTENDER',
    description: 'Reads your patterns within a round and starts answering before you finish.',
    reactionMs: 250,
    reactionJitterMs: 80,
    aggression: 1.05,
    blockChance: 0.55,
    dodgeChance: 0.4,
    counterChance: 0.4,
    comboChance: 0.5,
    mistakeChance: 0.08,
    adaptationRate: 0.55,
    damageMultiplier: 1.15,
    staminaDiscipline: 0.82,
  },
  champion: {
    id: 'champion',
    name: 'UNDISPUTED',
    description: 'Reacts on instinct, counters everything twice, and only forgives you by accident.',
    reactionMs: 170,
    reactionJitterMs: 45,
    aggression: 1.2,
    blockChance: 0.68,
    dodgeChance: 0.5,
    counterChance: 0.6,
    comboChance: 0.7,
    // Deliberately non-zero: a perfect AI is a wall, not an opponent.
    mistakeChance: 0.035,
    adaptationRate: 0.85,
    damageMultiplier: 1.3,
    staminaDiscipline: 0.96,
  },
};

/** Menu order, easiest first. */
const ORDER: Difficulty[] = ['easy', 'normal', 'hard', 'champion'];

export const DIFFICULTY_LIST: DifficultyProfile[] = ORDER.map((id) => DIFFICULTIES[id]);
