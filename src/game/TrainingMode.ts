import type { Side } from '@/types/core';
import type { PunchEvent, VisionFrame } from '@/types/vision';
import type { Settings, TrainingResult } from '@/store/appState';
import { COMBAT, PALETTE, WORLD } from '@/config/gameConfig';
import { attackForPunch } from '@/data/attacks';
import { PLAYER_STYLE_ID } from '@/data/fighters';
import { Fighter } from '@/entities/Fighter';
import { audio } from '@/audio/AudioEngine';
import { arena } from '@/render/ArenaRenderer';
import type { VisionController } from '@/vision/VisionController';
import { clamp, clamp01, mean, Rng } from '@/utils/math';
import { ComboSystem } from './ComboSystem';
import { ParticleSystem } from './ParticleSystem';
import { ScreenFx } from './ScreenFx';
import { KeyboardInput, type KeyAction } from './KeyboardInput';

/**
 * The training gym: focus mitts instead of an opponent.
 *
 * Pads pop up and the player has a window to hit the right one with the right
 * hand, which is the cleanest way to measure reaction, accuracy and strike
 * power without a fight getting in the way. Between rounds of pads a telegraphed
 * incoming shot forces a block or a slip, so defence gets scored too.
 */

export interface TrainingHudState {
  timeLeft: number;
  score: number;
  hits: number;
  misses: number;
  accuracy: number;
  combo: number;
  bestCombo: number;
  lastReactionMs: number | null;
  strikePower: number;
  prompt: string | null;
  promptTone: 'neutral' | 'good' | 'bad';
}

export interface TrainingOptions {
  canvas: HTMLCanvasElement;
  vision: VisionController;
  settings: Settings;
  durationSec?: number;
  onHud(state: TrainingHudState): void;
  onFinished(result: TrainingResult): void;
}

type PadHeight = 'upper' | 'center' | 'low';

interface Pad {
  active: boolean;
  hand: Side;
  height: PadHeight;
  x: number;
  y: number;
  /** Horizontal drift for moving targets. */
  vx: number;
  born: number;
  life: number;
  radius: number;
  pulse: number;
  hitAt: number;
}

type Threat = {
  active: boolean;
  telegraphAt: number;
  landsAt: number;
  /** What the player must do. */
  answer: 'guard' | 'dodge' | 'duck';
  resolved: boolean;
};

const PAD_LIFETIME = 1550;
const PAD_GAP_MIN = 520;
const PAD_GAP_MAX = 1000;
/** Below this, a hit was anticipation rather than a genuine reaction. */
const MIN_REACTION_MS = 150;

export class TrainingMode {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly vision: VisionController;
  private settings: Settings;
  private readonly durationSec: number;
  private readonly onHud: (s: TrainingHudState) => void;
  private readonly onFinished: (r: TrainingResult) => void;

  readonly player: Fighter;
  private readonly fx = new ScreenFx();
  private readonly particles = new ParticleSystem();
  private readonly combo = new ComboSystem();
  private readonly keys = new KeyboardInput();
  private readonly rng = new Rng(0x9a37f1);

  private raf = 0;
  private running = false;
  private paused = false;
  private lastFrame = 0;
  private now = 0;
  private timeLeft: number;

  private readonly pads: Pad[] = [];
  private nextPadAt = 0;
  private threat: Threat = { active: false, telegraphAt: 0, landsAt: 0, answer: 'guard', resolved: true };
  private nextThreatAt = 0;

  private hits = 0;
  private misses = 0;
  private score = 0;
  private readonly reactions: number[] = [];
  private readonly powers: number[] = [];
  private readonly perHand: Record<Side, number> = { left: 0, right: 0 };
  private blocks = 0;
  private dodges = 0;
  private defenceChances = 0;
  private defenceWins = 0;
  private lastReaction: number | null = null;
  private strikePower = 0;
  private prompt: string | null = null;
  private promptTone: 'neutral' | 'good' | 'bad' = 'neutral';
  private promptUntil = 0;

  private lastVisionPunchId = 0;
  private hudAccum = 0;

  constructor(opts: TrainingOptions) {
    this.canvas = opts.canvas;
    const ctx = opts.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
    this.vision = opts.vision;
    this.settings = opts.settings;
    this.durationSec = opts.durationSec ?? 60;
    this.timeLeft = this.durationSec;
    this.onHud = opts.onHud;
    this.onFinished = opts.onFinished;

    this.player = new Fighter({
      id: 'player',
      name: 'YOU',
      styleId: PLAYER_STYLE_ID,
      maxHp: 200,
      maxStamina: 110,
      x: WORLD.width * 0.5 - 150,
      facing: 1,
    });

    for (let i = 0; i < 6; i += 1) {
      this.pads.push({
        active: false, hand: 'left', height: 'center',
        x: 0, y: 0, vx: 0, born: 0, life: PAD_LIFETIME, radius: 44, pulse: 0, hitAt: 0,
      });
    }

    this.applySettings();
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.now = this.lastFrame;
    this.nextPadAt = this.now + 1200;
    this.nextThreatAt = this.now + 7000;
    this.keys.attach();
    audio.startCrowd();
    audio.setCrowdEnergy(0.25);
    audio.startMusic('menu');
    this.setPrompt('WARM UP', 'neutral', 1400);
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
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.lastFrame = performance.now();
  }

  get isPaused(): boolean {
    return this.paused;
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

  // ---------------------------------------------------------------- loop

  private tick = (t: number): void => {
    if (!this.running) return;
    const realDt = Math.min(64, t - this.lastFrame);
    this.lastFrame = t;

    const scale = this.fx.update(realDt);
    const dt = realDt * scale;
    this.now += dt;

    if (!this.paused) {
      this.timeLeft = Math.max(0, this.timeLeft - dt / 1000);
      this.step(dt, realDt);
      if (this.timeLeft <= 0) {
        this.finish();
        return;
      }
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
    this.handleInput(frame);
    this.updatePads(dt);
    this.updateThreat();

    this.player.update(dt, this.now);
    this.combo.update(dt);
    this.particles.update(dt);
    arena.update(realDt);

    if (this.promptUntil > 0 && this.now > this.promptUntil) {
      this.prompt = null;
      this.promptUntil = 0;
    }
  }

  // ---------------------------------------------------------------- input

  private handleInput(frame: VisionFrame): void {
    if (frame.tracking.camera) {
      for (const punch of frame.punches) {
        if (punch.id <= this.lastVisionPunchId) continue;
        this.lastVisionPunchId = punch.id;
        this.throwPunch(punch);
      }

      this.player.setGuard(frame.gestures.guard, this.now);
      this.player.setDuck(frame.gestures.duck, this.now);

      const dodge = this.vision.takeDodge();
      if (dodge && this.player.startDodge(dodge, this.now)) {
        this.dodges += 1;
        this.particles.dust(this.player.x, WORLD.floorY, 6);
        audio.play('dodge', { volume: 0.45 });
      }
    }

    if (!this.settings.keyboardFallback) return;
    for (const a of this.keys.drain()) this.applyKey(a);
    if (this.keys.guardHeld) this.player.setGuard(true, this.now);
    else if (!frame.gestures.guard) this.player.setGuard(false, this.now);
  }

  private applyKey(a: KeyAction): void {
    const map: Partial<Record<KeyAction, { kind: PunchEvent['kind']; hand: Side }>> = {
      jab: { kind: 'jab', hand: 'left' },
      cross: { kind: 'cross', hand: 'right' },
      hookL: { kind: 'hook', hand: 'left' },
      hookR: { kind: 'hook', hand: 'right' },
      uppercut: { kind: 'uppercut', hand: 'right' },
    };
    const m = map[a];
    if (m) {
      this.throwPunch({
        id: -1, hand: m.hand, kind: m.kind, label: a.toUpperCase(), power: 72,
        confidence: 1, tier: 'high', target: 'head', peakSpeed: 0, at: this.now, source: 'keyboard',
      });
      return;
    }
    if (a === 'dodgeLeft' || a === 'dodgeRight') {
      const dir: Side = a === 'dodgeLeft' ? 'left' : 'right';
      if (this.player.startDodge(dir, this.now)) {
        this.dodges += 1;
        audio.play('dodge', { volume: 0.45 });
      }
    }
  }

  private throwPunch(punch: PunchEvent): void {
    const def = attackForPunch(punch.kind, punch.hand, punch.target);
    if (!this.player.startAttack(def, punch.power, this.now)) return;
    this.strikePower = punch.power;
    this.powers.push(punch.power);
    audio.play(punch.power > 70 ? 'punchHeavy' : 'punchLight', { volume: 0.3 });

    const pad = this.findPadFor(punch);
    if (pad) {
      this.hitPad(pad, punch);
    } else {
      this.misses += 1;
      this.combo.break();
      this.setPrompt('MISS', 'bad', 500);
      audio.play('targetMiss', { volume: 0.5 });
    }
  }

  /** The nearest live pad this punch could plausibly be aimed at. */
  private findPadFor(punch: PunchEvent): Pad | null {
    let best: Pad | null = null;
    let bestScore = -1;
    for (const pad of this.pads) {
      if (!pad.active) continue;
      if (pad.hand !== punch.hand) continue;
      // Prefer whichever matching pad has been up longest — that is the one
      // the player is most likely reacting to.
      const age = this.now - pad.born;
      if (age > bestScore) {
        bestScore = age;
        best = pad;
      }
    }
    return best;
  }

  private hitPad(pad: Pad, punch: PunchEvent): void {
    const reaction = this.now - pad.born;
    // A punch already in flight when the pad appeared is an anticipation, not a
    // reaction. Counting it would let a spammer post a 20ms "reaction time", so
    // the hit still scores but the sample is discarded.
    if (reaction >= MIN_REACTION_MS) {
      this.reactions.push(reaction);
      this.lastReaction = reaction;
    }
    this.hits += 1;
    this.perHand[punch.hand] += 1;

    const count = this.combo.land(punch.kind);
    const speedBonus = clamp01(1 - reaction / PAD_LIFETIME);
    const gained = Math.round(60 + punch.power * 1.4 + speedBonus * 90 + count * 12);
    this.score += gained;

    pad.active = false;
    pad.hitAt = this.now;

    this.particles.hitBurst(pad.x, pad.y, PALETTE.player, clamp01(punch.power / 100), this.player.facing);
    this.particles.impactRing(pad.x, pad.y, PALETTE.player, clamp01(punch.power / 100));
    this.fx.shake(6 + punch.power * 0.1);
    this.fx.hitStop(34);
    this.fx.text({
      text: `+${gained}`,
      x: pad.x,
      y: pad.y - 34,
      color: PALETTE.player,
      size: 24,
      life: 700,
      shadow: PALETTE.player,
    });
    if (count >= 3) {
      this.fx.text({
        text: `COMBO x${count}`,
        x: pad.x,
        y: pad.y - 74,
        color: PALETTE.crit,
        size: 22 + Math.min(16, count),
        life: 700,
      });
    }
    audio.play('targetHit', { rate: 0.95 + speedBonus * 0.3 });
    this.setPrompt(reaction < 420 ? 'SHARP' : 'HIT', 'good', 420);
  }

  // ---------------------------------------------------------------- pads

  private updatePads(dt: number): void {
    for (const pad of this.pads) {
      if (!pad.active) continue;
      pad.pulse += dt;
      pad.x += pad.vx * (dt / 1000);
      if (pad.x < WORLD.minX + 60 || pad.x > WORLD.maxX + 120) pad.vx *= -1;
      if (this.now - pad.born > pad.life) {
        pad.active = false;
        this.misses += 1;
        this.combo.break();
        this.setPrompt('TOO SLOW', 'bad', 500);
        audio.play('targetMiss', { volume: 0.4 });
      }
    }

    if (this.now >= this.nextPadAt && !this.threat.active) {
      this.spawnPad();
      // Pads come faster as the session goes on, so the drill actually ramps.
      const progress = 1 - this.timeLeft / this.durationSec;
      const gap = this.rng.range(PAD_GAP_MIN, PAD_GAP_MAX) * (1 - progress * 0.42);
      this.nextPadAt = this.now + Math.max(300, gap);
    }
  }

  private spawnPad(): void {
    const pad = this.pads.find((p) => !p.active);
    if (!pad) return;

    const hand: Side = this.rng.chance(0.5) ? 'left' : 'right';
    const heights: PadHeight[] = ['upper', 'center', 'center', 'low'];
    const height = this.rng.pick(heights);
    const moving = this.rng.chance(0.22);

    const baseX = this.player.x + 250 + this.rng.range(-40, 130);
    const lane = hand === 'left' ? -46 : 46;
    const yByHeight = { upper: 0.44, center: 0.56, low: 0.68 } as const;

    pad.active = true;
    pad.hand = hand;
    pad.height = height;
    pad.x = clamp(baseX + lane, WORLD.minX + 80, WORLD.maxX + 140);
    pad.y = WORLD.floorY - WORLD.fighterHeight * yByHeight[height] * 1.55;
    pad.vx = moving ? this.rng.range(-90, 90) : 0;
    pad.born = this.now;
    pad.life = PAD_LIFETIME;
    pad.radius = 44;
    pad.pulse = 0;
    audio.play('menuMove', { volume: 0.25, rate: hand === 'left' ? 1.1 : 0.9 });
  }

  // ---------------------------------------------------------------- defence drill

  private updateThreat(): void {
    if (!this.threat.active) {
      if (this.now >= this.nextThreatAt) {
        const answers: Threat['answer'][] = ['guard', 'dodge', 'duck'];
        this.threat = {
          active: true,
          telegraphAt: this.now,
          landsAt: this.now + 1150,
          answer: this.rng.pick(answers),
          resolved: false,
        };
        this.defenceChances += 1;
        const label = this.threat.answer === 'guard' ? 'GUARD!' : this.threat.answer === 'duck' ? 'DUCK!' : 'SLIP!';
        this.setPrompt(label, 'neutral', 1100);
        audio.play('staminaLow', { volume: 0.5 });
      }
      return;
    }

    if (this.now < this.threat.landsAt) return;

    // Resolve: did the player produce the requested defence in time?
    const ok =
      (this.threat.answer === 'guard' && this.player.guarding) ||
      (this.threat.answer === 'duck' && this.player.ducking) ||
      (this.threat.answer === 'dodge' && this.player.dodgeDir !== null);

    if (ok) {
      this.defenceWins += 1;
      if (this.threat.answer === 'guard') this.blocks += 1;
      this.score += 120;
      this.fx.text({
        text: 'DEFENDED',
        x: this.player.x,
        y: WORLD.floorY - this.player.height - 30,
        color: PALETTE.good,
        size: 28,
        life: 800,
        shadow: PALETTE.good,
      });
      this.particles.blockBurst(this.player.x + 60, WORLD.floorY - this.player.height * 0.62, 1);
      audio.play('perfectBlock', { volume: 0.7 });
      this.setPrompt('DEFENDED', 'good', 700);
    } else {
      this.player.react('head', false, 14, this.now);
      this.fx.shake(14);
      this.particles.hitBurst(this.player.x + 40, WORLD.floorY - this.player.height * 0.72, PALETTE.enemy, 0.6, -1);
      audio.play('hitHead', { volume: 0.6 });
      // Deliberately not "HIT": that word is already the reward for landing
      // one (see the scoring path), and the two render through the same node
      // at the same size — only the tint differs, which is too slow to read
      // mid-drill and is stripped entirely in the camera panel's readout.
      this.setPrompt('TAGGED', 'bad', 700);
      this.combo.break();
    }

    this.threat.active = false;
    this.threat.resolved = true;
    this.nextThreatAt = this.now + this.rng.range(7000, 12000);
    this.nextPadAt = Math.max(this.nextPadAt, this.now + 700);
  }

  private setPrompt(text: string, tone: 'neutral' | 'good' | 'bad', ms: number): void {
    this.prompt = text;
    this.promptTone = tone;
    this.promptUntil = this.now + ms;
  }

  // ---------------------------------------------------------------- finish

  private finish(): void {
    this.stop();
    const total = this.hits + this.misses;
    const accuracy = total > 0 ? (this.hits / total) * 100 : 0;
    const defence = this.defenceChances > 0 ? (this.defenceWins / this.defenceChances) * 100 : 0;
    const avgPower = this.powers.length ? mean(this.powers) : 0;

    const result: TrainingResult = {
      score: this.score,
      targetsHit: this.hits,
      targetsMissed: this.misses,
      accuracy,
      avgReactionMs: this.reactions.length ? mean(this.reactions) : 0,
      bestReactionMs: this.reactions.length ? Math.min(...this.reactions) : 0,
      avgPower,
      bestPower: this.powers.length ? Math.max(...this.powers) : 0,
      bestCombo: this.combo.bestCombo,
      blocks: this.blocks,
      dodges: this.dodges,
      defense: defence,
      punchSpeed: avgPower,
      durationSec: this.durationSec,
      perHand: { ...this.perHand },
    };

    audio.play('victory');
    audio.stopMusic();
    this.onFinished(result);
  }

  private emitHud(): void {
    const total = this.hits + this.misses;
    this.onHud({
      timeLeft: this.timeLeft,
      score: this.score,
      hits: this.hits,
      misses: this.misses,
      accuracy: total > 0 ? (this.hits / total) * 100 : 0,
      combo: this.combo.state.count,
      bestCombo: this.combo.bestCombo,
      lastReactionMs: this.lastReaction,
      strikePower: this.strikePower,
      prompt: this.prompt,
      promptTone: this.promptTone,
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
    this.player.draw(ctx, t);
    this.drawPads(ctx);
    this.drawThreat(ctx);
    this.particles.draw(ctx);
    arena.drawForeground(ctx, t);
    this.fx.drawTexts(ctx);
    ctx.restore();

    this.fx.drawOverlay(ctx, cssW, cssH);
  }

  private drawPads(ctx: CanvasRenderingContext2D): void {
    for (const pad of this.pads) {
      if (!pad.active) continue;
      const age = (this.now - pad.born) / pad.life;
      const urgency = clamp01(age);
      const colour = pad.hand === 'left' ? PALETTE.player : PALETTE.warn;
      const pop = age < 0.12 ? 0.6 + (age / 0.12) * 0.4 : 1;
      const r = pad.radius * pop;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Countdown ring: shrinks as the window closes, so urgency is readable.
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, r * (1.5 - urgency * 0.42), 0, Math.PI * 2);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.28 * (1 - urgency * 0.5);
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, r, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(pad.x, pad.y, r * 0.1, pad.x, pad.y, r);
      g.addColorStop(0, colour);
      g.addColorStop(0.55, `${colour}55`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fill();

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, r * 0.72, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = colour;
      ctx.stroke();

      ctx.fillStyle = '#05060c';
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, r * 0.56, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = colour;
      ctx.font = '700 30px "Barlow Condensed", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pad.hand === 'left' ? 'L' : 'R', pad.x, pad.y + 1);
      ctx.restore();
    }
  }

  private drawThreat(ctx: CanvasRenderingContext2D): void {
    if (!this.threat.active) return;
    const t = clamp01((this.now - this.threat.telegraphAt) / (this.threat.landsAt - this.threat.telegraphAt));
    const x = this.player.x;
    const y = WORLD.floorY - this.player.height * 0.78;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + t * 0.5;
    ctx.strokeStyle = PALETTE.enemy;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(x, y, 150 * (1 - t) + 50, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = PALETTE.enemy;
    ctx.font = '700 30px "Barlow Condensed", Impact, sans-serif';
    ctx.textAlign = 'center';
    const label = this.threat.answer === 'guard' ? 'GUARD' : this.threat.answer === 'duck' ? 'DUCK' : 'SLIP';
    ctx.fillText(label, x, y - 170);
    ctx.restore();
  }
}

export const TRAINING_DEFAULT_SECONDS = 60;
export { COMBAT as TRAINING_COMBAT_REF };
