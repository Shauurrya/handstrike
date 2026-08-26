import type { RoundState } from '@/types/combat';
import { ROUNDS } from '@/config/gameConfig';

export type RoundOutcome = 'player' | 'enemy' | 'draw';

/**
 * Rounds, the clock and the judges' cards.
 *
 * Scoring is intentionally simple and arcade-flavoured — the ten-point must
 * system, one point deducted per knockdown — so a decision win is legible
 * without the player needing to read a rulebook.
 */
export class RoundSystem {
  private state: RoundState;

  constructor(total = ROUNDS.count, durationSec = ROUNDS.durationSec) {
    this.state = {
      index: 1,
      total,
      timeLeft: durationSec,
      duration: durationSec,
      scores: [],
      roundsWon: { player: 0, enemy: 0 },
    };
  }

  get current(): RoundState {
    return this.state;
  }

  get index(): number {
    return this.state.index;
  }

  get isFinalRound(): boolean {
    return this.state.index >= this.state.total;
  }

  get timeLeft(): number {
    return this.state.timeLeft;
  }

  get progress(): number {
    return this.state.duration > 0 ? 1 - this.state.timeLeft / this.state.duration : 0;
  }

  configure(total: number, durationSec: number): void {
    this.state = {
      index: 1,
      total,
      timeLeft: durationSec,
      duration: durationSec,
      scores: [],
      roundsWon: { player: 0, enemy: 0 },
    };
  }

  /** Ticks the clock. Returns true on the frame the round expires. */
  tick(dtMs: number): boolean {
    if (this.state.timeLeft <= 0) return false;
    this.state.timeLeft = Math.max(0, this.state.timeLeft - dtMs / 1000);
    return this.state.timeLeft <= 0;
  }

  /**
   * Scores the round just ended. `damage` decides who was busier and cleaner;
   * knockdowns override it, because putting someone down wins the round.
   */
  scoreRound(input: {
    playerDamage: number;
    enemyDamage: number;
    playerKnockdowns: number;
    enemyKnockdowns: number;
  }): RoundOutcome {
    const { playerDamage, enemyDamage, playerKnockdowns, enemyKnockdowns } = input;

    let winner: RoundOutcome;
    if (playerKnockdowns !== enemyKnockdowns) {
      // Fewer times floored wins the round.
      winner = playerKnockdowns < enemyKnockdowns ? 'player' : 'enemy';
    } else if (Math.abs(playerDamage - enemyDamage) < 4) {
      winner = 'draw';
    } else {
      winner = playerDamage > enemyDamage ? 'player' : 'enemy';
    }

    let playerScore: number;
    let enemyScore: number;
    if (winner === 'draw') {
      playerScore = ROUNDS.winPoints;
      enemyScore = ROUNDS.winPoints;
    } else if (winner === 'player') {
      playerScore = ROUNDS.winPoints;
      enemyScore = ROUNDS.losePoints;
    } else {
      playerScore = ROUNDS.losePoints;
      enemyScore = ROUNDS.winPoints;
    }

    playerScore -= playerKnockdowns * ROUNDS.knockdownPenalty;
    enemyScore -= enemyKnockdowns * ROUNDS.knockdownPenalty;

    this.state.scores.push({ player: playerScore, enemy: enemyScore });
    if (winner === 'player') this.state.roundsWon.player += 1;
    else if (winner === 'enemy') this.state.roundsWon.enemy += 1;

    return winner;
  }

  /** Advances to the next round. Returns false when the fight is over. */
  advance(): boolean {
    if (this.isFinalRound) return false;
    this.state.index += 1;
    this.state.timeLeft = this.state.duration;
    return true;
  }

  /** Totals on the judges' cards. */
  totals(): { player: number; enemy: number } {
    return this.state.scores.reduce(
      (acc, s) => ({ player: acc.player + s.player, enemy: acc.enemy + s.enemy }),
      { player: 0, enemy: 0 },
    );
  }

  /** Who wins if the fight goes the distance. */
  decision(): RoundOutcome {
    const { player, enemy } = this.totals();
    if (player === enemy) return 'draw';
    return player > enemy ? 'player' : 'enemy';
  }

  reset(): void {
    this.state.index = 1;
    this.state.timeLeft = this.state.duration;
    this.state.scores = [];
    this.state.roundsWon = { player: 0, enemy: 0 };
  }
}
