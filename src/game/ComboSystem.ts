import type { ComboState } from '@/types/combat';
import type { PunchKind } from '@/types/vision';
import { COMBO } from '@/config/gameConfig';
import { clamp } from '@/utils/math';

/**
 * Chains landed punches into a combo.
 *
 * Two rules make it feel like boxing rather than button mashing: the window is
 * short, and repeating the exact same punch is worth less than mixing them up.
 */
export class ComboSystem {
  private count = 0;
  private window = 0;
  private best = 0;
  private lastKind: PunchKind | null = null;
  private repeats = 0;
  /** Lengths of every completed chain, for the post-fight analytics. */
  readonly history: number[] = [];

  get state(): ComboState {
    return {
      count: this.count,
      window: this.window,
      best: this.best,
      multiplier: this.multiplier,
      lastKind: this.lastKind,
    };
  }

  get multiplier(): number {
    if (this.count < 2) return 1;
    return clamp(1 + (this.count - 1) * COMBO.damagePerStep, 1, COMBO.maxMultiplier);
  }

  get count_(): number {
    return this.count;
  }

  /** A punch landed. Returns the new combo count. */
  land(kind: PunchKind): number {
    if (this.window > 0) {
      this.count += 1;
    } else {
      this.count = 1;
      this.repeats = 0;
    }

    // Throwing the same punch over and over shortens the window, so a real
    // combination is rewarded over spamming one hand.
    if (kind === this.lastKind) this.repeats += 1;
    else this.repeats = 0;

    this.lastKind = kind;
    this.window = COMBO.windowMs * (this.repeats >= 2 ? 0.72 : 1);
    if (this.count > this.best) this.best = this.count;
    return this.count;
  }

  /** A punch missed or was blocked — the chain survives but the clock does not reset. */
  graze(): void {
    this.window = Math.min(this.window, COMBO.windowMs * 0.4);
  }

  /** Getting hit, or letting the window lapse, ends the chain. */
  break(): void {
    if (this.count >= 2) this.history.push(this.count);
    this.count = 0;
    this.window = 0;
    this.repeats = 0;
    this.lastKind = null;
  }

  update(dtMs: number): boolean {
    if (this.window <= 0) return false;
    this.window -= dtMs;
    if (this.window <= 0) {
      this.window = 0;
      this.break();
      return true;
    }
    return false;
  }

  get bestCombo(): number {
    return this.best;
  }

  get averageLength(): number {
    if (!this.history.length) return 0;
    return this.history.reduce((a, b) => a + b, 0) / this.history.length;
  }

  reset(): void {
    this.count = 0;
    this.window = 0;
    this.best = 0;
    this.repeats = 0;
    this.lastKind = null;
    this.history.length = 0;
  }

  /** Between rounds the chain drops but the record stands. */
  resetChain(): void {
    this.break();
  }
}
