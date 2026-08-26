import type { CSSProperties } from 'react';

/**
 * The in-fight modal. It covers two very different situations with one shape:
 * a pause the player asked for, and a pause the tracking forced on them.
 *
 * The tracking variant intentionally has no RESUME control — the fight restarts
 * itself the moment the camera sees the player again, and offering a button the
 * engine will beat to the punch would just teach players to distrust it.
 */

export interface PauseMenuProps {
  open: boolean;
  reason: 'user' | 'tracking';
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onSettings(): void;
}

const backdropStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  backgroundColor: 'rgba(4, 5, 10, 0.68)',
  backdropFilter: 'blur(14px) saturate(0.7)',
};

const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 'clamp(2.1rem, 4.4vw, 3.1rem)',
  lineHeight: 0.92,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
};

const buttonStyle: CSSProperties = { width: '100%' };

export function PauseMenu({ open, reason, onResume, onRestart, onQuit, onSettings }: PauseMenuProps) {
  if (!open) return null;

  const tracking = reason === 'tracking';
  const accent = tracking ? 'var(--warn)' : 'var(--player)';
  const accentRgb = tracking ? '255, 176, 32' : '49, 230, 200';
  const title = tracking ? 'TRACKING LOST' : 'PAUSED';

  return (
    <div
      className="hs-interactive hs-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={backdropStyle}
    >
      <div
        className="hs-panel hs-pop"
        style={{
          width: 'min(400px, 92vw)',
          padding: '26px 26px 22px',
          textAlign: 'center',
          borderColor: `rgba(${accentRgb}, 0.28)`,
          boxShadow: `inset 0 1px 0 rgba(var(--ink-rgb), 0.06), 0 0 60px -24px rgba(${accentRgb}, 0.7), var(--shadow-2)`,
        }}
      >
        <div className="hs-stack" style={{ gap: 6, alignItems: 'center' }}>
          <span className="hs-subtitle" style={{ fontSize: 10, letterSpacing: '0.4em', color: accent }}>
            {tracking ? 'VISION' : 'MATCH'}
          </span>
          <h2
            style={{
              ...titleStyle,
              color: accent,
              textShadow: `0 0 34px rgba(${accentRgb}, 0.4)`,
            }}
          >
            {title}
          </h2>
        </div>

        <div className="hs-divider" style={{ margin: '18px 0 16px' }} />

        {tracking ? (
          <div className="hs-stack" style={{ gap: 12, alignItems: 'center', marginBottom: 20 }}>
            <p style={{ fontSize: 15, color: 'var(--ink)', letterSpacing: '0.01em' }}>
              Please return to the camera.
            </p>
            <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-dim)' }}>
              Combat is paused and your opponent cannot attack while you are out of
              frame. The fight resumes on its own the moment you are picked up again.
            </p>
            <div className="hs-row" style={{ gap: 8, alignItems: 'center' }}>
              {/* Borrowing the global pulse keyframe: a still dot reads as "stuck". */}
              <span className="hs-dot hs-dot--warn" style={{ animation: 'pulse 1.6s ease-in-out infinite' }} />
              <span className="hs-label" style={{ fontSize: 9, letterSpacing: '0.24em', color: 'var(--warn)' }}>
                SEARCHING FOR YOU
              </span>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-dim)', marginBottom: 20 }}>
            The round clock is stopped. Take your time.
          </p>
        )}

        <div className="hs-stack" style={{ gap: 9 }}>
          {!tracking && (
            <button type="button" className="hs-btn hs-btn--primary" style={buttonStyle} onClick={onResume}>
              RESUME
            </button>
          )}
          <button type="button" className="hs-btn" style={buttonStyle} onClick={onRestart}>
            RESTART
          </button>
          <button type="button" className="hs-btn" style={buttonStyle} onClick={onSettings}>
            SETTINGS
          </button>
          <button type="button" className="hs-btn hs-btn--danger" style={buttonStyle} onClick={onQuit}>
            QUIT TO MENU
          </button>
        </div>

        {!tracking && (
          <div
            className="hs-row"
            style={{ gap: 7, justifyContent: 'center', marginTop: 16, color: 'var(--ink-faint)' }}
          >
            <span className="hs-kbd">ESC</span>
            <span className="hs-label" style={{ fontSize: 9 }}>TO RESUME</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default PauseMenu;
