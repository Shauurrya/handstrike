import type { Box, Region } from '@/types/core';
import type { AttackDef, HitReport, HitResult } from '@/types/combat';
import type { Hurtbox } from '@/types/fighter';
import type { Fighter } from '@/entities/Fighter';
import { COMBAT, FEEL, PALETTE, STAMINA } from '@/config/gameConfig';
import { clamp, clamp01, Rng } from '@/utils/math';
import { audio } from '@/audio/AudioEngine';
import type { ParticleSystem } from './ParticleSystem';
import type { ScreenFx } from './ScreenFx';
import { buildAttackHitbox, findHit, gapBetween, makeBox } from './HitboxSystem';
import type { RageSystem } from './RageSystem';

/**
 * Turns an in-flight attack into a result.
 *
 * The pipeline the brief asked for, in order:
 *   punch -> range -> hitbox/hurtbox -> guard & dodge -> damage -> reaction -> effects
 *
 * Nothing shortcuts to "punch detected = -10 HP": a punch that is out of range,
 * mistimed, blocked or slipped produces a completely different outcome, and the
 * defender's *own* choices are what decide which.
 */

export interface ResolveContext {
  /** Combo multiplier the attacker has earned. */
  comboMultiplier: number;
  /** Difficulty scaling, applied only to the AI's damage. */
  damageMultiplier: number;
  /** Effects are muted during training drills against a dummy. */
  effects: boolean;
}

interface AttackMemo {
  phase: string;
  attackId: string | null;
}

export class CombatSystem {
  private readonly rng = new Rng(0x51f3ab);
  private readonly box: Box = makeBox();
  private readonly hurtboxes: Hurtbox[] = [];
  private readonly memo = new Map<string, AttackMemo>();

  constructor(
    private readonly fx: ScreenFx,
    private readonly particles: ParticleSystem,
    private readonly rage: RageSystem,
  ) {}

  reset(): void {
    this.memo.clear();
  }

  /**
   * Called every frame for each fighter. Returns a report on the frame an
   * attack resolves (hit, block, dodge or whiff), otherwise null.
   */
  update(attacker: Fighter, defender: Fighter, now: number, ctx: ResolveContext): HitReport | null {
    const memoKey = attacker.id;
    const prev = this.memo.get(memoKey) ?? { phase: 'none', attackId: null };
    const attack = attacker.attack;
    const phase = attacker.attackPhase;

    // The active window just closed with nothing landed — that is a whiff, and
    // it is what opens the opponent's counter window.
    if (prev.phase === 'active' && phase !== 'active' && !attacker.attackHasHit && prev.attackId) {
      this.memo.set(memoKey, { phase, attackId: attack?.id ?? null });
      const whiffed = attack ?? null;
      if (whiffed) {
        if (ctx.effects) audio.play('punchWhiff', { volume: 0.5 });
        defender.counterWindowUntil = now + COMBAT.counterWindowMs;
        return this.report(attacker, whiffed, 'whiff', 'body', 0, 0, false, false, false, now, attacker.x, attacker.render.worldY - attacker.height * 0.5);
      }
    }

    this.memo.set(memoKey, { phase, attackId: attack?.id ?? null });

    if (!attack || phase !== 'active' || attacker.attackHasHit) return null;

    // --- range ------------------------------------------------------------
    if (gapBetween(attacker, defender) > attack.range) return null;

    // --- hitbox vs hurtbox --------------------------------------------------
    buildAttackHitbox(attacker, attack, this.box);
    defender.hurtboxes(this.hurtboxes);
    const contact = findHit(this.box, this.hurtboxes, attack.target);
    if (!contact) return null;

    attacker.attackHasHit = true;

    // Invulnerable frames while getting up stop a fighter being farmed on the
    // canvas — the defender simply is not there to be hit.
    if (now < defender.invulnUntil) {
      return this.report(attacker, attack, 'whiff', contact.region, 0, 0, false, false, false, now, contact.x, contact.y);
    }

    return this.resolveContact(attacker, defender, attack, contact.region, contact.x, contact.y, now, ctx);
  }

  private resolveContact(
    attacker: Fighter,
    defender: Fighter,
    attack: AttackDef,
    region: Region,
    hx: number,
    hy: number,
    now: number,
    ctx: ResolveContext,
  ): HitReport {
    const power = attacker.attackPower;

    // --- did the defender avoid it? ---------------------------------------
    const dodging = defender.dodgeDir !== null && now < defender.dodgeUntil;
    const duckedUnder = defender.ducking && region === 'head' && attack.kind !== 'uppercut';

    if (dodging || duckedUnder) {
      const age = duckedUnder ? defender.duckAgeMs(now) : defender.dodgeAgeMs(now);
      const perfect = age <= COMBAT.perfectDodgeWindowMs;
      if (perfect) {
        attacker.counterWindowUntil = 0;
        defender.counterWindowUntil = now + COMBAT.counterWindowMs;
        this.rage.award(defender, 'perfectDodge');
      } else {
        this.rage.award(defender, 'dodge');
      }
      if (ctx.effects) this.dodgeEffects(defender, perfect, hx, hy);
      return this.report(attacker, attack, 'dodged', region, 0, power, false, false, perfect, now, hx, hy);
    }

    // --- guard -------------------------------------------------------------
    if (defender.guarding) {
      const perfect = defender.guardAgeMs(now) <= COMBAT.perfectBlockWindowMs;
      // A high guard is much less use against the body, which is what makes
      // body shots the right answer to a turtle.
      const bodyLeak = region === 'body' ? 2.1 : 1;
      const scale = perfect ? COMBAT.perfectBlockScale : COMBAT.guardDamageScale * bodyLeak;
      const damage = this.computeDamage(attacker, defender, attack, power, ctx) * scale;
      const applied = this.applyDamage(defender, damage);

      // Blocking still costs wind, so a shell cannot be held forever.
      defender.vitals.stamina = Math.max(0, defender.vitals.stamina - attack.staminaCost * (perfect ? 0.18 : 0.55));
      defender.blockReaction(now, attack.knockback);

      if (perfect) {
        defender.counterWindowUntil = now + COMBAT.counterWindowMs;
        this.rage.award(defender, 'perfectBlock');
      } else {
        this.rage.award(defender, 'block');
      }
      if (ctx.effects) this.blockEffects(attacker, defender, perfect, hx, hy, attack);

      return this.report(attacker, attack, 'blocked', region, applied, power, false, false, perfect, now, hx, hy);
    }

    // --- clean connection ---------------------------------------------------
    const isCounter = now < attacker.counterWindowUntil;
    if (isCounter) attacker.counterWindowUntil = 0;

    let damage = this.computeDamage(attacker, defender, attack, power, ctx);
    if (isCounter) damage *= 1 + COMBAT.counterDamageBonus;

    // Criticals scale with how hard the punch was thrown, so a lazy tap can
    // never roll a haymaker.
    const critChance = COMBAT.criticalChanceBase + (power / 100) * 0.1 + (attacker.vitals.rageActive ? 0.08 : 0);
    const critical = this.rng.chance(critChance);
    if (critical) damage *= COMBAT.criticalMultiplier;

    const applied = this.applyDamage(defender, damage);

    // --- reaction -----------------------------------------------------------
    const staggerRoll =
      attack.staggerChance +
      (power / 100) * 0.12 +
      (critical ? 0.25 : 0) +
      (defender.exhausted ? 0.18 : 0);
    const stagger = this.rng.chance(clamp(staggerRoll, 0, 0.85));

    const knockdown = this.shouldKnockDown(defender, applied, critical);
    if (knockdown) {
      defender.knockDown(now);
    } else {
      defender.react(region, stagger, attack.knockback * (critical ? 1.5 : 1), now);
    }

    // A body shot drains the wind as well as the health.
    if (region === 'body') {
      defender.vitals.stamina = Math.max(0, defender.vitals.stamina - applied * 0.9);
    }

    this.rage.award(attacker, 'hitLanded');
    this.rage.award(defender, 'damageTaken', applied);
    if (isCounter) this.rage.award(attacker, 'counter');

    if (ctx.effects) {
      this.hitEffects(attacker, defender, attack, region, applied, power, critical, isCounter, knockdown, hx, hy);
    }

    return this.report(
      attacker, attack, isCounter ? 'counter' : 'clean', region, applied, power,
      critical, knockdown, false, now, hx, hy,
    );
  }

  // ------------------------------------------------------------ damage

  private computeDamage(
    attacker: Fighter,
    defender: Fighter,
    attack: AttackDef,
    power: number,
    ctx: ResolveContext,
  ): number {
    let dmg = attack.damage * attacker.powerScale;

    // STRIKE POWER is a gameplay metric, not a physical force reading — it
    // simply scales the punch between a light tap and a committed shot.
    dmg *= 0.62 + (clamp01(power / 100) * 0.78);

    dmg *= ctx.comboMultiplier;
    dmg *= ctx.damageMultiplier;

    if (attacker.vitals.rageActive) dmg *= COMBAT.rageDamageScale;
    if (attacker.exhausted) dmg *= STAMINA.tiredDamageScale;
    else if (attacker.tired) dmg *= 0.82;

    if (defender.vitals.rageActive) dmg *= COMBAT.rageDamageTakenScale;

    return Math.max(0.5, dmg);
  }

  private applyDamage(defender: Fighter, damage: number): number {
    const rounded = Math.round(damage * 10) / 10;
    defender.vitals.hp = Math.max(0, defender.vitals.hp - rounded);
    return rounded;
  }

  /**
   * A fight does not end the instant the bar empties. Emptying it floors the
   * fighter; only running out of knockdowns finishes them.
   */
  private shouldKnockDown(defender: Fighter, damage: number, critical: boolean): boolean {
    if (defender.downed) return false;
    if (defender.vitals.hp <= 0) return true;
    if (damage < COMBAT.knockdownDamageThreshold) return false;
    // A big shot on a hurt, tired fighter can drop them early.
    const vulnerability = (1 - defender.hpFraction) * 0.5 + (1 - defender.staminaFraction) * 0.25;
    return this.rng.chance(clamp(vulnerability * (critical ? 0.55 : 0.3), 0, 0.6));
  }

  // ------------------------------------------------------------ effects

  private hitEffects(
    attacker: Fighter,
    defender: Fighter,
    attack: AttackDef,
    region: Region,
    damage: number,
    power: number,
    critical: boolean,
    counter: boolean,
    knockdown: boolean,
    hx: number,
    hy: number,
  ): void {
    const intensity = clamp01(power / 100) * (critical ? 1.4 : 1) * (counter ? 1.25 : 1);
    const dirX = attacker.facing;
    const colour = counter ? PALETTE.counter : critical ? PALETTE.crit : region === 'head' ? PALETTE.warn : PALETTE.enemy;

    this.particles.hitBurst(hx, hy, colour, intensity, dirX);
    this.fx.shake(attack.shake * (1 + intensity * 0.8) * (knockdown ? 1.8 : 1));
    this.fx.hitStop(attack.hitStop * (1 + intensity * 0.4) * (counter ? 1.5 : 1));

    if (counter) {
      this.fx.slowMo(FEEL.slowMoMs, FEEL.slowMoScale);
      this.fx.flash(PALETTE.counter, 0.28, 180);
      this.fx.text({ text: 'COUNTER!', x: hx, y: hy - 90, color: PALETTE.counter, size: 46, life: 900, shadow: PALETTE.counter });
      this.fx.text({ text: '+25% DAMAGE', x: hx, y: hy - 50, color: PALETTE.ink, size: 20, life: 850 });
      audio.play('counter');
    } else if (critical) {
      this.fx.flash(PALETTE.crit, 0.2, 140);
      this.fx.text({ text: 'CRITICAL', x: hx, y: hy - 78, color: PALETTE.crit, size: 34, life: 780, shadow: PALETTE.crit });
      audio.play('critical');
    }

    this.fx.text({
      text: String(Math.max(1, Math.round(damage))),
      x: hx + (this.rng.next() - 0.5) * 26,
      y: hy - 24,
      color: critical ? PALETTE.crit : PALETTE.ink,
      size: 22 + intensity * 16,
      life: 720,
    });

    audio.play(region === 'head' ? 'hitHead' : 'hitBody', { volume: 0.55 + intensity * 0.45, rate: 0.9 + intensity * 0.25 });
    if (power > 70 || critical) audio.play('punchHeavy', { volume: 0.5 });
    else audio.play('punchLight', { volume: 0.4 });

    if (knockdown) {
      this.fx.shake(FEEL.maxShake);
      this.fx.slowMo(620, 0.2);
      this.fx.flash('#ffffff', 0.5, 220);
      audio.play('knockdown');
      audio.crowdReaction(1);
      this.particles.burst('debris', hx, hy, { count: 22, color: PALETTE.crit, power: 1.4 });
    } else {
      audio.crowdReaction(intensity * 0.6);
    }

    defender.flash = 1;
  }

  private blockEffects(
    attacker: Fighter,
    defender: Fighter,
    perfect: boolean,
    hx: number,
    hy: number,
    attack: AttackDef,
  ): void {
    this.particles.blockBurst(hx, hy, attacker.facing);
    this.fx.shake(attack.shake * (perfect ? 0.7 : 0.45));
    this.fx.hitStop(perfect ? 90 : 40);
    if (perfect) {
      this.fx.flash(PALETTE.player, 0.22, 170);
      this.fx.text({ text: 'PERFECT BLOCK', x: hx, y: hy - 76, color: PALETTE.player, size: 34, life: 860, shadow: PALETTE.player });
      this.particles.impactRing(hx, hy, PALETTE.player, 1);
      audio.play('perfectBlock');
    } else {
      this.fx.text({ text: 'BLOCK', x: hx, y: hy - 52, color: PALETTE.inkDim, size: 20, life: 620 });
      audio.play('block');
    }
    defender.flash = Math.max(defender.flash, 0.5);
  }

  private dodgeEffects(defender: Fighter, perfect: boolean, hx: number, hy: number): void {
    this.particles.burst('dust', defender.x, defender.render.worldY, { count: 8, power: 0.6 });
    if (perfect) {
      this.fx.slowMo(280, 0.42);
      this.fx.flash(PALETTE.player, 0.16, 150);
      this.fx.text({ text: 'PERFECT DODGE', x: hx, y: hy - 70, color: PALETTE.player, size: 32, life: 840, shadow: PALETTE.player });
      this.particles.impactRing(defender.x, defender.render.worldY - defender.height * 0.5, PALETTE.player, 0.8);
      audio.play('dodge', { rate: 1.2, volume: 0.8 });
    } else {
      this.fx.text({ text: 'MISS', x: hx, y: hy - 46, color: PALETTE.inkDim, size: 18, life: 560 });
      audio.play('dodge', { volume: 0.5 });
    }
  }

  private report(
    attacker: Fighter,
    attack: AttackDef,
    result: HitResult,
    region: Region,
    damage: number,
    power: number,
    critical: boolean,
    knockdown: boolean,
    perfect: boolean,
    at: number,
    x: number,
    y: number,
  ): HitReport {
    return {
      attacker: attacker.id,
      attack,
      result,
      region,
      damage,
      power,
      critical,
      stagger: knockdown ? false : result === 'clean' || result === 'counter',
      knockdown,
      at,
      x,
      y,
      // `perfect` rides along on the result string for blocks/dodges; keep the
      // flag discoverable for the stats layer without widening HitResult.
      ...(perfect ? { perfect: true } : {}),
    } as HitReport & { perfect?: boolean };
  }
}

/** Widened report the engine reads, including the perfect-defence flag. */
export type CombatReport = HitReport & { perfect?: boolean };
