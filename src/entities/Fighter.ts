import type { Facing, Region, Side } from '@/types/core';
import type { AttackDef, FighterVitals } from '@/types/combat';
import type { AnimState, FighterSkin, FighterStyle, GlovePositions, Hurtbox, RenderState } from '@/types/fighter';
import { COMBAT, STAMINA, WORLD } from '@/config/gameConfig';
import { AnimationSystem } from '@/game/AnimationSystem';
import { buildAnimLibrary, buildStance } from '@/data/animations';
import { getStyle } from '@/data/fighters';
import { getSkin } from '@/render/skins';
import { clamp, clamp01 } from '@/utils/math';

/**
 * A fighter in the ring: vitals, position, the attack state machine and the
 * animation rig. Deliberately knows nothing about *who* is driving it — the
 * player's vision input and the AI controller both talk to the same surface,
 * which is what keeps the combat rules identical for both sides.
 */

export type ActionState =
  | 'idle'
  | 'walk'
  | 'attack'
  | 'recover'
  | 'hit'
  | 'stagger'
  | 'down'
  | 'getup'
  | 'dodge'
  | 'duck'
  | 'rage'
  | 'defeated'
  | 'victory';

export type AttackPhase = 'none' | 'startup' | 'active' | 'recovery';

export interface FighterInit {
  id: 'player' | 'enemy';
  name: string;
  styleId: string;
  maxHp: number;
  maxStamina: number;
  x: number;
  facing: Facing;
  powerScale?: number;
  speedScale?: number;
}

export class Fighter {
  readonly id: 'player' | 'enemy';
  readonly name: string;
  readonly style: FighterStyle;
  readonly skin: FighterSkin;
  readonly powerScale: number;
  readonly speedScale: number;

  readonly anim: AnimationSystem;
  readonly vitals: FighterVitals;

  x: number;
  facing: Facing;
  /** Extra vertical offset, used by the dodge slip and knockdown. */
  private velX = 0;

  action: ActionState = 'idle';
  attackPhase: AttackPhase = 'none';
  attack: AttackDef | null = null;
  /** STRIKE POWER (0-100) that launched the current attack. */
  attackPower = 0;
  attackTimer = 0;
  attackHasHit = false;
  /** Wall-clock time the current attack's hitbox goes live. */
  attackImpactAt = 0;

  guarding = false;
  guardSince = -1e9;
  /** Set when the guard went up, used to score a perfect block. */
  private guardRaisedAt = -1e9;

  dodgeDir: Side | null = null;
  dodgeUntil = 0;
  dodgeStartedAt = -1e9;
  ducking = false;
  duckStartedAt = -1e9;

  staggerUntil = 0;
  downUntil = 0;
  getUpUntil = 0;
  invulnUntil = 0;
  counterWindowUntil = 0;

  flash = 0;
  alpha = 1;
  /** Cumulative time without acting, feeds stamina regen and the AI's read. */
  idleMs = 0;
  private staminaHoldUntil = 0;
  private lastAttackAt = -1e9;

  private readonly renderState: RenderState;

  constructor(init: FighterInit) {
    this.id = init.id;
    this.name = init.name;
    this.style = getStyle(init.styleId);
    this.skin = getSkin(this.style.id);
    this.powerScale = init.powerScale ?? 1;
    this.speedScale = init.speedScale ?? 1;
    this.x = init.x;
    this.facing = init.facing;

    const features = this.style.features ?? {};
    const stance = buildStance(features.bulk ?? 1);
    this.anim = new AnimationSystem(
      buildAnimLibrary({ reach: features.reach ?? 1, bulk: features.bulk ?? 1 }),
      stance,
    );
    this.anim.setSpeedScale(this.speedScale);

    this.vitals = {
      hp: init.maxHp,
      maxHp: init.maxHp,
      stamina: init.maxStamina,
      maxStamina: init.maxStamina,
      rage: 0,
      maxRage: 100,
      rageActive: false,
      rageTimeLeft: 0,
      knockdowns: 0,
    };

    this.renderState = {
      pose: { ...stance },
      root: { x: 0, y: 0 },
      rot: 0,
      scale: 1,
      state: 'STANCE',
      phase: 0,
      facing: this.facing,
      worldX: this.x,
      worldY: WORLD.floorY,
      height: WORLD.fighterHeight * (features.height ?? 1),
      flash: 0,
      rage: 0,
      guarding: false,
      downed: false,
      alpha: 1,
    };
  }

  // ------------------------------------------------------------ queries

  get height(): number {
    return this.renderState.height;
  }

  get alive(): boolean {
    return this.vitals.hp > 0;
  }

  get downed(): boolean {
    return this.action === 'down' || this.action === 'getup';
  }

  /** True while the fighter cannot act at all. */
  get busy(): boolean {
    return (
      this.action === 'attack' ||
      this.action === 'recover' ||
      this.action === 'stagger' ||
      this.action === 'hit' ||
      this.downed ||
      this.action === 'defeated' ||
      this.action === 'rage'
    );
  }

  /** True while a new attack may be started. */
  get canAct(): boolean {
    return (
      this.alive &&
      !this.downed &&
      this.action !== 'stagger' &&
      this.action !== 'defeated' &&
      this.action !== 'rage' &&
      this.attackPhase === 'none'
    );
  }

  get recovering(): boolean {
    return this.attackPhase === 'recovery' || this.action === 'recover';
  }

  get staggered(): boolean {
    return this.action === 'stagger';
  }

  get staminaFraction(): number {
    return this.vitals.maxStamina > 0 ? this.vitals.stamina / this.vitals.maxStamina : 0;
  }

  get hpFraction(): number {
    return this.vitals.maxHp > 0 ? this.vitals.hp / this.vitals.maxHp : 0;
  }

  get exhausted(): boolean {
    return this.staminaFraction < STAMINA.exhaustedThreshold;
  }

  get tired(): boolean {
    return this.staminaFraction < STAMINA.tiredThreshold;
  }

  /** ms until the in-flight attack lands, or null when nothing is in flight. */
  incomingImpactIn(now: number): number | null {
    if (this.attackPhase !== 'startup' && this.attackPhase !== 'active') return null;
    return Math.max(0, this.attackImpactAt - now);
  }

  // ------------------------------------------------------------ actions

  /** Starts an attack if the fighter can act and can pay for it. */
  startAttack(def: AttackDef, power: number, now: number): boolean {
    if (!this.canAct) return false;
    const cost = def.staminaCost * (this.vitals.rageActive ? 0.8 : 1);
    if (this.vitals.stamina < cost * 0.55) return false;

    this.vitals.stamina = Math.max(0, this.vitals.stamina - cost);
    this.staminaHoldUntil = now + STAMINA.regenDelayMs;
    this.attack = def;
    this.attackPower = clamp(power, 0, 100);
    this.attackPhase = 'startup';
    this.attackHasHit = false;
    this.action = 'attack';
    this.guarding = false;
    this.idleMs = 0;
    this.lastAttackAt = now;

    // Tired fighters wind up slower; rage speeds everything up. The animation
    // and the hitbox timing stay locked together so what you see is what hits.
    const speed = this.attackSpeedScale();
    this.attackTimer = def.startupMs / speed;
    this.attackImpactAt = now + this.attackTimer;
    this.anim.play(def.anim, { force: true, speed });
    return true;
  }

  private attackSpeedScale(): number {
    let s = this.speedScale;
    if (this.vitals.rageActive) s *= COMBAT.rageSpeedScale;
    if (this.exhausted) s *= 0.72;
    else if (this.tired) s *= 0.87;
    return clamp(s, 0.5, 2.2);
  }

  setGuard(on: boolean, now: number): void {
    if (on === this.guarding) return;
    if (on) {
      if (!this.canAct && this.action !== 'idle' && this.action !== 'walk') return;
      this.guarding = true;
      this.guardRaisedAt = now;
      this.guardSince = now;
      this.anim.play('GUARD');
    } else {
      this.guarding = false;
      this.guardSince = -1e9;
      if (this.action === 'idle') this.anim.play('STANCE');
    }
  }

  /** ms since the guard went up — under the perfect-block window scores a parry. */
  guardAgeMs(now: number): number {
    return this.guarding ? now - this.guardRaisedAt : Number.POSITIVE_INFINITY;
  }

  startDodge(dir: Side, now: number): boolean {
    if (!this.canAct || this.guarding) return false;
    if (this.vitals.stamina < STAMINA.dodgeCost) return false;
    this.vitals.stamina = Math.max(0, this.vitals.stamina - STAMINA.dodgeCost);
    this.staminaHoldUntil = now + STAMINA.regenDelayMs;
    this.dodgeDir = dir;
    this.dodgeStartedAt = now;
    this.dodgeUntil = now + 380;
    this.action = 'dodge';
    this.idleMs = 0;
    this.anim.play(dir === 'left' ? 'DODGE_LEFT' : 'DODGE_RIGHT', { force: true });
    return true;
  }

  dodgeAgeMs(now: number): number {
    return this.dodgeDir ? now - this.dodgeStartedAt : Number.POSITIVE_INFINITY;
  }

  setDuck(on: boolean, now: number): void {
    if (on === this.ducking) return;
    if (on) {
      if (!this.canAct) return;
      this.ducking = true;
      this.duckStartedAt = now;
      this.action = 'duck';
      this.anim.play('DUCK');
    } else {
      this.ducking = false;
      if (this.action === 'duck') {
        this.action = 'idle';
        this.anim.play('STANCE');
      }
    }
  }

  duckAgeMs(now: number): number {
    return this.ducking ? now - this.duckStartedAt : Number.POSITIVE_INFINITY;
  }

  /** Applies a hit reaction. Damage itself is applied by the combat system. */
  react(region: Region, stagger: boolean, knockback: number, now: number): void {
    this.cancelAttack();
    this.flash = 1;
    this.guarding = false;
    this.dodgeDir = null;
    this.ducking = false;
    this.velX -= this.facing * knockback;

    if (stagger) {
      this.action = 'stagger';
      this.staggerUntil = now + COMBAT.staggerMs;
      this.anim.play('STAGGER', { force: true });
    } else {
      this.action = 'hit';
      this.staggerUntil = now + 240;
      this.anim.play(region === 'body' ? 'HIT_BODY' : 'HIT_HEAD', { force: true });
    }
  }

  blockReaction(now: number, knockback: number): void {
    this.flash = Math.max(this.flash, 0.4);
    this.velX -= this.facing * knockback * 0.35;
    this.staminaHoldUntil = now + 220;
    this.anim.play('BLOCK_IMPACT', { force: true });
  }

  knockDown(now: number): void {
    this.cancelAttack();
    this.guarding = false;
    this.dodgeDir = null;
    this.ducking = false;
    this.vitals.knockdowns += 1;
    this.action = 'down';
    // Held until the referee's count finishes; the round system owns the timer.
    this.downUntil = now + COMBAT.knockdownCountSeconds * 1000;
    this.invulnUntil = this.downUntil + 260;
    this.anim.play('KNOCKDOWN', { force: true });
  }

  beginGetUp(now: number): void {
    if (this.action !== 'down') return;
    this.action = 'getup';
    this.getUpUntil = now + COMBAT.getUpMs;
    this.invulnUntil = this.getUpUntil + 320;
    // Getting up is a reprieve, not a reset: a floored fighter comes back
    // hurt but with enough wind to keep fighting.
    this.vitals.stamina = Math.max(this.vitals.stamina, this.vitals.maxStamina * 0.45);
    this.anim.play('GET_UP', { force: true });
  }

  triggerRage(now: number): void {
    this.vitals.rageActive = true;
    this.vitals.rageTimeLeft = COMBAT.rageDurationMs;
    this.vitals.rage = 0;
    this.cancelAttack();
    this.action = 'rage';
    this.staggerUntil = now + 620;
    this.invulnUntil = now + 700;
    this.anim.setSpeedScale(this.speedScale * COMBAT.rageSpeedScale);
    this.anim.play('RAGE', { force: true });
  }

  declareVictory(): void {
    this.cancelAttack();
    this.action = 'victory';
    this.anim.play('VICTORY', { force: true });
  }

  declareDefeat(): void {
    this.cancelAttack();
    this.action = 'defeated';
    this.anim.play('DEFEAT', { force: true });
  }

  cancelAttack(): void {
    this.attack = null;
    this.attackPhase = 'none';
    this.attackTimer = 0;
    this.attackHasHit = false;
  }

  /** Horizontal movement request, -1 back / 0 hold / 1 forward. */
  move(dir: -1 | 0 | 1, dtMs: number): void {
    if (dir === 0 || !this.canAct || this.guarding) return;
    const speed = COMBAT.walkSpeed * (this.tired ? 0.72 : 1) * (this.vitals.rageActive ? 1.15 : 1);
    this.x += this.facing * dir * speed * (dtMs / 1000);
    this.x = clamp(this.x, WORLD.minX, WORLD.maxX);
    if (this.action === 'idle') {
      this.action = 'walk';
      this.anim.play(dir > 0 ? 'WALK_FWD' : 'WALK_BACK');
    }
    this.idleMs = 0;
  }

  // ------------------------------------------------------------ tick

  update(dtMs: number, now: number): void {
    const dt = dtMs / 1000;

    // --- knockback slide -------------------------------------------------
    if (Math.abs(this.velX) > 0.5) {
      this.x = clamp(this.x + this.velX * dt, WORLD.minX, WORLD.maxX);
      this.velX *= Math.exp(-9 * dt);
    } else {
      this.velX = 0;
    }

    // --- attack phases ---------------------------------------------------
    if (this.attackPhase !== 'none' && this.attack) {
      this.attackTimer -= dtMs;
      if (this.attackTimer <= 0) {
        const speed = this.attackSpeedScale();
        if (this.attackPhase === 'startup') {
          this.attackPhase = 'active';
          this.attackTimer = this.attack.activeMs / speed;
        } else if (this.attackPhase === 'active') {
          this.attackPhase = 'recovery';
          this.action = 'recover';
          this.attackTimer = this.attack.recoveryMs / speed * (this.tired ? 1.35 : 1);
        } else {
          this.cancelAttack();
          this.action = 'idle';
        }
      }
    }

    // --- timed states ----------------------------------------------------
    if (this.action === 'stagger' || this.action === 'hit' || this.action === 'rage') {
      if (now >= this.staggerUntil) {
        this.action = 'idle';
        this.anim.play('STANCE');
      }
    }
    if (this.action === 'getup' && now >= this.getUpUntil) {
      this.action = 'idle';
      this.anim.play('STANCE');
    }
    if (this.dodgeDir && now >= this.dodgeUntil) {
      this.dodgeDir = null;
      if (this.action === 'dodge') {
        this.action = 'idle';
        this.anim.play('STANCE');
      }
    }
    if (this.action === 'walk' && this.anim.current !== 'WALK_FWD' && this.anim.current !== 'WALK_BACK') {
      this.action = 'idle';
    }

    // --- rage ------------------------------------------------------------
    if (this.vitals.rageActive) {
      this.vitals.rageTimeLeft -= dtMs;
      if (this.vitals.rageTimeLeft <= 0) {
        this.vitals.rageActive = false;
        this.vitals.rageTimeLeft = 0;
        this.anim.setSpeedScale(this.speedScale);
      }
    }

    // --- stamina ---------------------------------------------------------
    if (this.guarding) {
      this.vitals.stamina = Math.max(0, this.vitals.stamina - STAMINA.guardDrain * dt);
      this.staminaHoldUntil = now + 180;
      // A shell that runs the tank dry drops on its own, which stops turtling
      // from being a free strategy.
      if (this.vitals.stamina <= 0) this.setGuard(false, now);
    } else if (now >= this.staminaHoldUntil) {
      const rate = STAMINA.regen * (this.downed ? 1.8 : 1) * (this.action === 'idle' ? 1.15 : 0.85);
      this.vitals.stamina = Math.min(this.vitals.maxStamina, this.vitals.stamina + rate * dt);
    }

    // --- idle bookkeeping -------------------------------------------------
    if (this.action === 'idle' && !this.guarding) this.idleMs += dtMs;
    else if (this.action !== 'idle') this.idleMs = 0;

    // --- anim + presentation ---------------------------------------------
    if (this.action === 'idle' && !this.guarding && this.anim.current === 'STANCE') {
      // Nothing to do — STANCE already loops.
    }
    this.flash = Math.max(0, this.flash - dtMs / 130);
    this.anim.update(dtMs);
    this.syncRenderState();
  }

  private syncRenderState(): void {
    const s = this.anim.sample();
    const rs = this.renderState;
    rs.pose = s.pose;
    rs.root = s.root;
    rs.rot = s.rot;
    rs.scale = s.scale;
    rs.state = this.anim.current;
    rs.phase = this.anim.phase;
    rs.facing = this.facing;
    rs.worldX = this.x;
    rs.worldY = WORLD.floorY;
    rs.flash = this.flash;
    rs.rage = this.vitals.rageActive ? 1 : clamp01(this.vitals.rage / this.vitals.maxRage) * 0.35;
    rs.guarding = this.guarding;
    rs.downed = this.downed;
    rs.alpha = this.alpha;
  }

  get render(): RenderState {
    return this.renderState;
  }

  /** Converts a rig joint into world space. */
  jointToWorld(name: keyof RenderState['pose'], out: { x: number; y: number }): void {
    const rs = this.renderState;
    const unit = (rs.height / 100) * rs.scale;
    const j = rs.pose[name];
    const lx = j.x + rs.root.x;
    const ly = j.y + rs.root.y;

    if (Math.abs(rs.rot) > 1e-4) {
      // Rotate about the pelvis so a knocked-down body's joints land correctly.
      const p = rs.pose.pelvis;
      const px = p.x + rs.root.x;
      const py = p.y + rs.root.y;
      const cos = Math.cos(rs.rot);
      const sin = Math.sin(rs.rot);
      const dx = lx - px;
      const dy = ly - py;
      const rx = px + dx * cos - dy * sin;
      const ry = py + dx * sin + dy * cos;
      out.x = rs.worldX + rs.facing * rx * unit;
      out.y = rs.worldY - ry * unit;
      return;
    }

    out.x = rs.worldX + rs.facing * lx * unit;
    out.y = rs.worldY - ly * unit;
  }

  /** Current world-space glove positions, used for impact effects. */
  gloves(out: GlovePositions): GlovePositions {
    this.jointToWorld('handL', out.left);
    this.jointToWorld('handR', out.right);
    return out;
  }

  /** Hurtboxes derived from the live rig, so a ducking fighter really is lower. */
  hurtboxes(out: Hurtbox[]): Hurtbox[] {
    out.length = 0;
    const rs = this.renderState;
    const unit = (rs.height / 100) * rs.scale;
    const w = unit * 26;

    this.jointToWorld('head', SCRATCH_A);
    out.push({ region: 'head', x: SCRATCH_A.x - w * 0.5, y: SCRATCH_A.y - unit * 11, w, h: unit * 22 });

    this.jointToWorld('chest', SCRATCH_A);
    this.jointToWorld('pelvis', SCRATCH_B);
    const bodyTop = Math.min(SCRATCH_A.y, SCRATCH_B.y) - unit * 6;
    const bodyBottom = Math.max(SCRATCH_A.y, SCRATCH_B.y) + unit * 4;
    const bodyW = unit * 30;
    out.push({
      region: 'body',
      x: (SCRATCH_A.x + SCRATCH_B.x) * 0.5 - bodyW * 0.5,
      y: bodyTop,
      w: bodyW,
      h: Math.max(unit * 14, bodyBottom - bodyTop),
    });

    this.jointToWorld('kneeL', SCRATCH_A);
    const legW = unit * 26;
    out.push({
      region: 'legs',
      x: rs.worldX - legW * 0.5,
      y: SCRATCH_A.y - unit * 4,
      w: legW,
      h: Math.max(unit * 10, rs.worldY - SCRATCH_A.y + unit * 4),
    });

    return out;
  }

  reset(x: number): void {
    this.x = x;
    this.velX = 0;
    this.vitals.hp = this.vitals.maxHp;
    this.vitals.stamina = this.vitals.maxStamina;
    this.vitals.rage = 0;
    this.vitals.rageActive = false;
    this.vitals.rageTimeLeft = 0;
    this.vitals.knockdowns = 0;
    this.cancelAttack();
    this.action = 'idle';
    this.guarding = false;
    this.dodgeDir = null;
    this.ducking = false;
    this.flash = 0;
    this.alpha = 1;
    this.idleMs = 0;
    this.counterWindowUntil = 0;
    this.invulnUntil = 0;
    this.anim.setSpeedScale(this.speedScale);
    this.anim.reset('STANCE');
    this.syncRenderState();
  }

  /** Between rounds: reset posture and wind, keep the damage. */
  resetForRound(x: number): void {
    this.x = x;
    this.velX = 0;
    this.vitals.stamina = this.vitals.maxStamina;
    this.cancelAttack();
    this.action = 'idle';
    this.guarding = false;
    this.dodgeDir = null;
    this.ducking = false;
    this.flash = 0;
    this.counterWindowUntil = 0;
    this.invulnUntil = 0;
    this.anim.reset('STANCE');
    this.syncRenderState();
  }

  draw(ctx: CanvasRenderingContext2D, timeMs: number): void {
    this.skin.draw(ctx, this.renderState, this.style, timeMs);
  }

  /** Last attack timestamp, for the AI's read on tempo. */
  get lastAttackTime(): number {
    return this.lastAttackAt;
  }

  /** Animation state currently playing, surfaced for the debug panel. */
  get animState(): AnimState {
    return this.anim.current;
  }
}

const SCRATCH_A = { x: 0, y: 0 };
const SCRATCH_B = { x: 0, y: 0 };
