import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Difficulty } from '@/types/combat';
import {
  loadCareer,
  loadSettings,
  loadTraining,
  saveCalibration,
  saveCareer,
  saveSettings,
  saveTraining,
  type CareerProgress,
  type FightResult,
  type Screen,
  type Settings,
  type TrainingResult,
} from '@/store/appState';
import { CAREER_RANKS } from '@/config/gameConfig';
import { CAREER_LADDER, rankForStage, stageFor } from '@/data/career';
import { DIFFICULTY_LIST } from '@/data/difficulty';
import { ENEMIES } from '@/data/enemies';
import { audio } from '@/audio/AudioEngine';
import { GameEngine, type EnginePhase, type HudState } from '@/game/GameEngine';
import { TrainingMode, type TrainingHudState } from '@/game/TrainingMode';
import { CALIBRATION_STEPS } from '@/vision/CalibrationSystem';
import { useVision } from '@/hooks/useVision';

import MainMenu from '@/components/MainMenu';
import FighterSelect from '@/components/FighterSelect';
import Tutorial from '@/components/Tutorial';
import SettingsScreen from '@/components/SettingsScreen';
import CareerScreen from '@/components/CareerScreen';
import Calibration from '@/components/Calibration';
import GameHUD from '@/components/GameHUD';
import CameraPanel from '@/components/CameraPanel';
import DebugPanel from '@/components/DebugPanel';
import PauseMenu from '@/components/PauseMenu';
import CameraErrorScreen from '@/components/CameraErrorScreen';
import ResultsScreen from '@/components/ResultsScreen';
import TrainingHUD from '@/components/TrainingHUD';
import TrainingResults from '@/components/TrainingResults';
import FighterPortrait from '@/components/FighterPortrait';

const BLANK_HUD: HudState = {
  playerName: 'YOU',
  enemyName: '',
  playerHp: 1,
  playerHpMax: 1,
  enemyHp: 1,
  enemyHpMax: 1,
  playerStamina: 1,
  playerStaminaMax: 1,
  enemyStamina: 1,
  enemyStaminaMax: 1,
  rage: 0,
  rageMax: 100,
  rageActive: false,
  round: 1,
  roundTotal: 3,
  timeLeft: 0,
  roundsWon: { player: 0, enemy: 0 },
  combo: 0,
  comboWindow: 0,
  lastAction: null,
  strikePower: 0,
  announcement: null,
  knockdownCount: null,
};

const BLANK_TRAINING_HUD: TrainingHudState = {
  timeLeft: 60,
  score: 0,
  hits: 0,
  misses: 0,
  accuracy: 0,
  combo: 0,
  bestCombo: 0,
  lastReactionMs: null,
  strikePower: 0,
  prompt: null,
  promptTone: 'neutral',
};

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [career, setCareer] = useState<CareerProgress>(() => loadCareer());
  const [trainingRecords, setTrainingRecords] = useState(() => loadTraining());
  /** Bests as they stood before the session just played, for the delta chips. */
  const [trainingBaseline, setTrainingBaseline] = useState(() => loadTraining());

  const [screen, setScreen] = useState<Screen>('menu');
  const [enemyId, setEnemyId] = useState<string>(ENEMIES[0].id);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [careerStageIndex, setCareerStageIndex] = useState<number | null>(null);

  const [hud, setHud] = useState<HudState>(BLANK_HUD);
  const [trainingHud, setTrainingHud] = useState<TrainingHudState>(BLANK_TRAINING_HUD);
  const [phase, setPhase] = useState<EnginePhase>('intro');
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState<'user' | 'tracking'>('user');
  const [cameraCollapsed, setCameraCollapsed] = useState(false);
  const [fightResult, setFightResult] = useState<FightResult | null>(null);
  const [trainingResult, setTrainingResult] = useState<TrainingResult | null>(null);
  const [trainingIsBest, setTrainingIsBest] = useState(false);
  const [showCameraError, setShowCameraError] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const trainingRef = useRef<TrainingMode | null>(null);
  /** Where to go after calibration finishes. */
  const afterCalibration = useRef<Screen>('fight');

  const vision = useVision();

  // --------------------------------------------------------------- settings

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  useEffect(() => {
    audio.setSoundEnabled(settings.sound);
    audio.setMusicEnabled(settings.music);
    audio.setMasterVolume(settings.masterVolume);
    vision.controller.setSensitivity(settings.sensitivity);
    engineRef.current?.setSettings(settings);
    trainingRef.current?.setSettings(settings);
    document.documentElement.dataset.reducedMotion = settings.reducedMotion ? 'true' : 'false';
  }, [settings, vision.controller]);

  // The AudioContext may only be created from a real gesture.
  useEffect(() => {
    const unlock = (): void => {
      void audio.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (screen === 'menu' || screen === 'select' || screen === 'career') audio.startMusic('menu');
  }, [screen]);

  // Surface a camera failure as a full screen only while it actually blocks play.
  useEffect(() => {
    if (vision.error && (screen === 'calibration' || screen === 'fight' || screen === 'training')) {
      setShowCameraError(true);
    }
  }, [vision.error, screen]);

  // --------------------------------------------------------------- engine

  const teardown = useCallback(() => {
    engineRef.current?.dispose();
    engineRef.current = null;
    trainingRef.current?.dispose();
    trainingRef.current = null;
    setPaused(false);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const finishFight = useCallback(
    (result: FightResult) => {
      // Career progression only advances on a win against the current stage.
      if (careerStageIndex !== null && result.outcome === 'victory') {
        setCareer((prev) => {
          const advanced = careerStageIndex >= prev.stageIndex;
          const nextIndex = advanced ? Math.min(CAREER_LADDER.length, prev.stageIndex + 1) : prev.stageIndex;
          const next: CareerProgress = {
            ...prev,
            stageIndex: nextIndex,
            rank: rankForStage(Math.min(nextIndex, CAREER_LADDER.length - 1)),
            wins: prev.wins + 1,
            koWins: prev.koWins + (result.method === 'KO' || result.method === 'TKO' ? 1 : 0),
            defeatedIds: prev.defeatedIds.includes(result.enemyId)
              ? prev.defeatedIds
              : [...prev.defeatedIds, result.enemyId],
            bestCombo: Math.max(prev.bestCombo, result.stats.bestCombo),
            totalDamage: prev.totalDamage + result.stats.damageDealt,
            bestPower: Math.max(prev.bestPower, result.stats.highestPower),
          };
          saveCareer(next);
          result.career = {
            advanced,
            newRank: advanced && next.rank !== prev.rank ? next.rank : null,
            completed: nextIndex >= CAREER_LADDER.length,
          };
          return next;
        });
      } else if (careerStageIndex !== null) {
        setCareer((prev) => {
          const next = { ...prev, losses: prev.losses + 1 };
          saveCareer(next);
          return next;
        });
      } else {
        setCareer((prev) => {
          const next: CareerProgress = {
            ...prev,
            bestCombo: Math.max(prev.bestCombo, result.stats.bestCombo),
            bestPower: Math.max(prev.bestPower, result.stats.highestPower),
            totalDamage: prev.totalDamage + result.stats.damageDealt,
          };
          saveCareer(next);
          return next;
        });
      }

      setFightResult(result);
      setScreen('results');
      audio.startMusic('results');
    },
    [careerStageIndex],
  );

  const finishTraining = useCallback((result: TrainingResult) => {
    setTrainingRecords((prev) => {
      const isBest = result.score > prev.bestScore;
      // Snapshot the pre-session bests: the results screen compares against
      // them, so handing it the already-updated record would always show zero.
      setTrainingBaseline(prev);
      const next = {
        sessions: prev.sessions + 1,
        bestAccuracy: Math.max(prev.bestAccuracy, result.accuracy),
        bestCombo: Math.max(prev.bestCombo, result.bestCombo),
        bestReaction:
          prev.bestReaction === 0 ? result.bestReactionMs : Math.min(prev.bestReaction, result.bestReactionMs || prev.bestReaction),
        bestPower: Math.max(prev.bestPower, result.bestPower),
        bestScore: Math.max(prev.bestScore, result.score),
      };
      saveTraining(next);
      setTrainingIsBest(isBest);
      return next;
    });
    setTrainingResult(result);
    setScreen('trainingResults');
  }, []);

  // Boot the engine whenever we land on a playable screen.
  useEffect(() => {
    if (screen !== 'fight' && screen !== 'training') {
      teardown();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    void audio.unlock();

    if (screen === 'fight') {
      const engine = new GameEngine({
        canvas,
        vision: vision.controller,
        settings,
        enemyId,
        difficulty,
        onHud: setHud,
        onFinished: finishFight,
        onPhase: setPhase,
      });
      engineRef.current = engine;
      engine.start();
    } else {
      const training = new TrainingMode({
        canvas,
        vision: vision.controller,
        settings,
        onHud: setTrainingHud,
        onFinished: finishTraining,
      });
      trainingRef.current = training;
      training.start();
    }

    return () => teardown();
    // Settings are pushed imperatively via setSettings so they must not restart
    // the fight — only the screen and the matchup may do that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, enemyId, difficulty, vision.controller, finishFight, finishTraining, teardown]);

  // Tracking loss drives the pause overlay without stealing the user's own pause.
  useEffect(() => {
    if (phase === 'tracking_lost') {
      setPauseReason('tracking');
      setPaused(true);
    } else if (pauseReason === 'tracking' && paused) {
      setPaused(false);
    }
  }, [phase, pauseReason, paused]);

  const togglePause = useCallback(() => {
    const engine = engineRef.current;
    const training = trainingRef.current;
    if (engine) {
      if (engine.isPaused) {
        engine.resume();
        setPaused(false);
      } else {
        engine.pause();
        setPauseReason('user');
        setPaused(true);
      }
    } else if (training) {
      if (training.isPaused) {
        training.resume();
        setPaused(false);
      } else {
        training.pause();
        setPauseReason('user');
        setPaused(true);
      }
    }
  }, []);

  useEffect(() => {
    if (screen !== 'fight' && screen !== 'training') return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') {
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen, togglePause]);

  // --------------------------------------------------------------- calibration

  const [calStep, setCalStep] = useState(0);
  const [calProgress, setCalProgress] = useState(0);
  const [calStepProgress, setCalStepProgress] = useState(0);
  const [calDone, setCalDone] = useState(false);
  /** Punches actually captured per hand — the screen used to claim success
   *  regardless, even when the profile silently fell back to defaults. */
  const [calPunchL, setCalPunchL] = useState(0);
  const [calPunchR, setCalPunchR] = useState(0);

  useEffect(() => {
    if (screen !== 'calibration') return undefined;
    let raf = 0;
    const cal = vision.controller.calibration;
    const pump = (): void => {
      setCalStep(cal.stepIndex);
      setCalProgress(cal.progress());
      setCalStepProgress(cal.stepProgress());
      setCalDone(cal.done);
      const summary = cal.summary();
      setCalPunchL(summary[0]?.punches ?? 0);
      setCalPunchR(summary[1]?.punches ?? 0);
      raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(raf);
  }, [screen, vision.controller]);

  const beginCalibration = useCallback(
    async (next: Screen) => {
      afterCalibration.current = next;
      setScreen('calibration');
      setCalDone(false);
      await vision.enable();
      vision.controller.startCalibration();
    },
    [vision],
  );

  const completeCalibration = useCallback(() => {
    const profile = vision.controller.finishCalibration(settings.sensitivity);
    saveCalibration(profile);
    audio.play('menuSelect');
    setScreen(afterCalibration.current);
  }, [vision.controller, settings.sensitivity]);

  const skipCalibration = useCallback(() => {
    const profile = vision.controller.skipCalibration(settings.sensitivity);
    saveCalibration(profile);
    audio.play('menuBack');
    setScreen(afterCalibration.current);
  }, [vision.controller, settings.sensitivity]);

  // --------------------------------------------------------------- navigation

  const go = useCallback((s: Screen) => {
    audio.play('menuSelect');
    setScreen(s);
  }, []);

  /** Enters a playable screen, running calibration first if it has never run. */
  const enterPlayable = useCallback(
    async (target: Screen) => {
      const cal = vision.controller.getCalibration();
      if (vision.status !== 'ready') {
        await vision.enable();
      }
      if (!cal.calibrated) {
        await beginCalibration(target);
        return;
      }
      setScreen(target);
    },
    [vision, beginCalibration],
  );

  const startQuickFight = useCallback(() => {
    setCareerStageIndex(null);
    void enterPlayable('fight');
  }, [enterPlayable]);

  const startCareerStage = useCallback(
    (index: number) => {
      const stage = stageFor(index);
      if (!stage) return;
      setCareerStageIndex(index);
      setEnemyId(stage.enemyId);
      setDifficulty(stage.difficulty);
      void enterPlayable('fight');
    },
    [enterPlayable],
  );

  const resetProgress = useCallback(() => {
    const fresh: CareerProgress = {
      rank: CAREER_RANKS[0],
      stageIndex: 0,
      wins: 0,
      losses: 0,
      koWins: 0,
      defeatedIds: [],
      bestCombo: 0,
      totalDamage: 0,
      bestPower: 0,
    };
    setCareer(fresh);
    saveCareer(fresh);
    audio.play('menuBack');
  }, []);

  const renderPortrait = useCallback(
    (styleId: string, size: number) => <FighterPortrait styleId={styleId} size={size} />,
    [],
  );

  const calibrationSteps = useMemo(
    () =>
      CALIBRATION_STEPS.map((s) => ({
        id: s.id,
        title: s.title,
        instruction: s.instruction,
        seconds: s.seconds,
      })),
    [],
  );

  const inGame = screen === 'fight' || screen === 'training';
  const frame = vision.frame;
  const debug = engineRef.current?.debug;

  // --------------------------------------------------------------- render

  return (
    <div className="hs-app">
      {/*
        The one and only <video> in the app. It holds the MediaStream for the
        whole session and is never remounted, never conditionally hidden.

        Two rules it exists to enforce:
         - Nothing else may render a <video> bound to vision.videoRef. Two
           elements sharing one ref means the stream lands on whichever won the
           race, and the other one renders black.
         - It must never get `display: none`. A non-rendered video stops
           presenting frames in Chrome, which silently kills
           requestVideoFrameCallback and with it the whole detection loop.
           Kept 2x2 and effectively invisible instead.

        Previews read pixels out of it through <CameraFeed>.
      */}
      <video
        ref={vision.videoRef}
        autoPlay
        muted
        playsInline
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: 0,
          bottom: 0,
          width: 2,
          height: 2,
          opacity: 0.01,
          zIndex: -1,
          pointerEvents: 'none',
        }}
      />

      {screen === 'menu' && (
        <MainMenu
          cameraStatus={vision.status}
          cameraMessage={vision.error?.message ?? null}
          onQuickFight={() => {
            setCareerStageIndex(null);
            go('select');
          }}
          onTraining={() => {
            setCareerStageIndex(null);
            void enterPlayable('training');
          }}
          onCareer={() => go('career')}
          onHowToPlay={() => go('tutorial')}
          onSettings={() => go('settings')}
          onEnableCamera={() => void vision.enable()}
          careerRank={career.rank}
          hasProgress={career.wins > 0 || career.stageIndex > 0}
        />
      )}

      {screen === 'select' && (
        <FighterSelect
          enemies={ENEMIES}
          difficulties={DIFFICULTY_LIST}
          selectedEnemyId={enemyId}
          selectedDifficulty={difficulty}
          onSelectEnemy={setEnemyId}
          onSelectDifficulty={setDifficulty}
          onConfirm={startQuickFight}
          onBack={() => go('menu')}
          renderPortrait={renderPortrait}
        />
      )}

      {screen === 'career' && (
        <CareerScreen
          stages={CAREER_LADDER}
          enemies={ENEMIES}
          progress={career}
          onFight={startCareerStage}
          onBack={() => go('menu')}
          onReset={resetProgress}
          renderPortrait={renderPortrait}
        />
      )}

      {screen === 'tutorial' && (
        <Tutorial onBack={() => go('menu')} onStart={() => go('select')} />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          onChange={patchSettings}
          onBack={() => go('menu')}
          onRecalibrate={() => void beginCalibration('menu')}
          onResetProgress={resetProgress}
        />
      )}

      {screen === 'calibration' && (
        <Calibration
          step={calStep}
          steps={calibrationSteps}
          progress={calProgress}
          stepProgress={calStepProgress}
          samplesGood={vision.controller.calibration.samplesGood}
          controller={vision.controller}
          mirrored={settings.mirrorCamera}
          liveHint={vision.controller.calibration.liveHint}
          tracking={{
            leftHand: frame.tracking.leftHand,
            rightHand: frame.tracking.rightHand,
            pose: frame.tracking.pose,
          }}
          punchesCaptured={{ left: calPunchL, right: calPunchR }}
          cameraLive={frame.tracking.camera}
          cameraStatus={vision.status}
          onSkip={skipCalibration}
          onCancel={() => go('menu')}
          done={calDone}
          onFinish={completeCalibration}
        />
      )}

      {inGame && (
        <div className="hs-stage">
          <canvas ref={canvasRef} className="hs-canvas" />

          {screen === 'fight' ? (
            <GameHUD {...hud} />
          ) : (
            <TrainingHUD
              state={trainingHud}
              onQuit={() => {
                trainingRef.current?.stop();
                go('menu');
              }}
            />
          )}

          {settings.showCameraPanel && (
            <CameraPanel
              controller={vision.controller}
              active={frame.tracking.camera}
              mirrored={settings.mirrorCamera}
              mode={settings.feedMode}
              onToggleMode={() =>
                patchSettings({ feedMode: settings.feedMode === 'camera' ? 'sketch' : 'camera' })
              }
              handState={{
                left: {
                  present: frame.hands.left.present,
                  fist: frame.hands.left.fistClosed,
                  confidence: frame.hands.left.confidence,
                },
                right: {
                  present: frame.hands.right.present,
                  fist: frame.hands.right.fistClosed,
                  confidence: frame.hands.right.confidence,
                },
              }}
              leftHand={frame.tracking.leftHand}
              rightHand={frame.tracking.rightHand}
              pose={frame.tracking.pose}
              detected={screen === 'fight' ? hud.lastAction : trainingHud.prompt}
              strikePower={screen === 'fight' ? hud.strikePower : trainingHud.strikePower}
              quality={frame.tracking.quality}
              hint={frame.tracking.hint}
              showLandmarks={settings.showLandmarks}
              collapsed={cameraCollapsed}
              onToggleCollapse={() => setCameraCollapsed((c) => !c)}
            />
          )}

          {settings.debug && (
            <DebugPanel
              visible
              fps={debug?.fps ?? 0}
              visionFps={frame.stats.fps}
              inferenceMs={frame.stats.inferenceMs}
              backend={frame.stats.backend}
              assetSource={frame.stats.assetSource}
              resolution={frame.stats.resolution}
              particles={debug?.particles ?? 0}
              left={{
                tracked: frame.hands.left.present,
                x: frame.hands.left.pos.x,
                y: frame.hands.left.pos.y,
                speed: frame.hands.left.speed,
                accel: frame.hands.left.accel,
                palm: frame.hands.left.palmSize,
              }}
              right={{
                tracked: frame.hands.right.present,
                x: frame.hands.right.pos.x,
                y: frame.hands.right.pos.y,
                speed: frame.hands.right.speed,
                accel: frame.hands.right.accel,
                palm: frame.hands.right.palmSize,
              }}
              poseTracked={frame.pose.present}
              lean={frame.pose.lean}
              crouch={frame.pose.crouch}
              lastAction={hud.lastAction}
              confidence={debug?.confidence ?? 0}
              aiState={debug?.aiState ?? '-'}
              aiReason={debug?.aiReason ?? '-'}
              aiAdaptation={debug?.aiAdaptation ?? '-'}
              gap={debug?.gap ?? 0}
              phase={debug?.phase ?? phase}
              thresholds={{
                punchSpeed: vision.controller.getCalibration().punchSpeed,
                punchTravel: vision.controller.getCalibration().punchTravel,
                dodge: vision.controller.getCalibration().dodgeThreshold,
                duck: vision.controller.getCalibration().duckThreshold,
                guard: vision.controller.getCalibration().guardHeight,
              }}
              onClose={() => patchSettings({ debug: false })}
            />
          )}

          <PauseMenu
            open={paused}
            reason={pauseReason}
            onResume={togglePause}
            onRestart={() => {
              setPaused(false);
              // Remount the engine by bouncing off the screen state.
              const target = screen;
              setScreen('menu');
              window.setTimeout(() => setScreen(target), 30);
            }}
            onQuit={() => {
              teardown();
              go('menu');
            }}
            onSettings={() => {
              teardown();
              go('settings');
            }}
          />
        </div>
      )}

      {screen === 'results' && fightResult && (
        <ResultsScreen
          result={fightResult}
          onRematch={() => {
            setFightResult(null);
            void enterPlayable('fight');
          }}
          onChangeOpponent={() => {
            setFightResult(null);
            setCareerStageIndex(null);
            go('select');
          }}
          onMainMenu={() => {
            setFightResult(null);
            go('menu');
          }}
          {...(careerStageIndex !== null && fightResult.outcome === 'victory'
            ? {
                onContinueCareer: () => {
                  setFightResult(null);
                  go('career');
                },
              }
            : {})}
        />
      )}

      {screen === 'trainingResults' && trainingResult && (
        <TrainingResults
          result={trainingResult}
          records={trainingRecords}
          baseline={trainingBaseline}
          isNewBest={trainingIsBest}
          onRetry={() => {
            setTrainingResult(null);
            void enterPlayable('training');
          }}
          onMainMenu={() => {
            setTrainingResult(null);
            go('menu');
          }}
        />
      )}

      {showCameraError && vision.error && (
        <div className="hs-overlay hs-interactive" style={{ background: 'rgba(4,5,10,0.94)', pointerEvents: 'auto' }}>
          <CameraErrorScreen
            kind={vision.error.kind}
            message={vision.error.message}
            onRetry={() => {
              setShowCameraError(false);
              vision.clearError();
              void vision.enable();
            }}
            onUseKeyboard={() => {
              setShowCameraError(false);
              vision.clearError();
              patchSettings({ keyboardFallback: true });
              setScreen('fight');
            }}
            onBack={() => {
              setShowCameraError(false);
              vision.clearError();
              setScreen('menu');
            }}
          />
        </div>
      )}

      {/* The main menu carries its own privacy line, so only the other screens
          need the persistent one. */}
      {screen !== 'menu' && (
        <div className="hs-privacy">Camera processing happens locally on your device.</div>
      )}
    </div>
  );
}
