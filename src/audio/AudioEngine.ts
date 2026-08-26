/**
 * Procedural audio for HANDSTRIKE.
 *
 * Every sound is synthesised at runtime from oscillators and shaped noise —
 * there are no audio files to ship, license or wait on, and the whole engine is
 * a few kilobytes of maths. Punches, bells, crowd and music all come out of the
 * same small set of primitives.
 *
 * The engine is deliberately paranoid. Autoplay policies, a tab in the
 * background, a browser without StereoPanner or an AudioContext that refuses to
 * start must never be able to throw into the game loop, so every public method
 * degrades to a silent no-op rather than surfacing an error.
 */

import { clamp, clamp01 } from '@/utils/math';

export type SfxName =
  | 'punchLight'
  | 'punchHeavy'
  | 'punchWhiff'
  | 'hitHead'
  | 'hitBody'
  | 'block'
  | 'perfectBlock'
  | 'dodge'
  | 'counter'
  | 'critical'
  | 'knockdown'
  | 'getUp'
  | 'bell'
  | 'roundStart'
  | 'roundEnd'
  | 'countdown'
  | 'victory'
  | 'defeat'
  | 'rageStart'
  | 'rageEnd'
  | 'menuMove'
  | 'menuSelect'
  | 'menuBack'
  | 'error'
  | 'targetHit'
  | 'targetMiss'
  | 'comboUp'
  | 'staminaLow';

type MusicKind = 'menu' | 'fight' | 'results';

interface PlayOpts {
  volume?: number;
  rate?: number;
  pan?: number;
}

interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  q?: number;
  sweepTo?: number;
}

interface ToneOpts {
  type: OscillatorType;
  f0: number;
  /** Target frequency at the end of the envelope — this is the pitch drop. */
  f1?: number;
  detune?: number;
  attack: number;
  decay: number;
  peak: number;
  filter?: FilterSpec;
  /** Bill this voice to the music bank so the sfx voice cap ignores it. */
  music?: boolean;
}

interface NoiseOpts {
  type: BiquadFilterType;
  freq: number;
  q: number;
  sweepTo?: number;
  attack: number;
  decay: number;
  peak: number;
  music?: boolean;
}

/** Past this many scheduled sfx sources new hits are dropped, not queued. */
const MAX_VOICES = 24;
/** How far ahead the music scheduler writes events, in seconds. */
const LOOKAHEAD_S = 0.22;
const SCHEDULER_MS = 25;
/** exponentialRamp cannot reach zero, so silence is this instead. */
const MIN_GAIN = 0.0001;

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);
const hz = (v: number): number => clamp(Number.isFinite(v) ? v : 440, 20, 18000);

/** Percussive AD envelope. Exponential both ways — linear ramps sound synthetic. */
const env = (g: GainNode, t: number, attack: number, decay: number, peak: number): void => {
  g.gain.setValueAtTime(MIN_GAIN, t);
  g.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + attack + decay);
};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

const audioContextCtor = (): AudioContextCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
};

/** Dark, driving, low-register. Roots move only on bars 3 and 4. */
const FIGHT_ROOTS = [0, 0, 5, 3];
const FIGHT_RIFF = [0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 5, 0, 3, 2];
/** Slow minor pad progression, one chord per scheduler step. */
const MENU_CHORDS: number[][] = [
  [33, 57, 60, 64, 69],
  [31, 55, 58, 62, 67],
  [29, 53, 57, 60, 65],
  [31, 55, 59, 62, 67],
];
/** Eight plucked steps then eight of rest, so results screens breathe. */
const RESULTS_CADENCE: (number[] | null)[] = [
  [45, 57, 64, 69], null, [43, 55, 62, 67], null,
  [41, 53, 60, 65], null, [40, 52, 59, 67], null,
  [45, 57, 64, 72], null, null, null,
  null, null, null, null,
];

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private noiseBuf: AudioBuffer | null = null;
  private crowdBuf: AudioBuffer | null = null;

  private soundEnabled = true;
  private musicEnabled = true;
  private masterVolume = 0.75;

  /** Scheduled-or-playing sfx sources. Music and crowd are counted separately. */
  private voices = 0;

  private crowdWanted = false;
  private crowdEnergy = 0.3;
  private crowdSrc: AudioBufferSourceNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdGain: GainNode | null = null;

  /** What the game asked for, kept so it can start once a gesture unlocks us. */
  private desiredMusic: MusicKind | null = null;
  private musicKind: MusicKind | null = null;
  private musicFade: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextStepTime = 0;
  private stepDur = 0.5;
  private readonly musicNodes = new Set<AudioScheduledSourceNode>();

  /** Combo blips climb while the chain lives, then reset. */
  private comboTier = 0;
  private comboAt = -99;

  private readonly timers = new Set<number>();
  private disposed = false;

  /** Deliberately inert: no AudioContext exists until a gesture calls unlock(). */
  constructor() {}

  // ---------------------------------------------------------------- lifecycle

  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.ctx) this.build();
      const ctx = this.ctx;
      if (!ctx) return;
      if (ctx.state !== 'running') await ctx.resume();
      // Replay whatever the game asked for before it had permission to sound.
      if (this.crowdWanted) this.startCrowd();
      if (this.desiredMusic) this.startMusic(this.desiredMusic);
    } catch {
      /* the game stays perfectly playable in silence */
    }
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopMusic();
    this.stopCrowd();
    this.disposed = true;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.noiseBuf = null;
    this.crowdBuf = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private build(): void {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = this.masterVolume;
      master.connect(ctx.destination);

      const sfx = ctx.createGain();
      sfx.gain.value = this.soundEnabled ? 1 : 0;
      sfx.connect(master);

      const music = ctx.createGain();
      music.gain.value = this.musicEnabled ? 1 : 0;
      music.connect(master);

      this.ctx = ctx;
      this.master = master;
      this.sfxBus = sfx;
      this.musicBus = music;
    } catch {
      this.ctx = null;
    }
  }

  // ------------------------------------------------------------------- mixing

  setSoundEnabled(v: boolean): void {
    this.soundEnabled = v;
    this.rampBus(this.sfxBus, v ? 1 : 0);
  }

  setMusicEnabled(v: boolean): void {
    if (this.musicEnabled === v) return;
    this.musicEnabled = v;
    this.rampBus(this.musicBus, v ? 1 : 0);
    // Kill the scheduler outright when muted — no point burning CPU on it.
    if (!v) this.teardownMusic();
    else if (this.desiredMusic) this.startMusic(this.desiredMusic);
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(Number.isFinite(v) ? v : 0.75);
    this.rampBus(this.master, this.masterVolume);
  }

  private rampBus(node: GainNode | null, target: number): void {
    const ctx = this.ctx;
    if (!ctx || !node) return;
    try {
      const t = ctx.currentTime;
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(target, t, 0.025);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------- sfx

  play(name: SfxName, opts?: { volume?: number; rate?: number; pan?: number }): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx || !this.sfxBus || !this.soundEnabled) return;
    if (ctx.state !== 'running') return;
    if (this.voices >= MAX_VOICES) return;
    try {
      const o: PlayOpts = opts ?? {};
      const vol = clamp(Number.isFinite(o.volume ?? 1) ? (o.volume ?? 1) : 1, 0, 3);
      const rate = clamp(Number.isFinite(o.rate ?? 1) ? (o.rate ?? 1) : 1, 0.4, 2.5);
      const pan = clamp(Number.isFinite(o.pan ?? 0) ? (o.pan ?? 0) : 0, -1, 1);
      if (vol <= 0) return;
      const out = this.voiceBus(ctx, this.sfxBus, vol, pan);
      this.render(name, ctx, out, ctx.currentTime + 0.002, rate);
    } catch {
      /* a synth failure must never reach the game loop */
    }
  }

  /** Per-play gain (+ optional pan) that every voice of one sound feeds into. */
  private voiceBus(ctx: AudioContext, dest: AudioNode, vol: number, pan: number): GainNode {
    const g = ctx.createGain();
    g.gain.value = vol;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(dest);
    } else {
      g.connect(dest);
    }
    return g;
  }

  private render(name: SfxName, ctx: AudioContext, out: GainNode, t: number, r: number): void {
    switch (name) {
      case 'punchLight':
        this.punch(ctx, out, t, r, 0.15);
        break;
      case 'punchHeavy':
        this.punch(ctx, out, t, r, 1);
        break;
      case 'punchWhiff':
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 520 * r, q: 1.7, sweepTo: 2600 * r, attack: 0.05, decay: 0.13, peak: 0.17 });
        this.noiseHit(ctx, out, t + 0.02, { type: 'highpass', freq: 1300 * r, q: 0.7, attack: 0.06, decay: 0.15, peak: 0.06 });
        break;
      case 'hitHead':
        // Bright slap over a short mid thump, plus a top-end crack for the snap.
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 2400 * r, q: 1.1, sweepTo: 900 * r, attack: 0.002, decay: 0.09, peak: 0.4 });
        this.tone(ctx, out, t, { type: 'sine', f0: 230 * r, f1: 70 * r, attack: 0.002, decay: 0.13, peak: 0.3 });
        this.noiseHit(ctx, out, t, { type: 'highpass', freq: 5200 * r, q: 0.6, attack: 0.001, decay: 0.035, peak: 0.16 });
        break;
      case 'hitBody':
        this.noiseHit(ctx, out, t, { type: 'lowpass', freq: 640 * r, q: 0.8, sweepTo: 200 * r, attack: 0.004, decay: 0.17, peak: 0.44 });
        this.tone(ctx, out, t, { type: 'sine', f0: 120 * r, f1: 42 * r, attack: 0.004, decay: 0.25, peak: 0.44 });
        break;
      case 'block':
        this.blockHit(ctx, out, t, r);
        break;
      case 'perfectBlock':
        this.blockHit(ctx, out, t, r);
        // Bright bell partials on top — the "you nailed the timing" signal.
        this.tone(ctx, out, t + 0.01, { type: 'sine', f0: 1190 * r, attack: 0.004, decay: 0.7, peak: 0.1 });
        this.tone(ctx, out, t + 0.01, { type: 'sine', f0: 2380 * r, attack: 0.003, decay: 0.46, peak: 0.09 });
        this.tone(ctx, out, t + 0.01, { type: 'sine', f0: 3570 * r, attack: 0.003, decay: 0.3, peak: 0.05 });
        break;
      case 'dodge':
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 340 * r, q: 2.2, sweepTo: 1900 * r, attack: 0.06, decay: 0.17, peak: 0.2 });
        this.tone(ctx, out, t, { type: 'sine', f0: 180 * r, f1: 430 * r, attack: 0.05, decay: 0.17, peak: 0.07 });
        break;
      case 'counter':
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 1500 * r, q: 1.2, attack: 0.002, decay: 0.07, peak: 0.24 });
        this.tone(ctx, out, t, { type: 'sawtooth', f0: 220 * r, f1: 660 * r, attack: 0.01, decay: 0.2, peak: 0.14, filter: { type: 'lowpass', freq: 2200, q: 1.2 } });
        this.tone(ctx, out, t + 0.06, { type: 'sine', f0: 990 * r, f1: 1480 * r, attack: 0.005, decay: 0.26, peak: 0.13 });
        break;
      case 'critical':
        this.tone(ctx, out, t, { type: 'sine', f0: 150 * r, f1: 44 * r, attack: 0.002, decay: 0.3, peak: 0.44 });
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 3200 * r, q: 0.9, sweepTo: 800 * r, attack: 0.002, decay: 0.15, peak: 0.34 });
        this.tone(ctx, out, t, { type: 'square', f0: 1240 * r, attack: 0.002, decay: 0.3, peak: 0.07, filter: { type: 'bandpass', freq: 2400, q: 2.4 } });
        this.tone(ctx, out, t + 0.02, { type: 'sine', f0: 1860 * r, attack: 0.003, decay: 0.44, peak: 0.09 });
        break;
      case 'knockdown':
        this.tone(ctx, out, t, { type: 'sine', f0: 110 * r, f1: 32 * r, attack: 0.006, decay: 0.78, peak: 0.52 });
        this.noiseHit(ctx, out, t, { type: 'lowpass', freq: 900 * r, q: 0.6, sweepTo: 120 * r, attack: 0.01, decay: 0.7, peak: 0.4 });
        // Second, softer thud: the canvas answering back.
        this.tone(ctx, out, t + 0.1, { type: 'triangle', f0: 70 * r, f1: 28 * r, attack: 0.01, decay: 0.5, peak: 0.28 });
        break;
      case 'getUp':
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 300 * r, q: 1.4, sweepTo: 1500 * r, attack: 0.24, decay: 0.3, peak: 0.14 });
        this.tone(ctx, out, t, { type: 'sawtooth', f0: 110 * r, f1: 330 * r, attack: 0.22, decay: 0.3, peak: 0.1, filter: { type: 'lowpass', freq: 1400, q: 0.9 } });
        break;
      case 'bell':
        this.bellStrike(ctx, out, t, r, 1);
        break;
      case 'roundStart':
        this.bellStrike(ctx, out, t, r, 1);
        this.bellStrike(ctx, out, t + 0.52, r, 0.95);
        this.bellStrike(ctx, out, t + 1.04, r, 0.9);
        break;
      case 'roundEnd':
        this.bellStrike(ctx, out, t, r, 1);
        this.bellStrike(ctx, out, t + 0.5, r, 0.85);
        break;
      case 'countdown':
        this.tone(ctx, out, t, { type: 'sine', f0: 760 * r, attack: 0.004, decay: 0.15, peak: 0.24 });
        this.tone(ctx, out, t, { type: 'sine', f0: 1520 * r, attack: 0.003, decay: 0.06, peak: 0.06 });
        break;
      case 'victory':
        this.arpeggio(ctx, out, t, r, [60, 64, 67, 72, 76], 0.11, 'triangle', 0.42, 1.15);
        break;
      case 'defeat':
        this.arpeggio(ctx, out, t, r, [60, 56, 53, 48, 44], 0.17, 'sawtooth', 0.5, 1.5);
        break;
      case 'rageStart':
        this.tone(ctx, out, t, { type: 'sawtooth', f0: 55 * r, f1: 220 * r, attack: 0.3, decay: 0.5, peak: 0.22, filter: { type: 'lowpass', freq: 320, q: 5, sweepTo: 2200 } });
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 200 * r, q: 1.1, sweepTo: 3000 * r, attack: 0.44, decay: 0.32, peak: 0.2 });
        this.tone(ctx, out, t + 0.42, { type: 'square', f0: 110 * r, f1: 82 * r, attack: 0.01, decay: 0.75, peak: 0.13, filter: { type: 'lowpass', freq: 620, q: 2 } });
        break;
      case 'rageEnd':
        this.tone(ctx, out, t, { type: 'sawtooth', f0: 220 * r, f1: 55 * r, attack: 0.02, decay: 0.6, peak: 0.16, filter: { type: 'lowpass', freq: 1600, q: 2, sweepTo: 260 } });
        this.noiseHit(ctx, out, t, { type: 'bandpass', freq: 2200 * r, q: 1, sweepTo: 260 * r, attack: 0.02, decay: 0.5, peak: 0.11 });
        break;
      case 'menuMove':
        this.tone(ctx, out, t, { type: 'square', f0: 520 * r, attack: 0.002, decay: 0.05, peak: 0.09, filter: { type: 'lowpass', freq: 2400, q: 0.8 } });
        break;
      case 'menuSelect':
        this.tone(ctx, out, t, { type: 'triangle', f0: 660 * r, attack: 0.003, decay: 0.09, peak: 0.16 });
        this.tone(ctx, out, t + 0.055, { type: 'triangle', f0: 990 * r, attack: 0.003, decay: 0.17, peak: 0.14 });
        this.tone(ctx, out, t + 0.055, { type: 'sine', f0: 1980 * r, attack: 0.003, decay: 0.1, peak: 0.05 });
        break;
      case 'menuBack':
        this.tone(ctx, out, t, { type: 'triangle', f0: 560 * r, attack: 0.003, decay: 0.08, peak: 0.14 });
        this.tone(ctx, out, t + 0.05, { type: 'triangle', f0: 392 * r, attack: 0.003, decay: 0.17, peak: 0.12 });
        break;
      case 'error':
        this.tone(ctx, out, t, { type: 'square', f0: 150 * r, attack: 0.004, decay: 0.1, peak: 0.13, filter: { type: 'lowpass', freq: 900, q: 1 } });
        this.tone(ctx, out, t + 0.13, { type: 'square', f0: 138 * r, attack: 0.004, decay: 0.14, peak: 0.12, filter: { type: 'lowpass', freq: 800, q: 1 } });
        break;
      case 'targetHit':
        this.tone(ctx, out, t, { type: 'sine', f0: 1180 * r, f1: 1560 * r, attack: 0.002, decay: 0.16, peak: 0.2 });
        this.noiseHit(ctx, out, t, { type: 'highpass', freq: 4200 * r, q: 0.7, attack: 0.001, decay: 0.05, peak: 0.15 });
        this.tone(ctx, out, t, { type: 'sine', f0: 300 * r, f1: 150 * r, attack: 0.002, decay: 0.09, peak: 0.13 });
        break;
      case 'targetMiss':
        this.tone(ctx, out, t, { type: 'triangle', f0: 200 * r, f1: 120 * r, attack: 0.004, decay: 0.17, peak: 0.14, filter: { type: 'lowpass', freq: 700, q: 1 } });
        this.noiseHit(ctx, out, t, { type: 'lowpass', freq: 400 * r, q: 0.7, attack: 0.004, decay: 0.1, peak: 0.09 });
        break;
      case 'comboUp':
        this.comboBlip(ctx, out, t, r);
        break;
      case 'staminaLow':
        this.tone(ctx, out, t, { type: 'sine', f0: 196 * r, attack: 0.01, decay: 0.17, peak: 0.13 });
        this.tone(ctx, out, t + 0.19, { type: 'sine', f0: 185 * r, attack: 0.01, decay: 0.23, peak: 0.11 });
        break;
    }
  }

  /** weight 0 = flick jab, 1 = full-body hook. Heavier means lower and longer. */
  private punch(ctx: AudioContext, out: GainNode, t: number, r: number, weight: number): void {
    const w = clamp01(weight);
    this.noiseHit(ctx, out, t, {
      type: 'bandpass',
      freq: (1750 - 900 * w) * r,
      q: 0.9,
      sweepTo: (430 - 190 * w) * r,
      attack: 0.004,
      decay: 0.06 + 0.09 * w,
      peak: 0.3 + 0.2 * w,
    });
    this.tone(ctx, out, t, {
      type: 'sine',
      f0: (190 - 70 * w) * r,
      f1: (46 - 14 * w) * r,
      attack: 0.003,
      decay: 0.1 + 0.16 * w,
      peak: 0.32 + 0.3 * w,
    });
    // Sub layer only on the heavy end, otherwise jabs turn into mud.
    if (w > 0.5) {
      this.tone(ctx, out, t, { type: 'triangle', f0: 120 * r, f1: 36 * r, attack: 0.005, decay: 0.24, peak: 0.2 * w });
    }
  }

  private blockHit(ctx: AudioContext, out: GainNode, t: number, r: number): void {
    this.noiseHit(ctx, out, t, { type: 'highpass', freq: 2600 * r, q: 0.7, attack: 0.001, decay: 0.03, peak: 0.28 });
    // Inharmonic partials read as leather over a knuckle guard, not as a pitch.
    this.tone(ctx, out, t, { type: 'triangle', f0: 640 * r, attack: 0.002, decay: 0.18, peak: 0.11 });
    this.tone(ctx, out, t, { type: 'triangle', f0: 958 * r, attack: 0.002, decay: 0.13, peak: 0.07 });
    this.tone(ctx, out, t, { type: 'sine', f0: 150 * r, f1: 90 * r, attack: 0.003, decay: 0.1, peak: 0.16 });
  }

  /** Struck bell: two near-unison partials beat against each other as they decay. */
  private bellStrike(ctx: AudioContext, out: GainNode, t: number, r: number, amp: number): void {
    const f = 690 * r;
    this.tone(ctx, out, t, { type: 'sine', f0: f, attack: 0.003, decay: 2.1, peak: 0.28 * amp });
    this.tone(ctx, out, t, { type: 'sine', f0: f * 1.006, attack: 0.004, decay: 1.9, peak: 0.2 * amp });
    this.tone(ctx, out, t, { type: 'sine', f0: f * 2.76, attack: 0.002, decay: 0.85, peak: 0.12 * amp });
    this.tone(ctx, out, t, { type: 'sine', f0: f * 5.4, attack: 0.002, decay: 0.38, peak: 0.05 * amp });
    this.noiseHit(ctx, out, t, { type: 'bandpass', freq: f * 4, q: 1.2, attack: 0.001, decay: 0.05, peak: 0.11 * amp });
  }

  private arpeggio(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    r: number,
    notes: number[],
    gap: number,
    type: OscillatorType,
    decay: number,
    lastDecay: number,
  ): void {
    for (let i = 0; i < notes.length; i += 1) {
      const last = i === notes.length - 1;
      const at = t + i * gap;
      const d = last ? lastDecay : decay;
      this.tone(ctx, out, at, {
        type,
        f0: midi(notes[i]) * r,
        attack: 0.008,
        decay: d,
        peak: 0.17,
        filter: { type: 'lowpass', freq: 2600, q: 0.9 },
      });
      this.tone(ctx, out, at, { type: 'sine', f0: midi(notes[i] + 12) * r, attack: 0.008, decay: d * 0.6, peak: 0.06 });
    }
  }

  /** Climbs a semitone per link so a long chain audibly builds. */
  private comboBlip(ctx: AudioContext, out: GainNode, t: number, r: number): void {
    const now = ctx.currentTime;
    this.comboTier = now - this.comboAt > 2 ? 0 : Math.min(12, this.comboTier + 1);
    this.comboAt = now;
    const n = 67 + this.comboTier;
    this.tone(ctx, out, t, { type: 'triangle', f0: midi(n) * r, attack: 0.003, decay: 0.13, peak: 0.16 });
    this.tone(ctx, out, t + 0.05, { type: 'sine', f0: midi(n + 7) * r, attack: 0.003, decay: 0.2, peak: 0.1 });
  }

  // -------------------------------------------------------------- primitives

  private tone(ctx: AudioContext, dest: AudioNode, t: number, o: ToneOpts): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    const attack = Math.max(0.001, o.attack);
    const decay = Math.max(0.01, o.decay);
    const end = t + attack + decay;

    osc.frequency.setValueAtTime(hz(o.f0), t);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(hz(o.f1), end);
    if (o.detune !== undefined) osc.detune.setValueAtTime(o.detune, t);

    const g = ctx.createGain();
    env(g, t, attack, decay, o.peak);
    osc.connect(g);

    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter.type;
      f.frequency.setValueAtTime(hz(o.filter.freq), t);
      if (o.filter.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(hz(o.filter.sweepTo), end);
      if (o.filter.q !== undefined) f.Q.setValueAtTime(o.filter.q, t);
      g.connect(f);
      f.connect(dest);
    } else {
      g.connect(dest);
    }

    osc.start(t);
    this.track(osc, end + 0.03, o.music === true);
  }

  private noiseHit(ctx: AudioContext, dest: AudioNode, t: number, o: NoiseOpts): void {
    const buf = this.ensureNoise(ctx);
    if (!buf) return;
    const attack = Math.max(0.001, o.attack);
    const decay = Math.max(0.01, o.decay);
    const end = t + attack + decay;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.frequency.setValueAtTime(hz(o.freq), t);
    if (o.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(hz(o.sweepTo), end);
    f.Q.setValueAtTime(o.q, t);

    const g = ctx.createGain();
    env(g, t, attack, decay, o.peak);

    src.connect(f);
    f.connect(g);
    g.connect(dest);

    // Random read offset — otherwise a fast combo replays the identical texture.
    src.start(t, Math.random() * Math.max(0.01, buf.duration - 0.05));
    this.track(src, end + 0.03, o.music === true);
  }

  private track(node: AudioScheduledSourceNode, stopAt: number, music: boolean): void {
    if (music) {
      this.musicNodes.add(node);
      node.onended = () => {
        this.musicNodes.delete(node);
      };
    } else {
      this.voices += 1;
      node.onended = () => {
        this.voices = Math.max(0, this.voices - 1);
      };
    }
    try {
      node.stop(stopAt);
    } catch {
      /* already stopped */
    }
  }

  /** Pink-ish noise (Paul Kellet's filter cascade) — warmer than white for impacts. */
  private ensureNoise(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuf) return this.noiseBuf;
    try {
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < len; i += 1) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }
      this.noiseBuf = buf;
      return buf;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------- crowd

  startCrowd(): void {
    this.crowdWanted = true;
    const ctx = this.ctx;
    if (this.disposed || !ctx || !this.sfxBus || this.crowdSrc) return;
    try {
      const buf = this.ensureCrowd(ctx);
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 150;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.6;
      lp.frequency.value = 900;

      const g = ctx.createGain();
      g.gain.value = MIN_GAIN;

      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(this.sfxBus);
      src.start(0, Math.random() * buf.duration);

      this.crowdSrc = src;
      this.crowdFilter = lp;
      this.crowdGain = g;
      this.applyCrowdEnergy(1.5);
    } catch {
      this.stopCrowd();
      this.crowdWanted = true;
    }
  }

  stopCrowd(): void {
    this.crowdWanted = false;
    const ctx = this.ctx;
    const src = this.crowdSrc;
    const g = this.crowdGain;
    this.crowdSrc = null;
    this.crowdGain = null;
    this.crowdFilter = null;
    if (!ctx || !src) return;
    try {
      const t = ctx.currentTime;
      if (g) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(Math.max(MIN_GAIN, g.gain.value), t);
        g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.4);
      }
      src.stop(t + 0.45);
    } catch {
      /* already gone */
    }
  }

  setCrowdEnergy(v: number): void {
    this.crowdEnergy = clamp01(Number.isFinite(v) ? v : 0);
    this.applyCrowdEnergy(0.7);
  }

  private applyCrowdEnergy(rampS: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.crowdGain || !this.crowdFilter) return;
    try {
      const e = this.crowdEnergy;
      const t = ctx.currentTime;
      // Squared response: a quiet crowd should stay genuinely in the background.
      const gain = 0.045 + 0.26 * e * e;
      const cutoff = 620 + 3200 * e;

      this.crowdGain.gain.cancelScheduledValues(t);
      this.crowdGain.gain.setValueAtTime(Math.max(MIN_GAIN, this.crowdGain.gain.value), t);
      this.crowdGain.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, gain), t + rampS);

      this.crowdFilter.frequency.cancelScheduledValues(t);
      this.crowdFilter.frequency.setValueAtTime(this.crowdFilter.frequency.value, t);
      this.crowdFilter.frequency.linearRampToValueAtTime(cutoff, t + rampS);
    } catch {
      /* ignore */
    }
  }

  crowdReaction(intensity: number): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx || !this.sfxBus || !this.soundEnabled) return;
    if (ctx.state !== 'running' || this.voices >= MAX_VOICES) return;
    try {
      const buf = this.ensureCrowd(ctx);
      if (!buf) return;
      const k = clamp01(Number.isFinite(intensity) ? intensity : 0);
      const t = ctx.currentTime + 0.01;
      const attack = 0.24 - 0.1 * k;
      const decay = 0.9 + 1.2 * k;
      const end = t + attack + decay;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Faster playback lifts the formants — reads as raised voices, not a hiss.
      src.playbackRate.value = 1.12 + 0.3 * k;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.6;
      bp.frequency.setValueAtTime(700, t);
      bp.frequency.linearRampToValueAtTime(1500 + 1500 * k, t + attack);
      bp.frequency.linearRampToValueAtTime(680, end);

      const g = ctx.createGain();
      env(g, t, attack, decay, 0.09 + 0.3 * k);

      src.connect(bp);
      bp.connect(g);
      g.connect(this.sfxBus);
      src.start(t, Math.random() * Math.max(0.01, buf.duration - 0.05));
      this.track(src, end + 0.05, false);
    } catch {
      /* ignore */
    }
  }

  /**
   * A loopable five seconds of crowd. Pink noise alone loops audibly, so the
   * buffer carries slow incommensurate swells and the tail is crossfaded back
   * over the head to hide the seam.
   */
  private ensureCrowd(ctx: AudioContext): AudioBuffer | null {
    if (this.crowdBuf) return this.crowdBuf;
    try {
      const sr = ctx.sampleRate;
      const len = Math.floor(sr * 5);
      const fade = Math.floor(sr * 0.35);
      const raw = new Float32Array(len + fade);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let drift = 0;
      for (let i = 0; i < raw.length; i += 1) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        const pink = b0 + b1 + b2 + w * 0.1848;
        drift = clamp(drift + (Math.random() - 0.5) * 0.004, -0.3, 0.3);
        const s = i / sr;
        const swell = 0.7 + 0.16 * Math.sin(s * 0.83) + 0.12 * Math.sin(s * 2.17 + 1.3) + drift;
        raw[i] = pink * swell * 0.5;
      }
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) d[i] = raw[i];
      for (let i = 0; i < fade; i += 1) {
        const k = i / fade;
        d[i] = raw[i] * k + raw[len + i] * (1 - k);
      }
      this.crowdBuf = buf;
      return buf;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------- music

  startMusic(kind: 'menu' | 'fight' | 'results'): void {
    this.desiredMusic = kind;
    if (this.disposed || this.musicKind === kind) return;
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.musicEnabled) return;
    this.teardownMusic();
    try {
      const t = ctx.currentTime;
      const fadeIn = kind === 'menu' ? 2.6 : kind === 'results' ? 1.2 : 0.9;
      const fade = ctx.createGain();
      fade.gain.setValueAtTime(MIN_GAIN, t);
      fade.gain.exponentialRampToValueAtTime(1, t + fadeIn);
      fade.connect(this.musicBus);

      this.musicFade = fade;
      this.musicKind = kind;
      this.musicStep = 0;
      // Fight sits at 148bpm in eighths; the others are slow enough to be scenery.
      this.stepDur = kind === 'fight' ? 30 / 148 : kind === 'menu' ? 3.4 : 0.5;
      this.nextStepTime = t + 0.1;
      this.pump();
      this.musicTimer = window.setInterval(() => this.pump(), SCHEDULER_MS);
    } catch {
      this.teardownMusic();
    }
  }

  stopMusic(): void {
    this.desiredMusic = null;
    this.teardownMusic();
  }

  private teardownMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    this.musicKind = null;
    const fade = this.musicFade;
    this.musicFade = null;
    const nodes = [...this.musicNodes];
    this.musicNodes.clear();

    const ctx = this.ctx;
    if (!ctx) return;
    const release = 0.35;
    const t = ctx.currentTime;
    try {
      if (fade) {
        fade.gain.cancelScheduledValues(t);
        fade.gain.setValueAtTime(Math.max(MIN_GAIN, fade.gain.value), t);
        fade.gain.exponentialRampToValueAtTime(MIN_GAIN, t + release);
      }
    } catch {
      /* ignore */
    }
    for (const n of nodes) {
      n.onended = null;
      try {
        n.stop(t + release + 0.05);
      } catch {
        /* already stopped */
      }
    }
    if (fade) {
      this.later(() => {
        try {
          fade.disconnect();
        } catch {
          /* ignore */
        }
      }, (release + 0.3) * 1000);
    }
  }

  /** Lookahead scheduler: setInterval only decides *what* to book, never *when*. */
  private pump(): void {
    const ctx = this.ctx;
    const kind = this.musicKind;
    const dest = this.musicFade;
    if (!ctx || !kind || !dest) return;
    try {
      // A backgrounded tab starves the interval; resync instead of dumping a burst.
      if (this.nextStepTime < ctx.currentTime - 0.25) this.nextStepTime = ctx.currentTime + 0.02;
      const horizon = ctx.currentTime + LOOKAHEAD_S;
      let guard = 0;
      while (this.nextStepTime < horizon && guard < 32) {
        guard += 1;
        this.emit(ctx, dest, kind, this.musicStep, this.nextStepTime);
        this.musicStep += 1;
        this.nextStepTime += this.stepDur;
      }
    } catch {
      this.teardownMusic();
    }
  }

  private emit(ctx: AudioContext, dest: AudioNode, kind: MusicKind, step: number, t: number): void {
    if (kind === 'fight') this.emitFight(ctx, dest, step, t);
    else if (kind === 'menu') this.emitMenu(ctx, dest, step, t);
    else this.emitResults(ctx, dest, step, t);
  }

  private emitFight(ctx: AudioContext, dest: AudioNode, step: number, t: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16) % FIGHT_ROOTS.length;
    const root = 33 + FIGHT_ROOTS[bar];
    const note = root + FIGHT_RIFF[s];
    // Downbeats punch, offbeats sit back — that alternation is the whole groove.
    const accent = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.7 : 0.48;

    this.tone(ctx, dest, t, {
      type: 'sawtooth',
      f0: midi(note),
      attack: 0.006,
      decay: this.stepDur * 0.8,
      peak: 0.12 * accent,
      filter: { type: 'lowpass', freq: 240 + 420 * accent, q: 6, sweepTo: 180 },
      music: true,
    });
    this.tone(ctx, dest, t, {
      type: 'sine',
      f0: midi(note - 12),
      attack: 0.006,
      decay: this.stepDur * 0.9,
      peak: 0.15 * accent,
      music: true,
    });

    const off = s % 2 === 1;
    this.noiseHit(ctx, dest, t, {
      type: 'highpass',
      freq: off ? 7400 : 5400,
      q: 0.7,
      attack: 0.001,
      decay: off ? 0.045 : 0.028,
      peak: off ? 0.042 : 0.02,
      music: true,
    });

    // One long drone per bar keeps the loop from feeling like a drum machine.
    if (s === 0) {
      this.tone(ctx, dest, t, {
        type: 'sawtooth',
        f0: midi(root + 12),
        attack: 0.6,
        decay: this.stepDur * 15,
        peak: 0.032,
        filter: { type: 'lowpass', freq: 620, q: 1.4 },
        music: true,
      });
    }
  }

  private emitMenu(ctx: AudioContext, dest: AudioNode, step: number, t: number): void {
    const chord = MENU_CHORDS[step % MENU_CHORDS.length];
    for (let i = 0; i < chord.length; i += 1) {
      const bass = i === 0;
      this.tone(ctx, dest, t, {
        type: bass ? 'sine' : 'sawtooth',
        f0: midi(chord[i]),
        detune: bass ? 0 : (i % 2 === 0 ? 5 : -5),
        attack: bass ? 0.9 : 1.4,
        decay: 2.6,
        peak: bass ? 0.05 : 0.024,
        filter: { type: 'lowpass', freq: 480, q: 0.9, sweepTo: 1500 },
        music: true,
      });
    }
    // Air on top: a slow noise swell so the pad is not purely synthetic.
    this.noiseHit(ctx, dest, t, {
      type: 'bandpass',
      freq: 1800,
      q: 1.4,
      sweepTo: 3600,
      attack: 1.6,
      decay: 2.2,
      peak: 0.012,
      music: true,
    });
  }

  private emitResults(ctx: AudioContext, dest: AudioNode, step: number, t: number): void {
    const chord = RESULTS_CADENCE[step % RESULTS_CADENCE.length];
    if (!chord) return;
    for (let i = 0; i < chord.length; i += 1) {
      this.tone(ctx, dest, t + i * 0.012, {
        type: i === 0 ? 'triangle' : 'sine',
        f0: midi(chord[i]),
        attack: 0.012,
        decay: 0.95,
        peak: i === 0 ? 0.07 : 0.045,
        filter: { type: 'lowpass', freq: 2400, q: 0.8 },
        music: true,
      });
    }
  }

  private later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }
}

/** One engine for the whole app — a second AudioContext would just fight this one. */
export const audio = new AudioEngine();
