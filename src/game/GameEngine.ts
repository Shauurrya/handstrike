import type { Side } from '@/types/core';
import type { AIView } from '@/types/ai';
import type { Difficulty, FightStats } from '@/types/combat';
import type { PunchEvent, VisionFrame } from '@/types/vision';
import type { Settings, FightResult } from '@/store/appState';
import { COMBAT, PALETTE, ROUNDS, VISION, WORLD } from '@/config/gameConfig';
import { ATTACKS, attackForPunch } from '@/data/attacks';
import { DIFFICULTIES } from '@/data/difficulty';
import { getEnemy } from '@/data/enemies';
import { PLAYER_STYLE_ID } from '@/data/fighters';
import { Fighter } from '@/entities/Fighter';
import { audio } from '@/audio/AudioEngine';
import { arena } from '@/render/ArenaRenderer';
import { drawOverheadTags, drawStanceRings, type TagTarget } from '@/render/FighterTags';
import type { VisionController } from '@/vision/VisionController';
import { clamp, clamp01 } from '@/utils/math';
import { AIController } from './AIController';
import { ComboSystem } from './ComboSystem';
import { CombatSystem, type CombatReport } from './CombatSystem';
import { ParticleSystem } from './ParticleSystem';
import { PlayerProfiler } from './PlayerProfiler';
import { RageSystem } from './RageSystem';
import { RoundSystem } from './RoundSystem';
import { ScreenFx } from './ScreenFx';
import { KeyboardInput, type KeyAction } from './KeyboardInput';

export type EnginePhase =
  | 'intro'
  | 'round_card'
  | 'fighting'
  | 'knockdown'
  | 'round_end'
  | 'intermission'
  | 'ko'
  | 'finished'
  | 'paused'
  | 'tracking_lost';

export interface Announcement {
  text: string;
  sub?: string;
  tone?: 'neutral' | 'good' | 'bad' | 'rage';
}

/** Exactly the shape GameHUD renders. */
export interface HudState {
  playerName: string;
  enemyName: string;
  playerHp: number;
  playerHpMax: number;
  enemyHp: number;
  enemyHpMax: number;
  playerStamina: number;
  playerStaminaMax: number;
  enemyStamina: number;
  enemyStaminaMax: number;
  rage: number;
  rageMax: number;
  rageActive: boolean;
  round: number;
  roundTotal: number;
  timeLeft: number;
  roundsWon: { player: number; enemy: number };
  combo: number;
  comboWindow: number;
  lastAction: string | null;
  strikePower: number;
  announcement: Announcement | null;
  knockdownCount: number | null;
}

export interface EngineDebug {
  fps: number;
  phase: string;
  gap: number;
  aiState: string;
  aiReason: string;
  aiAdaptation: string;
  particles: number;
  confidence: number;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  vision: VisionController;
  settings: Settings;
  enemyId: string;
  difficulty: Difficulty;
  playerName?: string;
  onHud(state: HudState): void;
  onFinished(result: FightResult): void;
  onPhase(phase: EnginePhase): void;
}

const emptyStats = (): FightStats => ({
  landed: 0,
  missed: 0,
  blockedByOpponent: 0,
  damageDealt: 0,
  damageTaken: 0,
  blocks: 0,
  dodges: 0,
  perfectBlocks: 0,
  perfectDodges: 0,
  counters: 0,
  bestCombo: 0,
  knockdownsScored: 0,
  knockdownsTaken: 0,
  highestPower: 0,
  powerByHand: { left: [], right: [] },
  kindCounts: { jab: 0, cross: 0, hook: 0, uppercut: 0, straight: 0 },
  handCounts: { left: 0, right: 0 },
  comboLengths: [],
  dodgeDirections: { left: 0, right: 0 },
  timeGuardingMs: 0,
  timeAggressiveMs: 0,
  fightDurationMs: 0,
});

/**
 * The fight. Owns the loop, the two fighters, every combat system and the
 * canvas.
 *
 * Rendering and simulation are deliberately decoupled from vision: the vision
 * layer publishes frames on its own ~30Hz cadence and the engine simply reads
 * the most recent one, so a slow inference frame can never stall the 60fps
 * render or the physics.
 */
export class GameEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly vision: VisionController;
  private settings: Settings;

  readonly player: Fighter;
  readonly enemy: Fighter;

  private readonly fx = new ScreenFx();
  private readonly particles = new ParticleSystem();
  private readonly rage = new RageSystem();
  private readonly combat: CombatSystem;
  private readonly combo = new ComboSystem();
  private readonly rounds = new RoundSystem();
  private readonly profiler = new PlayerProfiler();
  private readonly ai: AIController;
  private readonly keys = new KeyboardInput();

  private readonly onHud: (s: HudState) => void;
  private readonly onFinished: (r: FightResult) => void;
  private readonly onPhaseChange: (p: EnginePhase) => void;

  private readonly difficulty: Difficulty;
  private readonly enemyId: string;

  private raf = 0;
  private running = false;
  private lastFrame = 0;
  private now = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 60;

  private phase: EnginePhase = 'intro';

  /**
   * Who-is-who callout strength on the fighter tags. Pinned at 1 whenever the
   * fight is not live (intro, round cards, between rounds), held briefly after
   * the bell, then faded to a quiet always-on marker so it never competes with
   * the fight itself.
   */
  private tagEmphasis = 1;
  private tagHoldMs = 0;
  private readonly tagTargets: TagTarget[];
  private phaseTimer = 0;
  private prePauseName: EnginePhase = 'fighting';
  private announcement: Announcement | null = null;
  private announceTimer = 0;
  private knockdownCount: number | null = null;
  private countdownTicked = -1;
  private downedFighter: Fighter | null = null;

  private lastVisionPunchId = 0;
  private lastAction: string | null = null;
  private lastActionAt = 0;
  private strikePower = 0;
  private trackingLostFor = 0;

  private stats = emptyStats();
  private roundDamage = { player: 0, enemy: 0 };
  private roundKnockdowns = { player: 0, enemy: 0 };
  private fightStart = 0;

  private hudAccum = 0;

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    const ctx = opts.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
    this.vision = opts.vision;
    this.settings = opts.settings;
    this.onHud = opts.onHud;
    this.onFinished = opts.onFinished;
    this.onPhaseChange = opts.onPhase;
    this.difficulty = opts.difficulty;
    this.enemyId = opts.enemyId;

    const def = getEnemy(opts.enemyId);
    const profile = DIFFICULTIES[opts.difficulty];

    this.player = new Fighter({
      id: 'player',
      name: opts.playerName ?? 'YOU',
      styleId: PLAYER_STYLE_ID,
      maxHp: 200,
      maxStamina: 110,
      x: WORLD.width * 0.5 - COMBAT.neutralGap * 0.5,
      facing: 1,
    });

    this.enemy = new Fighter({
      id: 'enemy',
      name: def.name,
      styleId: def.styleId,
      maxHp: def.maxHp,
      maxStamina: def.maxStamina,
      x: WORLD.width * 0.5 + COMBAT.neutralGap * 0.5,
      facing: -1,
      powerScale: def.powerScale,
      speedScale: def.speedScale,
    });

    // `fighter.render` hands back the same RenderState object every frame, so
    // this is built once and never reallocated in the draw loop.
    this.tagTargets = [
      { render: this.player.render, label: 'YOU', side: 'player' },
      { render: this.enemy.render, label: def.name, side: 'enemy' },
    ];

    this.combat = new CombatSystem(this.fx, this.particles, this.rage);
    this.ai = new AIController(def, profile, this.profiler);

    this.rounds.configure(this.settings.roundCount, this.settings.roundSeconds);
    this.applySettings();
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.now = this.lastFrame;
    this.fightStart = this.lastFrame;
    this.keys.attach();
    audio.startCrowd();
    audio.startMusic('fight');
    this.setPhase('intro');
    this.announce({ text: this.enemy.name, sub: `${DIFFICULTIES[this.difficulty].name.toUpperCase()} · ${this.rounds.current.total} ROUNDS` }, ROUNDS.introMs);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.keys.detach();
  }

  dispose(): void {
    this.stop();
    audio.stopCrowd();
    audio.stopMusic();
    this.particles.clear();
    this.fx.clear();
  }

  pause(): void {
    if (this.phase === 'paused' || this.phase === 'finished') return;
    this.prePauseName = this.phase;
    this.setPhase('paused');
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.setPhase(this.prePauseName);
    this.lastFrame = performance.now();
  }

  get isPaused(): boolean {
    return this.phase === 'paused';
  }

  get currentPhase(): EnginePhase {
    return this.phase;
  }

  setSettings(next: Settings): void {
    this.settings = next;
    this.applySettings();
  }

  private applySettings(): void {
    this.fx.setEnabled(this.settings.screenShake);
    this.fx.setReducedMotion(this.settings.reducedMotion);
    this.particles.setQuality(this.settings.particles);
    arena.setQuality(this.settings.particles);
    audio.setSoundEnabled(this.settings.sound);
    audio.setMusicEnabled(this.settings.music);
    audio.setMasterVolume(this.settings.masterVolume);
  }

  get debug(): EngineDebug {
    const d = this.ai.debug;
    return {
      fps: Math.round(this.fps),
      phase: this.phase,
      gap: Math.round(Math.abs(this.player.x - this.enemy.x)),
      aiState: d.state,
      aiReason: d.reason,
      aiAdaptation: d.adaptation,
      particles: this.particles.count,
      confidence: this.vision.punches.debugConfidence,
    };
  }

  // ---------------------------------------------------------------- loop

  private tick = (t: number): void => {
    if (!this.running) return;
    // Cap dt so a background tab or a long GC pause cannot teleport the fight.
    const realDt = Math.min(64, t - this.lastFrame);
    this.lastFrame = t;

    this.fpsAccum += realDt;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 400) {
      this.fps = (this.fpsFrames * 1000) / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    const timeScale = this.fx.update(realDt);
    const simDt = realDt * timeScale;
    this.now += simDt;

    if (this.phase !== 'paused') {
      this.step(simDt, realDt);
    }

    this.render(t);

    this.hudAccum += realDt;
    if (this.hudAccum >= 60) {
      this.hudAccum = 0;
      this.emitHud();
    }

    this.raf = requestAnimationFrame(this.tick);
  };

  private step(dt: number, realDt: number): void {
    const frame = this.vision.latest;

    this.updateTrackingWatchdog(frame, realDt);
    this.updatePhase(dt, realDt);
    this.updateTagEmphasis(realDt);

    const live = this.phase === 'fighting';

    if (live) {
      this.handlePlayerInput(frame);
      this.handleKeyboard();
      this.updateAI(dt);
      this.autoSpacing(dt);
    } else {
      // Anything that is not live combat still needs the guard released so a
      // paused player is not silently draining stamina.
      if (!live && this.player.guarding && this.phase !== 'knockdown') this.player.setGuard(false, this.now);
    }

    this.player.update(dt, this.now);
    this.enemy.update(dt, this.now);
    this.rage.update(this.player, dt);
    this.rage.update(this.enemy, dt);

    if (live) {
      this.resolveCombat(dt);
      if (this.combo.update(dt)) this.recordComboEnd();
      this.trackBehaviour(dt);
      if (this.rounds.tick(dt)) this.endRound('time');
    }

    this.particles.update(dt);
    arena.update(realDt);
    arena.setCrowdEnergy(this.crowdEnergy());
    audio.setCrowdEnergy(this.crowdEnergy());
  }

  // ---------------------------------------------------------------- input

  private handlePlayerInput(frame: VisionFrame): void {
    if (!frame.tracking.camera) return;

    // --- punches ----------------------------------------------------------
    for (const punch of frame.punches) {
      if (punch.id <= this.lastVisionPunchId) continue;
      this.lastVisionPunchId = punch.id;
      this.throwPunch(punch);
    }

    // --- defence ----------------------------------------------------------
    const g = frame.gestures;
    this.player.setGuard(g.guard, this.now);
    this.player.setDuck(g.duck, this.now);

    const dodge = this.vision.takeDodge();
    if (dodge && this.player.startDodge(dodge, this.now)) {
      this.stats.dodges += 1;
      this.stats.dodgeDirections[dodge] += 1;
      this.profiler.recordDodge(dodge);
      this.particles.dust(this.player.x, WORLD.floorY, 6);
      audio.play('dodge', { volume: 0.45 });
      this.setAction(dodge === 'left' ? 'DODGE LEFT' : 'DODGE RIGHT');
    }

    if (this.vision.takeRage() && this.rage.tryActivate(this.player, this.now)) {
      this.onRageActivated();
    }
  }

  private handleKeyboard(): void {
    if (!this.settings.keyboardFallback) return;
    const actions = this.keys.drain();
    for (const a of actions) this.applyKeyAction(a);

    const move = this.keys.moveAxis();
    if (move !== 0) this.player.move(move > 0 ? 1 : -1, 16);

    // Held defensive states are the union of both input paths, so a keyboard
    // player gets them without the vision path fighting them back off.
    if (this.keys.guardHeld) this.player.setGuard(true, this.now);
    else if (!this.vision.latest.gestures.guard) this.player.setGuard(false, this.now);

    if (this.keys.duckHeld) this.player.setDuck(true, this.now);
    else if (!this.vision.latest.gestures.duck) this.player.setDuck(false, this.now);
  }

  private applyKeyAction(a: KeyAction): void {
    switch (a) {
      case 'jab':
      case 'cross':
      case 'hookL':
      case 'hookR':
      case 'uppercut': {
        const map = {
          jab: { kind: 'jab', hand: 'left', label: 'LEFT JAB' },
          cross: { kind: 'cross', hand: 'right', label: 'RIGHT CROSS' },
          hookL: { kind: 'hook', hand: 'left', label: 'LEFT HOOK' },
          hookR: { kind: 'hook', hand: 'right', label: 'RIGHT HOOK' },
          uppercut: { kind: 'uppercut', hand: 'right', label: 'RIGHT UPPERCUT' },
        } as const;
        const m = map[a];
        this.throwPunch({
          id: -1,
          hand: m.hand as Side,
          kind: m.kind,
          label: m.label,
          power: 72,
          confidence: 1,
          tier: 'high',
          target: 'head',
          peakSpeed: 0,
          at: this.now,
          source: 'keyboard',
        });
        break;
      }
      case 'dodgeLeft':
      case 'dodgeRight': {
        const dir: Side = a === 'dodgeLeft' ? 'left' : 'right';
        if (this.player.startDodge(dir, this.now)) {
          this.stats.dodges += 1;
          this.stats.dodgeDirections[dir] += 1;
          this.profiler.recordDodge(dir);
          audio.play('dodge', { volume: 0.45 });
          this.setAction(dir === 'left' ? 'DODGE LEFT' : 'DODGE RIGHT');
        }
        break;
      }
      case 'rage':
        if (this.rage.tryActivate(this.player, this.now)) this.onRageActivated();
        break;
      default:
        break;
    }
  }

  private throwPunch(punch: PunchEvent): void {
    const def = attackForPunch(punch.kind, punch.hand, punch.target);
    if (!this.player.startAttack(def, punch.power, this.now)) return;

    this.strikePower = punch.power;
    this.setAction(punch.label);
    this.stats.handCounts[punch.hand] += 1;
    this.stats.kindCounts[punch.kind] += 1;
    this.stats.powerByHand[punch.hand].push(punch.power);
    if (punch.power > this.stats.highestPower) this.stats.highestPower = punch.power;

    this.pendingPunch = punch;
    audio.play(punch.power > 70 ? 'punchHeavy' : 'punchLight', { volume: 0.28 });

    // Tell the AI a punch is on its way so its reaction queue can start.
    this.ai.onPlayerAttackStart({
      kind: punch.kind,
      hand: punch.hand,
      region: def.target,
      impactAtMs: def.startupMs,
    });
  }

  private pendingPunch: PunchEvent | null = null;

  private onRageActivated(): void {
    this.announce({ text: 'RAGE MODE', tone: 'rage' }, 1400);
    this.fx.flash(PALETTE.rage, 0.4, 320);
    this.fx.shake(20);
    this.particles.burst('ember', this.player.x, WORLD.floorY - this.player.height * 0.5, {
      count: 30,
      color: PALETTE.rage,
      power: 1.4,
    });
    audio.play('rageStart');
    audio.crowdReaction(1);
    this.setAction('RAGE MODE');
  }

  // ---------------------------------------------------------------- AI

  private updateAI(dt: number): void {
    const view = this.buildAIView();
    const decision = this.ai.update(dt, view);

    if (decision.dodge && this.enemy.startDodge(decision.dodge, this.now)) {
      this.particles.dust(this.enemy.x, WORLD.floorY, 5);
    }
    this.enemy.setGuard(decision.guard, this.now);
    if (decision.move !== 0) this.enemy.move(decision.move, dt);

    if (decision.attack) {
      const def = ATTACKS[decision.attack];
      if (def && this.enemy.startAttack(def, 55 + Math.random() * 35, this.now)) {
        audio.play('punchLight', { volume: 0.2 });
      }
    }
  }

  private buildAIView(): AIView {
    const p = this.player;
    const e = this.enemy;
    const incoming = p.incomingImpactIn(this.now);
    return {
      now: this.now,
      gap: Math.abs(p.x - e.x),
      selfHp: e.vitals.hp,
      selfHpMax: e.vitals.maxHp,
      selfStamina: e.vitals.stamina,
      selfStaminaMax: e.vitals.maxStamina,
      selfRecovering: e.recovering,
      selfStaggered: e.staggered,
      selfDowned: e.downed,
      selfRage: e.vitals.rageActive,
      opponentHp: p.vitals.hp,
      opponentHpMax: p.vitals.maxHp,
      opponentStamina: p.vitals.stamina,
      opponentStaminaMax: p.vitals.maxStamina,
      opponentGuarding: p.guarding,
      opponentDowned: p.downed,
      opponentRage: p.vitals.rageActive,
      opponentAttacking: incoming !== null,
      incomingImpactInMs: incoming,
      incomingRegion: p.attack?.target ?? null,
      incomingKind: p.attack?.kind ?? null,
      incomingHand: p.attack?.hand ?? null,
      opponentIdleMs: p.idleMs,
      model: this.profiler.model,
      roundProgress: this.rounds.progress,
      roundIndex: this.rounds.index,
      frozen: this.fx.frozen || this.phase !== 'fighting',
    };
  }

  /**
   * Keeps the fighters at a fightable distance without demanding footwork from
   * a player whose controller is a webcam. The AI still drives real approach and
   * retreat; this only stops the pair drifting into an unplayable gap.
   */
  private autoSpacing(dt: number): void {
    const gap = Math.abs(this.player.x - this.enemy.x);
    const dir = Math.sign(this.enemy.x - this.player.x) || 1;

    // Hold the pocket. A player whose controller is their hands cannot also be
    // asked to manage footwork, so the fighter walks himself into punching
    // range and steps in harder while a punch is actually out. The AI's own
    // approach and retreat still shape the spacing; this just stops the
    // opponent from backing out of reach and stalling the fight.
    const pocket = COMBAT.engageRange * 0.86;
    if (gap > pocket) {
      const urgency = this.player.attackPhase !== 'none' ? 1.2 : 0.62;
      this.player.x += dir * COMBAT.walkSpeed * urgency * (dt / 1000);
    } else if (gap < COMBAT.minGap) {
      this.player.x -= dir * COMBAT.walkSpeed * 0.7 * (dt / 1000);
      this.enemy.x += dir * COMBAT.walkSpeed * 0.7 * (dt / 1000);
    }

    this.player.x = clamp(this.player.x, WORLD.minX, WORLD.maxX);
    this.enemy.x = clamp(this.enemy.x, WORLD.minX, WORLD.maxX);

    // Fighters always face each other.
    this.player.facing = this.enemy.x >= this.player.x ? 1 : -1;
    this.enemy.facing = this.player.x > this.enemy.x ? 1 : -1;
  }

  // ---------------------------------------------------------------- combat

  private resolveCombat(_dt: number): void {
    const ctxPlayer = {
      comboMultiplier: this.combo.multiplier,
      damageMultiplier: 1,
      effects: true,
    };
    const ctxEnemy = {
      comboMultiplier: 1,
      damageMultiplier: DIFFICULTIES[this.difficulty].damageMultiplier,
      effects: true,
    };

    const a = this.combat.update(this.player, this.enemy, this.now, ctxPlayer) as CombatReport | null;
    if (a) this.onPlayerResult(a);

    const b = this.combat.update(this.enemy, this.player, this.now, ctxEnemy) as CombatReport | null;
    if (b) this.onEnemyResult(b);

    this.checkKnockdowns();
  }

  private onPlayerResult(r: CombatReport): void {
    const punch = this.pendingPunch;
    this.pendingPunch = null;

    switch (r.result) {
      case 'clean':
      case 'counter': {
        this.stats.landed += 1;
        this.stats.damageDealt += r.damage;
        this.roundDamage.player += r.damage;
        if (r.result === 'counter') this.stats.counters += 1;
        const count = this.combo.land(r.attack.kind);
        if (count >= 2) {
          this.rage.award(this.player, 'comboStep');
          if (count === COMBO_ANNOUNCE || count % 5 === 0) audio.play('comboUp', { rate: 1 + count * 0.03 });
          this.fx.text({
            text: `COMBO x${count}`,
            x: this.player.x,
            y: WORLD.floorY - this.player.height - 40,
            color: PALETTE.player,
            size: 24 + Math.min(20, count * 2),
            life: 700,
            shadow: PALETTE.player,
          });
        }
        if (this.combo.bestCombo > this.stats.bestCombo) this.stats.bestCombo = this.combo.bestCombo;
        if (punch) this.profiler.recordPunch(punch, 'landed');
        this.ai.onSelfHit({ damage: r.damage, region: r.region, staggered: r.stagger });
        break;
      }
      case 'blocked':
        this.stats.blockedByOpponent += 1;
        this.stats.damageDealt += r.damage;
        this.roundDamage.player += r.damage;
        this.combo.graze();
        if (punch) this.profiler.recordPunch(punch, 'blocked');
        this.ai.onSelfHit({ damage: r.damage, region: r.region, staggered: false });
        break;
      case 'dodged':
        this.stats.missed += 1;
        this.combo.graze();
        if (punch) this.profiler.recordPunch(punch, 'dodged');
        break;
      case 'whiff':
      default:
        this.stats.missed += 1;
        this.combo.graze();
        if (punch) this.profiler.recordPunch(punch, 'whiff');
        break;
    }

    this.ai.onPlayerAttackResolved({
      landed: r.result === 'clean' || r.result === 'counter',
      blocked: r.result === 'blocked',
      dodged: r.result === 'dodged',
    });
  }

  private onEnemyResult(r: CombatReport): void {
    switch (r.result) {
      case 'clean':
      case 'counter':
        this.stats.damageTaken += r.damage;
        this.roundDamage.enemy += r.damage;
        this.recordComboEnd();
        this.combo.break();
        this.ai.onSelfLanded({ damage: r.damage, blocked: false });
        break;
      case 'blocked':
        this.stats.blocks += 1;
        this.stats.damageTaken += r.damage;
        this.roundDamage.enemy += r.damage;
        if (r.perfect) {
          this.stats.perfectBlocks += 1;
          this.setAction('PERFECT BLOCK');
        }
        this.ai.onSelfLanded({ damage: r.damage, blocked: true });
        break;
      case 'dodged':
        if (r.perfect) {
          this.stats.perfectDodges += 1;
          this.setAction('PERFECT DODGE');
        }
        break;
      default:
        break;
    }
  }

  private checkKnockdowns(): void {
    if (this.phase !== 'fighting') return;
    for (const f of [this.player, this.enemy]) {
      if (f.action === 'down' && this.downedFighter !== f) {
        this.beginKnockdown(f);
        return;
      }
    }
  }

  private beginKnockdown(f: Fighter): void {
    this.downedFighter = f;
    if (f === this.enemy) {
      this.stats.knockdownsScored += 1;
      this.roundKnockdowns.enemy += 1;
    } else {
      this.stats.knockdownsTaken += 1;
      this.roundKnockdowns.player += 1;
      this.recordComboEnd();
      this.combo.break();
    }
    this.ai.onKnockdown(f === this.enemy ? 'self' : 'opponent');

    // Out of knockdowns, or the bar is empty with no lives left: it is over.
    const finished = f.vitals.knockdowns >= COMBAT.maxKnockdownsPerRound;
    if (finished) {
      this.setPhase('ko');
      this.phaseTimer = 2600;
      this.announce({ text: 'K.O.', tone: f === this.enemy ? 'good' : 'bad' }, 2400);
      audio.play('knockdown');
      audio.crowdReaction(1);
      return;
    }

    this.setPhase('knockdown');
    this.knockdownCount = COMBAT.knockdownCountSeconds;
    this.countdownTicked = -1;
    this.phaseTimer = COMBAT.knockdownCountSeconds * 1000 + COMBAT.getUpMs + 400;
    this.announce({ text: 'DOWN!', tone: f === this.enemy ? 'good' : 'bad' }, 900);
  }

  // ---------------------------------------------------------------- phases

  private setPhase(p: EnginePhase): void {
    if (this.phase === p) return;
    this.phase = p;
    // Carry the callout a beat past the bell — the player is still finding
    // their fighter when the round actually starts.
    if (p === 'fighting') this.tagHoldMs = 1600;
    this.onPhaseChange(p);
  }

  private updateTagEmphasis(realDt: number): void {
    const pinned =
      this.phase === 'intro' ||
      this.phase === 'round_card' ||
      this.phase === 'intermission' ||
      this.phase === 'round_end' ||
      this.phase === 'paused' ||
      this.phase === 'tracking_lost';

    if (pinned) {
      this.tagEmphasis = 1;
      return;
    }
    if (this.tagHoldMs > 0) {
      this.tagHoldMs -= realDt;
      this.tagEmphasis = 1;
      return;
    }
    this.tagEmphasis = Math.max(0, this.tagEmphasis - realDt / 650);
  }

  private announce(a: Announcement, ms: number): void {
    this.announcement = a;
    this.announceTimer = ms;
  }

  private updatePhase(dt: number, realDt: number): void {
    if (this.announceTimer > 0) {
      this.announceTimer -= realDt;
      if (this.announceTimer <= 0) this.announcement = null;
    }

    if (this.phaseTimer > 0) this.phaseTimer -= dt || realDt;

    switch (this.phase) {
      case 'intro':
        if (this.phaseTimer <= 0) this.startRoundCard();
        break;

      case 'round_card':
        if (this.phaseTimer <= 0) {
          this.setPhase('fighting');
          this.announce({ text: 'FIGHT', tone: 'good' }, 900);
          audio.play('roundStart');
          audio.crowdReaction(0.8);
        }
        break;

      case 'knockdown':
        this.updateKnockdown();
        break;

      case 'ko':
        if (this.phaseTimer <= 0) this.finishFight(this.enemy.vitals.hp <= 0 || this.enemy.downed ? 'player' : 'enemy', 'KO');
        break;

      case 'round_end':
        if (this.phaseTimer <= 0) {
          if (this.rounds.isFinalRound) {
            const d = this.rounds.decision();
            this.finishFight(d === 'draw' ? 'draw' : d, 'DECISION');
          } else {
            this.rounds.advance();
            this.setPhase('intermission');
            this.phaseTimer = ROUNDS.intermissionSec * 1000;
            this.announce({ text: 'REST', sub: 'Next round starting' }, 2000);
          }
        }
        break;

      case 'intermission':
        if (this.phaseTimer <= 0) this.startRoundCard();
        break;

      default:
        break;
    }
  }

  private startRoundCard(): void {
    this.player.resetForRound(WORLD.width * 0.5 - COMBAT.neutralGap * 0.5);
    this.enemy.resetForRound(WORLD.width * 0.5 + COMBAT.neutralGap * 0.5);
    this.combo.resetChain();
    this.roundDamage = { player: 0, enemy: 0 };
    this.roundKnockdowns = { player: 0, enemy: 0 };
    this.downedFighter = null;
    this.ai.onRoundStart(this.rounds.index);
    this.setPhase('round_card');
    this.phaseTimer = ROUNDS.roundCardMs;
    this.announce({ text: `ROUND ${this.rounds.index}`, sub: this.rounds.isFinalRound ? 'FINAL ROUND' : undefined }, ROUNDS.roundCardMs);
    audio.play('bell');
  }

  private updateKnockdown(): void {
    const f = this.downedFighter;
    if (!f) {
      this.setPhase('fighting');
      return;
    }

    const remaining = Math.max(0, f.downUntil - this.now);
    const seconds = Math.ceil(remaining / 1000);
    this.knockdownCount = seconds > 0 ? seconds : null;

    if (seconds !== this.countdownTicked && seconds > 0) {
      this.countdownTicked = seconds;
      audio.play('countdown');
    }

    if (remaining <= 0 && f.action === 'down') {
      f.beginGetUp(this.now);
      // A floored fighter comes back hurt but able to continue.
      if (f.vitals.hp <= 0) f.vitals.hp = f.vitals.maxHp * 0.26;
      this.knockdownCount = null;
      this.announce({ text: 'GET UP', tone: 'neutral' }, 900);
      audio.play('getUp');
    }

    if (f.action !== 'down' && f.action !== 'getup') {
      this.downedFighter = null;
      this.knockdownCount = null;
      this.setPhase('fighting');
    }
  }

  private endRound(_reason: 'time'): void {
    if (this.phase !== 'fighting') return;
    this.setPhase('round_end');
    this.phaseTimer = 2800;
    const winner = this.rounds.scoreRound({
      playerDamage: this.roundDamage.player,
      enemyDamage: this.roundDamage.enemy,
      playerKnockdowns: this.roundKnockdowns.player,
      enemyKnockdowns: this.roundKnockdowns.enemy,
    });
    this.recordComboEnd();
    this.combo.break();
    audio.play('roundEnd');
    audio.play('bell');
    this.announce({
      text: `END OF ROUND ${this.rounds.index}`,
      sub: winner === 'draw' ? 'EVEN ROUND' : winner === 'player' ? 'ROUND TO YOU' : `ROUND TO ${this.enemy.name}`,
      tone: winner === 'player' ? 'good' : winner === 'enemy' ? 'bad' : 'neutral',
    }, 2600);
  }

  private finishFight(winner: 'player' | 'enemy' | 'draw', method: 'KO' | 'TKO' | 'DECISION'): void {
    if (this.phase === 'finished') return;
    this.setPhase('finished');
    this.recordComboEnd();

    if (winner === 'player') {
      this.player.declareVictory();
      this.enemy.declareDefeat();
      audio.play('victory');
    } else if (winner === 'enemy') {
      this.enemy.declareVictory();
      this.player.declareDefeat();
      audio.play('defeat');
    }
    audio.stopMusic();
    audio.crowdReaction(1);

    this.stats.fightDurationMs = performance.now() - this.fightStart;
    this.stats.comboLengths = [...this.combo.history];
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo.bestCombo);

    const result: FightResult = {
      outcome: winner === 'player' ? 'victory' : winner === 'enemy' ? 'defeat' : 'draw',
      method,
      enemyId: this.enemyId,
      enemyName: this.enemy.name,
      difficulty: this.difficulty,
      roundsWon: { ...this.rounds.current.roundsWon },
      roundReached: this.rounds.index,
      stats: this.stats,
      iq: this.profiler.toFightIQ(this.stats),
    };

    // Give the KO animation a beat before the results screen takes over.
    window.setTimeout(() => this.onFinished(result), 1500);
  }

  // ---------------------------------------------------------------- misc

  private updateTrackingWatchdog(frame: VisionFrame, realDt: number): void {
    // Keyboard players never get paused for a camera they are not using.
    const usingCamera = frame.tracking.camera;
    if (!usingCamera) {
      this.trackingLostFor = 0;
      if (this.phase === 'tracking_lost') this.setPhase('fighting');
      return;
    }

    if (frame.tracking.quality === 'lost') this.trackingLostFor += realDt;
    else this.trackingLostFor = 0;

    if (this.phase === 'fighting' && this.trackingLostFor > VISION.trackingLostMs) {
      // Freeze the fight rather than letting the AI tee off on a player who
      // has stepped out of frame.
      this.setPhase('tracking_lost');
      this.player.setGuard(false, this.now);
      this.enemy.setGuard(false, this.now);
      this.enemy.cancelAttack();
    } else if (this.phase === 'tracking_lost' && this.trackingLostFor === 0) {
      this.setPhase('fighting');
    }
  }

  private trackBehaviour(dt: number): void {
    if (this.player.guarding) {
      this.stats.timeGuardingMs += dt;
      this.profiler.recordGuard(dt);
    } else if (this.player.attackPhase !== 'none') {
      this.stats.timeAggressiveMs += dt;
      this.profiler.recordActive(dt);
    } else {
      this.profiler.recordIdle(dt);
    }
  }

  private recordComboEnd(): void {
    const c = this.combo.state.count;
    if (c >= 2) this.profiler.recordComboEnd(c);
  }

  private setAction(label: string): void {
    this.lastAction = label;
    this.lastActionAt = this.now;
  }

  private crowdEnergy(): number {
    const hpTension = 1 - Math.min(this.player.hpFraction, this.enemy.hpFraction);
    const action = this.phase === 'fighting' ? 0.4 : 0.15;
    const combo = clamp01(this.combo.state.count / 6) * 0.3;
    return clamp01(action + hpTension * 0.4 + combo);
  }

  private emitHud(): void {
    if (this.lastAction && this.now - this.lastActionAt > 2200) this.lastAction = null;
    const r = this.rounds.current;
    this.onHud({
      playerName: this.player.name,
      enemyName: this.enemy.name,
      playerHp: this.player.vitals.hp,
      playerHpMax: this.player.vitals.maxHp,
      enemyHp: this.enemy.vitals.hp,
      enemyHpMax: this.enemy.vitals.maxHp,
      playerStamina: this.player.vitals.stamina,
      playerStaminaMax: this.player.vitals.maxStamina,
      enemyStamina: this.enemy.vitals.stamina,
      enemyStaminaMax: this.enemy.vitals.maxStamina,
      rage: this.player.vitals.rage,
      rageMax: this.player.vitals.maxRage,
      rageActive: this.player.vitals.rageActive,
      round: r.index,
      roundTotal: r.total,
      timeLeft: r.timeLeft,
      roundsWon: r.roundsWon,
      combo: this.combo.state.count,
      comboWindow: this.combo.state.window,
      lastAction: this.lastAction,
      strikePower: this.strikePower,
      announcement: this.announcement,
      knockdownCount: this.knockdownCount,
    });
  }

  // ---------------------------------------------------------------- render

  private render(t: number): void {
    const ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = this.canvas.clientWidth || WORLD.width;
    const cssH = this.canvas.clientHeight || WORLD.height;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }

    // Letterbox the 1600x900 design space into whatever the window gives us.
    const scale = Math.min(cssW / WORLD.width, cssH / WORLD.height);
    const offX = (cssW - WORLD.width * scale) * 0.5;
    const offY = (cssH - WORLD.height * scale) * 0.5;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, WORLD.width, WORLD.height);
    ctx.clip();

    this.fx.applyCamera(ctx, WORLD.width, WORLD.height);

    arena.drawBackground(ctx, t);

    // Stance rings sit on the mat, so they belong under both fighters.
    drawStanceRings(ctx, this.tagTargets, this.tagEmphasis, t);

    // Painter's order: whoever is further back draws first.
    const back = this.player.x <= this.enemy.x ? this.enemy : this.player;
    const front = back === this.player ? this.enemy : this.player;
    back.draw(ctx, t);
    front.draw(ctx, t);

    this.particles.draw(ctx);
    arena.drawForeground(ctx, t);
    // Above the ropes: a "YOU" tag the top rope cuts through would defeat the
    // whole point of it.
    drawOverheadTags(ctx, this.tagTargets, this.tagEmphasis, t);
    this.fx.drawTexts(ctx);

    ctx.restore();

    this.fx.drawOverlay(ctx, cssW, cssH);
  }
}

const COMBO_ANNOUNCE = 3;
