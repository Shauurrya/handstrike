import type { CareerRank } from '@/config/gameConfig';
import type { Difficulty } from '@/types/combat';
import { clamp } from '@/utils/math';

/**
 * The five-fight climb.
 *
 * Difficulty and opponent ramp on separate curves so the ladder never doubles
 * its bite in one step: the speedster arrives with a harder brain but the same
 * profile the defender will use, and the counterpuncher's `hard` profile lands
 * one fight before the champion's own. Rank lags a fight behind the roster —
 * you fight as a contender twice before the promoters call you a pro.
 */

export interface CareerStage {
  index: number;
  rank: CareerRank;
  enemyId: string;
  difficulty: Difficulty;
  title: string;
  blurb: string;
}

export const CAREER_LADDER: CareerStage[] = [
  {
    index: 0,
    rank: 'ROOKIE',
    enemyId: 'brawler',
    difficulty: 'easy',
    title: 'OPENING BELL',
    blurb: 'Four-round debut on an undercard nobody paid for. Ruiz has knocked out three openers in a row — all of them in the first ninety seconds.',
  },
  {
    index: 1,
    rank: 'CONTENDER',
    enemyId: 'speedster',
    difficulty: 'normal',
    title: 'SPEED TRAP',
    blurb: 'Kane took the fight on nine days notice and spent the weigh-in shadowboxing at the cameras. Her last opponent threw forty punches and landed four.',
  },
  {
    index: 2,
    rank: 'CONTENDER',
    enemyId: 'defender',
    difficulty: 'normal',
    title: 'BREAKING THE GATE',
    blurb: 'Brune has not been stopped in twelve years. The oddsmakers are not selling a knockout line for this one — they are selling a distance line.',
  },
  {
    index: 3,
    rank: 'PRO',
    enemyId: 'counterpuncher',
    difficulty: 'hard',
    title: 'MIND GAMES',
    blurb: 'Veyne skipped the press conference and sent a tape of your last three fights instead, with your own tells circled in red.',
  },
  {
    index: 4,
    rank: 'CHAMPION',
    enemyId: 'champion',
    difficulty: 'champion',
    title: 'TITLE NIGHT',
    blurb: 'Sold out, main event, the belt on the table between you. August has not looked at you once all week — that is how he handles the ones he respects.',
  },
];

/** Out-of-range means the ladder is finished, not that something broke. */
export function stageFor(index: number): CareerStage | null {
  if (!Number.isInteger(index) || index < 0 || index >= CAREER_LADDER.length) return null;
  return CAREER_LADDER[index];
}

/** Clamped so a completed career still reports CHAMPION on the results screen. */
export function rankForStage(index: number): CareerRank {
  if (!Number.isFinite(index)) return CAREER_LADDER[0].rank;
  const i = Math.floor(clamp(index, 0, CAREER_LADDER.length - 1));
  return CAREER_LADDER[i].rank;
}
