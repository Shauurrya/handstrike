import type { CSSProperties } from 'react';
import { clamp01 } from '@/utils/math';
import type { VisionController } from '@/vision/VisionController';
import CameraFeed from './CameraFeed';

/**
 * Calibration is pure presentation — the parent owns all timing, sampling and
 * step advancement, so this screen can be driven from a replay or a test
 * harness without a camera attached.
 */

export interface CalibrationStepInfo {
  id: string;
  title: string;
  instruction: string;
  seconds: number;
}

export interface CalibrationProps {
  step: number;
  steps: CalibrationStepInfo[];
  progress: number;
  stepProgress: number;
  samplesGood: boolean;
  controller: VisionController;
  mirrored: boolean;
  liveHint: string | null;
  /** Live tracking flags, so the player can see what the camera has found. */
  tracking: { leftHand: boolean; rightHand: boolean; pose: boolean };
  /** Punches actually measured per hand. Drives the live counter and the
   *  honesty of the completion panel. */
  punchesCaptured: { left: number; right: number };
  /** Whether frames are actually arriving. Calibration cannot progress without
   *  them, so the screen must say so rather than imply sampling is happening. */
  cameraLive: boolean;
  cameraStatus: 'idle' | 'requesting' | 'ready' | 'error';
  onSkip(): void;
  onCancel(): void;
  done: boolean;
  onFinish(): void;
}

const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

const BRACKET: CSSProperties = {
  position: 'absolute',
  width: 26,
  height: 26,
  borderColor: 'var(--player)',
  borderStyle: 'solid',
  borderWidth: 0,
  pointerEvents: 'none',
};

function CornerBrackets() {
  return (
    <>
      <span style={{ ...BRACKET, top: 10, left: 10, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 4 }} />
      <span style={{ ...BRACKET, top: 10, right: 10, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 4 }} />
      <span style={{ ...BRACKET, bottom: 10, left: 10, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 4 }} />
      <span style={{ ...BRACKET, bottom: 10, right: 10, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 4 }} />
    </>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path
        d="M2.5 7.5 L5.5 10.5 L11.5 3.5"
        fill="none"
        stroke="var(--good)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Neutral counterpart to Check, for a step that produced no samples. */
function Dash() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 7 L11 7" fill="none" stroke="var(--warn)" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** Live "the camera has this" pill, sitting over the preview itself. */
function TrackChip({ label, on, color }: { label: string; on: boolean; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 999,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.12em',
        backgroundColor: 'rgba(6,7,13,0.72)',
        border: `1px solid ${on ? color : 'var(--edge2)'}`,
        color: on ? color : 'var(--ink-faint)',
        transition: 'color 160ms ease-out, border-color 160ms ease-out',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          backgroundColor: on ? color : 'var(--edge2)',
          boxShadow: on ? `0 0 6px ${color}` : 'none',
        }}
      />
      {label}
    </span>
  );
}

/** Draining ring that reads as a countdown for the current step. */
function CountdownRing({ progress, seconds, good }: { progress: number; seconds: number; good: boolean }) {
  const p = clamp01(progress);
  const remaining = Math.max(0, Math.ceil(seconds * (1 - p)));
  const color = good ? 'var(--player)' : 'var(--warn)';
  return (
    <div style={{ position: 'relative', width: 84, height: 84, flexShrink: 0 }}>
      <svg width="84" height="84" viewBox="0 0 84 84" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
        <circle cx="42" cy="42" r={RING_R} fill="none" stroke="var(--edge)" strokeWidth="4" />
        <circle
          cx="42"
          cy="42"
          r={RING_R}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * p}
          style={{ transition: 'stroke-dashoffset 90ms linear, stroke 200ms ease-out' }}
        />
      </svg>
      <span
        className="hs-num"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 26,
          fontWeight: 700,
          color: 'var(--ink)',
        }}
      >
        {remaining}
      </span>
    </div>
  );
}

export function Calibration({
  step,
  steps,
  progress,
  stepProgress,
  samplesGood,
  controller,
  mirrored,
  liveHint,
  tracking,
  punchesCaptured,
  cameraLive,
  cameraStatus,
  onSkip,
  onCancel,
  done,
  onFinish,
}: CalibrationProps) {
  const index = Math.min(Math.max(0, step), Math.max(0, steps.length - 1));
  const current = steps[index] as CalibrationStepInfo | undefined;

  // Below this the profile silently keeps the built-in punch thresholds, so
  // the completion panel must not claim the player's own speed was measured.
  const MIN_PUNCHES = 3;
  const totalPunches = punchesCaptured.left + punchesCaptured.right;
  const punchesMeasured = totalPunches >= MIN_PUNCHES;

  const activeHand =
    current?.id?.toLowerCase().includes('left') ? 'left'
    : current?.id?.toLowerCase().includes('right') ? 'right'
    : null;
  const activeCount = activeHand === 'left' ? punchesCaptured.left : activeHand === 'right' ? punchesCaptured.right : 0;

  const signalColor = !cameraLive ? 'var(--enemy)' : samplesGood ? 'var(--good)' : 'var(--warn)';

  return (
    <div className="hs-screen" style={{ fontFamily: 'var(--font-ui)', color: 'var(--ink)' }}>
      <div className="hs-screen__inner hs-stack" style={{ gap: 18, alignItems: 'stretch' }}>
        <div className="hs-stack" style={{ gap: 4, alignItems: 'center', textAlign: 'center' }}>
          <h1 className="hs-title" style={{ fontSize: 62, lineHeight: 0.92, letterSpacing: '0.04em', margin: 0 }}>
            CALIBRATION
          </h1>
          <p className="hs-subtitle" style={{ margin: 0, fontSize: 13, letterSpacing: '0.22em' }}>
            Position yourself comfortably in front of the camera.
          </p>
        </div>

        {/* Overall run of the flow, so the player can see the end from the start. */}
        <div className="hs-stack" style={{ gap: 6 }}>
          <div className="hs-spread" style={{ alignItems: 'baseline' }}>
            <span className="hs-label" style={{ fontSize: 9 }}>OVERALL</span>
            <span className="hs-num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-dim)' }}>
              {Math.round(clamp01(progress) * 100)}%
            </span>
          </div>
          <div
            className="hs-meter"
            style={{ position: 'relative', overflow: 'hidden', height: 4, borderRadius: 2, backgroundColor: 'var(--panel2)' }}
          >
            <div
              className="hs-meter__fill"
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: `${clamp01(progress) * 100}%`,
                backgroundColor: 'var(--player)',
                transition: 'width 200ms ease-out',
              }}
            />
          </div>
        </div>

        <div className="hs-row" style={{ gap: 22, alignItems: 'stretch' }}>
          <div
            className="hs-panel hs-panel--flush"
            style={{
              position: 'relative',
              width: 520,
              flexShrink: 0,
              aspectRatio: '4 / 3',
              overflow: 'hidden',
              borderRadius: 'var(--r-lg)',
              backgroundColor: 'var(--bg2)',
              border: '1px solid var(--edge)',
              boxShadow: samplesGood ? 'var(--glow-player)' : 'var(--shadow-2)',
              transition: 'box-shadow 260ms ease-out',
            }}
          >
            {/* `contain` here on purpose: during calibration the player needs
                to see the entire area the camera can actually track, not a
                flattering crop of it. */}
            <CameraFeed controller={controller} mirrored={mirrored} fit="contain" overlay labels />
            <CornerBrackets />
            <div className="hs-scanlines" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />

            <div
              style={{
                position: 'absolute',
                top: 12,
                left: 12,
                display: 'flex',
                gap: 6,
                pointerEvents: 'none',
              }}
            >
              <TrackChip label="LEFT" on={tracking.leftHand} color="#31e6c8" />
              <TrackChip label="RIGHT" on={tracking.rightHand} color="#ffd34d" />
              <TrackChip label="BODY" on={tracking.pose} color="#7c5cff" />
            </div>
            {liveHint && (
              <div
                style={{
                  position: 'absolute',
                  left: 12,
                  right: 12,
                  bottom: 12,
                  padding: '8px 12px',
                  borderRadius: 'var(--r-sm)',
                  backgroundColor: 'rgba(6,7,13,0.82)',
                  border: '1px solid var(--edge2)',
                  backdropFilter: 'blur(6px)',
                  fontSize: 12,
                  letterSpacing: '0.06em',
                  color: 'var(--warn)',
                  textAlign: 'center',
                }}
              >
                {liveHint}
              </div>
            )}
          </div>

          <div className="hs-stack" style={{ flex: 1, gap: 16, minWidth: 0, justifyContent: 'center' }}>
            {done ? (
              <div className="hs-panel hs-stack" style={{ gap: 12, padding: 20 }}>
                <div className="hs-row" style={{ alignItems: 'center', gap: 10 }}>
                  <Check />
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 34,
                      lineHeight: 1,
                      letterSpacing: '0.04em',
                      color: 'var(--good)',
                    }}
                  >
                    CALIBRATION COMPLETE
                  </span>
                </div>
                <p className="hs-hint" style={{ margin: 0 }}>
                  {punchesMeasured
                    ? 'Your reach, stance and punch speed are locked in. Thresholds now scale to your body, so standing closer or further from the camera will not change how the game reads you.'
                    : 'Your reach and stance are locked in. Too few punches were measured, so punch detection will use the built-in defaults — those work fine, but recalibrating will tune them to you.'}
                </p>

                {/* Per-step outcome rather than a row of unconditional ticks:
                    the punch steps genuinely can come up empty. */}
                <div className="hs-stack" style={{ gap: 6 }}>
                  {steps.map((s) => {
                    const isPunchStep = s.id === 'left' || s.id === 'right';
                    const count = s.id === 'left' ? punchesCaptured.left : punchesCaptured.right;
                    const ok = !isPunchStep || count > 0;
                    return (
                      <div key={s.id} className="hs-spread" style={{ alignItems: 'center', gap: 9 }}>
                        <span className="hs-row" style={{ alignItems: 'center', gap: 9 }}>
                          {ok ? <Check /> : <Dash />}
                          <span className="hs-label" style={{ color: 'var(--ink-dim)' }}>{s.title}</span>
                        </span>
                        {isPunchStep && (
                          <span
                            className="hs-num"
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              color: count > 0 ? 'var(--good)' : 'var(--warn)',
                            }}
                          >
                            {count > 0 ? `${count} measured` : 'none — using defaults'}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="hs-btn hs-btn--primary"
                  onClick={onFinish}
                  style={{ alignSelf: 'flex-start', marginTop: 4 }}
                >
                  CONTINUE
                </button>
              </div>
            ) : (
              <>
                <div className="hs-row" style={{ alignItems: 'center', gap: 18 }}>
                  <CountdownRing
                    progress={stepProgress}
                    seconds={current?.seconds ?? 0}
                    good={samplesGood}
                  />
                  <div className="hs-stack" style={{ gap: 6, minWidth: 0 }}>
                    <span className="hs-label" style={{ fontSize: 9 }}>
                      STEP {index + 1} / {Math.max(1, steps.length)}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 40,
                        lineHeight: 0.98,
                        letterSpacing: '0.03em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {current?.title ?? 'READY'}
                    </span>
                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--ink-dim)' }}>
                      {current?.instruction ?? 'Hold still while the camera finds you.'}
                    </p>
                  </div>
                </div>

                <div className="hs-row" style={{ gap: 7, alignItems: 'center' }}>
                  {steps.map((s, i) => (
                    <span
                      key={s.id}
                      className={i <= index ? 'hs-dot hs-dot--on' : 'hs-dot hs-dot--off'}
                      title={s.title}
                      style={{
                        display: 'block',
                        height: 4,
                        flex: 1,
                        borderRadius: 2,
                        backgroundColor: i < index ? 'var(--player)' : i === index ? 'var(--ink)' : 'var(--edge2)',
                        opacity: i > index ? 0.7 : 1,
                        transition: 'background-color 200ms ease-out',
                      }}
                    />
                  ))}
                </div>

                {/* The punch steps advance on a timer whether or not anything
                    was measured, so this is the only signal the player gets
                    that their punches are actually landing in the profile. */}
                {activeHand && (
                  <div
                    className="hs-row"
                    style={{
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '10px 14px',
                      borderRadius: 'var(--r-md)',
                      border: `1px solid ${activeCount >= MIN_PUNCHES ? 'var(--good)' : 'var(--edge2)'}`,
                      backgroundColor: 'var(--panel)',
                      transition: 'border-color 200ms ease-out',
                    }}
                  >
                    <span className="hs-label" style={{ color: 'var(--ink-dim)' }}>
                      {activeHand === 'left' ? 'LEFT' : 'RIGHT'} PUNCHES CAPTURED
                    </span>
                    <span className="hs-row" style={{ alignItems: 'center', gap: 6 }}>
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            backgroundColor: activeCount > i ? 'var(--good)' : 'var(--edge2)',
                            boxShadow: activeCount > i ? '0 0 8px var(--good)' : 'none',
                            transition: 'background-color 140ms ease-out',
                          }}
                        />
                      ))}
                      <span
                        className="hs-num"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 15,
                          fontWeight: 700,
                          marginLeft: 4,
                          color: activeCount >= MIN_PUNCHES ? 'var(--good)' : 'var(--ink)',
                        }}
                      >
                        {activeCount}
                      </span>
                    </span>
                  </div>
                )}

                <div
                  className="hs-row"
                  style={{
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderRadius: 'var(--r-md)',
                    border: `1px solid ${!cameraLive ? 'var(--enemy)' : samplesGood ? 'var(--edge2)' : 'var(--warn)'}`,
                    backgroundColor: 'var(--panel)',
                  }}
                >
                  <span
                    className="hs-dot"
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      display: 'block',
                      backgroundColor: signalColor,
                      boxShadow: `0 0 9px ${signalColor}`,
                    }}
                  />
                  <span
                    className="hs-value"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.1em',
                      color: signalColor,
                    }}
                  >
                    {!cameraLive
                      ? cameraStatus === 'error'
                        ? 'CAMERA BLOCKED — CALIBRATION PAUSED'
                        : 'WAITING FOR CAMERA…'
                      : samplesGood
                        ? 'SIGNAL GOOD — SAMPLING'
                        : 'WAITING FOR A CLEAN READ'}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="hs-divider" style={{ height: 1, backgroundColor: 'var(--edge)' }} />

        <div className="hs-spread" style={{ alignItems: 'center' }}>
          <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" onClick={onCancel}>
            CANCEL
          </button>
          <div className="hs-row" style={{ alignItems: 'center', gap: 12 }}>
            <span className="hs-subtitle" style={{ fontSize: 10, letterSpacing: '0.16em', color: 'var(--ink-faint)' }}>
              Defaults work fine — calibration just makes them yours.
            </span>
            <button type="button" className="hs-btn hs-btn--ghost" onClick={onSkip}>
              SKIP CALIBRATION
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Calibration;
