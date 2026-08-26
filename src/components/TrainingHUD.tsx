import type { TrainingHudState } from '@/game/TrainingMode';

export interface TrainingHUDProps {
  state: TrainingHudState;
  onQuit(): void;
}

const TONE_COLOR: Record<TrainingHudState['promptTone'], string> = {
  neutral: 'var(--ink)',
  good: 'var(--good)',
  bad: 'var(--enemy)',
};

const fmtTime = (s: number): string => {
  const total = Math.max(0, Math.ceil(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function TrainingHUD({ state, onQuit }: TrainingHUDProps): JSX.Element {
  const power = Math.round(state.strikePower);
  const segments = 14;
  const filled = Math.round((power / 100) * segments);

  return (
    <div className="hs-overlay" style={{ padding: 20 }}>
      {/* Top bar */}
      <div className="hs-spread" style={{ alignItems: 'flex-start' }}>
        <div className="hs-panel" style={{ padding: '12px 18px', minWidth: 230 }}>
          <div className="hs-label">TRAINING</div>
          <div className="hs-num" style={{ fontSize: 30, fontWeight: 700, color: 'var(--player)' }}>
            {state.score.toLocaleString()}
          </div>
          <div className="hs-row" style={{ gap: 14, marginTop: 6 }}>
            <span className="hs-label">
              HIT <span className="hs-num" style={{ color: 'var(--good)' }}>{state.hits}</span>
            </span>
            <span className="hs-label">
              MISS <span className="hs-num" style={{ color: 'var(--enemy)' }}>{state.misses}</span>
            </span>
            <span className="hs-label">
              ACC <span className="hs-num">{Math.round(state.accuracy)}%</span>
            </span>
          </div>
        </div>

        <div className="hs-panel" style={{ padding: '10px 22px', textAlign: 'center' }}>
          <div className="hs-label">TIME</div>
          <div
            className="hs-num"
            style={{
              fontSize: 40,
              fontWeight: 700,
              lineHeight: 1,
              color: state.timeLeft <= 10 ? 'var(--enemy)' : 'var(--ink)',
            }}
          >
            {fmtTime(state.timeLeft)}
          </div>
        </div>

        <div className="hs-stack" style={{ gap: 8, alignItems: 'flex-end' }}>
          <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm hs-interactive" onClick={onQuit}>
            END SESSION
          </button>
          <div className="hs-panel" style={{ padding: '10px 16px', minWidth: 190 }}>
            <div className="hs-label">STRIKE POWER</div>
            <div className="hs-row" style={{ gap: 6, alignItems: 'center', marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 2 }}>
                {Array.from({ length: segments }, (_, i) => (
                  <span
                    key={i}
                    style={{
                      width: 5,
                      height: 14,
                      borderRadius: 1,
                      background: i < filled ? 'var(--player)' : 'rgba(255,255,255,0.09)',
                      boxShadow: i < filled ? '0 0 6px rgba(49,230,200,0.6)' : 'none',
                    }}
                  />
                ))}
              </div>
              <span className="hs-num" style={{ fontWeight: 700 }}>{power}</span>
            </div>
            <div className="hs-label" style={{ marginTop: 6 }}>
              REACTION{' '}
              <span className="hs-num">
                {state.lastReactionMs === null ? '—' : `${(state.lastReactionMs / 1000).toFixed(2)}s`}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Combo + prompt */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '38%',
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        {state.prompt && (
          <div
            key={state.prompt}
            className="hs-pop"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 62,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: TONE_COLOR[state.promptTone],
              textShadow: `0 0 32px ${TONE_COLOR[state.promptTone]}`,
            }}
          >
            {state.prompt}
          </div>
        )}
      </div>

      {state.combo >= 2 && (
        <div
          style={{
            position: 'absolute',
            left: 28,
            bottom: 120,
            fontFamily: 'var(--font-display)',
            fontSize: 44,
            fontWeight: 700,
            color: 'var(--crit)',
            textShadow: '0 0 24px rgba(255,211,77,0.6)',
          }}
        >
          COMBO x{state.combo}
        </div>
      )}

      <div
        className="hs-label"
        style={{ position: 'absolute', left: 28, bottom: 84, color: 'var(--ink-faint)' }}
      >
        BEST COMBO <span className="hs-num">{state.bestCombo}</span>
      </div>
    </div>
  );
}

export default TrainingHUD;
