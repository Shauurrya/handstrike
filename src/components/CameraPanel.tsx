import type { CSSProperties } from 'react';
import { clamp01 } from '@/utils/math';
import type { VisionController } from '@/vision/VisionController';
import CameraFeed from './CameraFeed';

/**
 * The webcam feedback panel. Deliberately quiet: the player should be watching
 * the fight and glance here only to confirm the camera still sees them.
 */

export interface CameraPanelProps {
  controller: VisionController;
  active: boolean;
  mirrored: boolean;
  mode: 'camera' | 'sketch';
  leftHand: boolean;
  rightHand: boolean;
  pose: boolean;
  /** Per-hand openness readout, mirroring the sketch's palm ring. */
  handState: { left: HandChipState; right: HandChipState };
  onToggleMode(): void;
  detected: string | null;
  strikePower: number;
  quality: 'good' | 'partial' | 'lost';
  hint: string | null;
  showLandmarks: boolean;
  collapsed: boolean;
  onToggleCollapse(): void;
}

const PANEL_W = 240;

export interface HandChipState {
  present: boolean;
  fist: boolean;
  /** 0-1 tracker confidence, shown as a percentage. */
  confidence: number;
}

const HAND_COLOR = { left: '#31e6c8', right: '#ffd34d' } as const;

/**
 * "● FIST 98%" pill, one per hand. Named states rather than a raw number
 * because the thing the player needs to confirm is that the game agrees with
 * what their hand is doing.
 */
function HandChip({ side, state }: { side: 'left' | 'right'; state: HandChipState }) {
  const color = HAND_COLOR[side];
  const label = !state.present ? 'NO HAND' : state.fist ? 'FIST' : 'OPEN';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 7px',
        borderRadius: 999,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.1em',
        backgroundColor: 'rgba(6,7,13,0.78)',
        border: `1px solid ${state.present ? color : 'var(--edge2)'}`,
        color: state.present ? color : 'var(--ink-faint)',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          backgroundColor: state.present ? color : 'var(--edge2)',
          boxShadow: state.present ? `0 0 6px ${color}` : 'none',
        }}
      />
      {side === 'left' ? 'L' : 'R'} {label}
      {state.present && (
        <span style={{ color: 'var(--ink-dim)' }}>{Math.round(state.confidence * 100)}%</span>
      )}
    </span>
  );
}

const QUALITY_COLOR: Record<CameraPanelProps['quality'], string> = {
  good: 'var(--good)',
  partial: 'var(--warn)',
  lost: 'var(--enemy)',
};

const dotStyle = (on: boolean, color: string): CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: '50%',
  display: 'block',
  flexShrink: 0,
  backgroundColor: on ? color : 'var(--edge2)',
  boxShadow: on ? `0 0 7px ${color}` : 'none',
});

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ display: 'block', transform: up ? 'rotate(180deg)' : 'none' }}
    >
      <path
        d="M2 4.5 L6 8.5 L10 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusRow({ label, on, color }: { label: string; on: boolean; color: string }) {
  return (
    <div className="hs-spread" style={{ alignItems: 'center' }}>
      <span className="hs-label" style={{ fontSize: 9 }}>{label}</span>
      <span className={on ? 'hs-dot hs-dot--on' : 'hs-dot hs-dot--off'} style={dotStyle(on, color)} />
    </div>
  );
}

export function CameraPanel({
  controller,
  active,
  mirrored,
  mode,
  leftHand,
  rightHand,
  pose,
  handState,
  onToggleMode,
  detected,
  strikePower,
  quality,
  hint,
  showLandmarks,
  collapsed,
  onToggleCollapse,
}: CameraPanelProps) {
  const power = clamp01(strikePower / 100);

  return (
    <div
      style={{
        position: 'absolute',
        right: 18,
        bottom: 18,
        zIndex: 20,
        pointerEvents: 'none',
        fontFamily: 'var(--font-ui)',
        color: 'var(--ink)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      {/*
        One container for both states. Collapsing shrinks the media area to zero
        height instead of unmounting it: the <video> is the sink for the live
        MediaStream and remounting would drop the stream off the element.
      */}
      <div
        className="hs-panel hs-panel--flush"
        style={{
          pointerEvents: 'auto',
          width: collapsed ? 'auto' : PANEL_W,
          overflow: 'hidden',
          backgroundColor: 'rgba(13,15,25,0.86)',
          backdropFilter: 'blur(10px)',
          border: '1px solid var(--edge)',
          borderRadius: collapsed ? 999 : 'var(--r-md)',
          boxShadow: 'var(--shadow-2)',
        }}
      >
        <div
          className="hs-spread"
          style={{
            alignItems: 'center',
            gap: 12,
            padding: collapsed ? '5px 8px 5px 11px' : '7px 9px 7px 10px',
            borderBottom: collapsed ? 'none' : '1px solid var(--edge)',
          }}
        >
          <div className="hs-row" style={{ alignItems: 'center', gap: 7 }}>
            <span style={dotStyle(active, active ? QUALITY_COLOR[quality] : 'var(--enemy)')} />
            <span className="hs-label" style={{ fontSize: 9, letterSpacing: '0.2em' }}>WEBCAM</span>
          </div>
          <div className="hs-row" style={{ alignItems: 'center', gap: 8 }}>
            {!collapsed && (
              <button
                type="button"
                onClick={onToggleMode}
                title={mode === 'camera' ? 'Switch to skeleton sketch' : 'Switch to camera image'}
                aria-label={mode === 'camera' ? 'Switch to skeleton sketch' : 'Switch to camera image'}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  letterSpacing: '0.12em',
                  padding: '2px 6px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  color: 'var(--ink-dim)',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--edge2)',
                }}
              >
                {mode === 'camera' ? 'CAMERA' : 'SKETCH'}
              </button>
            )}
            <button
              type="button"
              className="hs-btn hs-btn--ghost hs-btn--sm"
              onClick={onToggleCollapse}
              title={collapsed ? 'Show camera panel' : 'Hide camera panel'}
              aria-label={collapsed ? 'Show camera panel' : 'Hide camera panel'}
              style={{
                padding: 3,
                lineHeight: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--ink-dim)',
              }}
            >
              <Chevron up={collapsed} />
            </button>
          </div>
        </div>

        {/*
          4:3 via aspect-ratio rather than a fixed height, because the media
          area is narrower than PANEL_W once the panel's own padding and border
          are taken out — hardcoding a height letterboxed the feed inside its
          own box. Matching the sensor's shape also means nothing gets cropped,
          and the parts of the frame a drifting player leaves first are exactly
          the top and bottom.
        */}
        <div
          style={{
            position: 'relative',
            width: collapsed ? 0 : '100%',
            aspectRatio: collapsed ? undefined : '4 / 3',
            height: collapsed ? 0 : undefined,
            overflow: 'hidden',
            backgroundColor: 'var(--bg)',
          }}
        >
          {/* Mounted even while collapsed (the wrapper is 0x0): the draw loop
              is cheap and keeping it alive avoids a blank first frame when the
              player expands the panel mid-round. */}
          <CameraFeed
            controller={controller}
            mirrored={mirrored}
            mode={mode}
            fit="contain"
            overlay={showLandmarks}
            labels={showLandmarks}
            dim={0.12}
          />

          {/* Floating over the feed, like the reference HUD: the state the
              game has decided each hand is in, right next to the skeleton it
              decided it from. */}
          <div
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              right: 6,
              display: 'flex',
              gap: 5,
              flexWrap: 'wrap',
              pointerEvents: 'none',
            }}
          >
            <HandChip side="left" state={handState.left} />
            <HandChip side="right" state={handState.right} />
          </div>

          {quality !== 'good' && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                padding: '5px 8px',
                backgroundColor: quality === 'lost' ? 'rgba(255,45,111,0.85)' : 'rgba(255,176,32,0.85)',
                color: 'var(--bg)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                lineHeight: 1.25,
              }}
            >
              {hint ?? (quality === 'lost' ? 'Tracking lost' : 'Tracking unstable')}
            </div>
          )}
        </div>

        {!collapsed && (
          <div className="hs-stack" style={{ gap: 5, padding: '9px 10px 10px' }}>
            {/* Colours match the overlay exactly, so the dot and the skeleton
                on the feed above are readable as the same thing. */}
            <StatusRow label="LEFT HAND" on={leftHand} color="#31e6c8" />
            <StatusRow label="RIGHT HAND" on={rightHand} color="#ffd34d" />
            <StatusRow label="BODY / POSE" on={pose} color="var(--counter)" />

            <div className="hs-divider" style={{ height: 1, backgroundColor: 'var(--edge)', margin: '2px 0' }} />

            <div className="hs-spread" style={{ alignItems: 'baseline' }}>
              <span className="hs-label" style={{ fontSize: 9 }}>DETECTED</span>
              <span
                className="hs-value"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.05em',
                  color: detected ? 'var(--ink)' : 'var(--ink-faint)',
                  maxWidth: 140,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {detected ?? '—'}
              </span>
            </div>

            <div className="hs-stack" style={{ gap: 4 }}>
              <div className="hs-spread" style={{ alignItems: 'baseline' }}>
                <span className="hs-label" style={{ fontSize: 9 }}>STRIKE POWER</span>
                <span className="hs-num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {Math.round(power * 100)}
                </span>
              </div>
              <div
                className="hs-meter"
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: 'var(--panel2)',
                }}
              >
                <div
                  className="hs-meter__fill"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: `${power * 100}%`,
                    backgroundColor: power > 0.78 ? 'var(--rage)' : power > 0.45 ? 'var(--crit)' : 'var(--player)',
                    transition: 'width 90ms linear',
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CameraPanel;
