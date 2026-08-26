import type { Fighter } from '@/entities/Fighter';
import { RAGE } from '@/config/gameConfig';
import { clamp } from '@/utils/math';

export type RageEvent =
  | 'hitLanded'
  | 'comboStep'
  | 'block'
  | 'perfectBlock'
  | 'dodge'
  | 'perfectDodge'
  | 'counter'
  | 'damageTaken';

const GAINS: Record<RageEvent, number> = {
  hitLanded: RAGE.onHitLanded,
  comboStep: RAGE.onComboStep,
  block: RAGE.onBlock,
  perfectBlock: RAGE.onPerfectBlock,
  dodge: RAGE.onDodge,
  perfectDodge: RAGE.onPerfectDodge,
  counter: RAGE.onCounter,
  damageTaken: RAGE.onDamageTaken,
};

/**
 * The adrenaline meter. It fills fastest from *skilful* play — perfect blocks
 * and perfect dodges are worth roughly twice a landed punch — which is what
 * pushes players to defend instead of only swinging.
 */
export class RageSystem {
  /** Adds meter. `scale` lets damage taken contribute per point of damage. */
  award(fighter: Fighter, event: RageEvent, scale = 1): void {
    if (fighter.vitals.rageActive) return;
    const gain = GAINS[event] * scale;
    fighter.vitals.rage = clamp(fighter.vitals.rage + gain, 0, fighter.vitals.maxRage);
  }

  get canActivate(): (f: Fighter) => boolean {
    return (f: Fighter) => !f.vitals.rageActive && f.vitals.rage >= f.vitals.maxRage && f.alive && !f.downed;
  }

  /** Returns true when rage actually started. */
  tryActivate(fighter: Fighter, now: number): boolean {
    if (!this.canActivate(fighter)) return false;
    fighter.triggerRage(now);
    return true;
  }

  update(fighter: Fighter, dtMs: number): void {
    if (fighter.vitals.rageActive) return;
    // A slow bleed so meter earned early in round one does not simply bank
    // until round three.
    if (fighter.vitals.rage > 0) {
      fighter.vitals.rage = Math.max(0, fighter.vitals.rage - RAGE.decayPerSec * (dtMs / 1000));
    }
  }
}
