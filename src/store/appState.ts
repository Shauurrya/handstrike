import type { CareerRank } from '@/config/gameConfig';
import type { CalibrationProfile, Difficulty, FightIQ, FightStats } from '@/types';
import { DEFAULT_CALIBRATION } from '@/types/vision';
import { readJSON, STORAGE_KEYS, writeJSON } from '@/utils/storage';

export type Screen =
  | 'boot'
  | 'menu'
  | 'select'
  | 'calibration'
  | 'tutorial'
  | 'settings'
  | 'career'
  | 'fight'
  | 'training'
  | 'results'
  | 'trainingResults';

export interface Settings {
  sound: boolean;
  music: boolean;
  masterVolume: number;
  /** Punch-detection strictness. Lower = easier to trigger. */
  sensitivity: number;
  showCameraPanel: boolean;
  /**
   * Skeleton, motion trails and punch bursts drawn over the camera preview.
   * This is player-facing feedback ("the game can see me"), not a debug tool —
   * it defaults on. `debug` is the separate developer readout.
   */
  showLandmarks: boolean;
  /**
   * `camera` shows the webcam image with tracking drawn over it. `sketch`
   * shows the glowing skeleton alone on a dark field — clearer to read mid
   * fight, and it keeps the player's room off the screen.
   */
  feedMode: 'camera' | 'sketch';
  debug: boolean;
  screenShake: boolean;
  particles: 'low' | 'medium' | 'high';
  mirrorCamera: boolean;
  roundSeconds: number;
  roundCount: number;
  keyboardFallback: boolean;
  reducedMotion: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  music: true,
  masterVolume: 0.75,
  sensitivity: 1,
  showCameraPanel: true,
  showLandmarks: true,
  feedMode: 'camera',
  debug: false,
  screenShake: true,
  particles: 'high',
  mirrorCamera: true,
  roundSeconds: 120,
  roundCount: 3,
  keyboardFallback: true,
  reducedMotion: false,
};

export interface CareerProgress {
  rank: CareerRank;
  stageIndex: number;
  wins: number;
  losses: number;
  koWins: number;
  defeatedIds: string[];
  bestCombo: number;
  totalDamage: number;
  /** Highest STRIKE POWER ever recorded. */
  bestPower: number;
}

export const DEFAULT_CAREER: CareerProgress = {
  rank: 'ROOKIE',
  stageIndex: 0,
  wins: 0,
  losses: 0,
  koWins: 0,
  defeatedIds: [],
  bestCombo: 0,
  totalDamage: 0,
  bestPower: 0,
};

export interface TrainingRecord {
  sessions: number;
  bestAccuracy: number;
  bestCombo: number;
  bestReaction: number;
  bestPower: number;
  bestScore: number;
}

export const DEFAULT_TRAINING: TrainingRecord = {
  sessions: 0,
  bestAccuracy: 0,
  bestCombo: 0,
  bestReaction: 0,
  bestPower: 0,
  bestScore: 0,
};

/** Result payload handed to the post-fight screen. */
export interface FightResult {
  outcome: 'victory' | 'defeat' | 'draw';
  method: 'KO' | 'TKO' | 'DECISION';
  enemyId: string;
  enemyName: string;
  difficulty: Difficulty;
  roundsWon: { player: number; enemy: number };
  roundReached: number;
  stats: FightStats;
  iq: FightIQ;
  /** Career mode only. */
  career?: { advanced: boolean; newRank: CareerRank | null; completed: boolean };
}

export interface TrainingResult {
  score: number;
  targetsHit: number;
  targetsMissed: number;
  accuracy: number;
  avgReactionMs: number;
  bestReactionMs: number;
  avgPower: number;
  bestPower: number;
  bestCombo: number;
  blocks: number;
  dodges: number;
  defense: number;
  punchSpeed: number;
  durationSec: number;
  perHand: { left: number; right: number };
}

/**
 * Bumped whenever a *default* changes in a way returning players should get.
 * Saved settings are otherwise sticky, so a player who ran the game once would
 * be pinned to the old default forever.
 *
 * v2 — the tracking overlay became player-facing feedback and defaults on.
 */
const SETTINGS_VERSION = 2;

/** Fields re-taken from DEFAULT_SETTINGS when the stored blob is older. */
const MIGRATED_ON_UPGRADE: (keyof Settings)[] = ['showLandmarks'];

export const loadSettings = (): Settings => {
  const stored = readJSON<Partial<Settings> & { version?: number }>(STORAGE_KEYS.settings, {});
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stored };

  if ((stored.version ?? 0) < SETTINGS_VERSION) {
    for (const key of MIGRATED_ON_UPGRADE) {
      // Deliberately a blind reset rather than a merge: the point is to undo a
      // default the player never actually chose.
      Object.assign(merged, { [key]: DEFAULT_SETTINGS[key] });
    }
  }

  return merged;
};

export const saveSettings = (s: Settings): void =>
  writeJSON(STORAGE_KEYS.settings, { ...s, version: SETTINGS_VERSION });

export const loadCareer = (): CareerProgress => ({
  ...DEFAULT_CAREER,
  ...readJSON<Partial<CareerProgress>>(STORAGE_KEYS.career, {}),
});
export const saveCareer = (c: CareerProgress): void => writeJSON(STORAGE_KEYS.career, c);

export const loadCalibration = (): CalibrationProfile => ({
  ...DEFAULT_CALIBRATION,
  ...readJSON<Partial<CalibrationProfile>>(STORAGE_KEYS.calibration, {}),
});
export const saveCalibration = (c: CalibrationProfile): void => writeJSON(STORAGE_KEYS.calibration, c);

export const loadTraining = (): TrainingRecord => ({
  ...DEFAULT_TRAINING,
  ...readJSON<Partial<TrainingRecord>>(STORAGE_KEYS.training, {}),
});
export const saveTraining = (t: TrainingRecord): void => writeJSON(STORAGE_KEYS.training, t);
