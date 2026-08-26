import type { TrainingRecord, TrainingResult } from '@/store/appState';
import { BarStat, RadialStat, SplitBar, StatBig, StatRow } from './StatBits';

export interface TrainingResultsProps {
  result: TrainingResult;
  /** Bests including this session — drives the PERSONAL BESTS panel. */
  records: TrainingRecord;
  /**
   * Bests as they stood *before* this session. Deltas compare against these,
   * because comparing against an already-updated record always reads zero.
   * Defaults to `records` when the caller has no separate baseline.
   */
  baseline?: TrainingRecord;
  isNewBest: boolean;
  onRetry(): void;
  onMainMenu(): void;
}

/** Small up/down delta chip comparing this session against the stored best. */
function Delta({ value, unit = '', invert = false }: { value: number; unit?: string; invert?: boolean }): JSX.Element | null {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return null;
  // For reaction time, lower is better — invert flips which direction is green.
  const good = invert ? value < 0 : value > 0;
  const arrow = value > 0 ? '▲' : '▼';
  return (
    <span
      className="hs-num"
      style={{ color: good ? 'var(--good)' : 'var(--enemy)', fontSize: 11, marginLeft: 6 }}
    >
      {arrow} {Math.abs(value) < 1 ? Math.abs(value).toFixed(2) : Math.round(Math.abs(value))}
      {unit}
    </span>
  );
}

export function TrainingResults({
  result,
  records,
  baseline,
  isNewBest,
  onRetry,
  onMainMenu,
}: TrainingResultsProps): JSX.Element {
  const prev = baseline ?? records;
  const total = result.targetsHit + result.targetsMissed;
  const accuracy = total > 0 ? result.accuracy : 0;
  const reactionSec = result.avgReactionMs > 0 ? result.avgReactionMs / 1000 : 0;
  const bestReactionSec = result.bestReactionMs > 0 ? result.bestReactionMs / 1000 : 0;
  const prevReactionSec = prev.bestReaction > 0 ? prev.bestReaction / 1000 : 0;

  return (
    <div className="hs-screen">
      <div className="hs-screen__inner hs-stack" style={{ gap: 18 }}>
        <header className="hs-stack hs-fade-in" style={{ gap: 4, textAlign: 'center' }}>
          <div className="hs-subtitle">SESSION COMPLETE</div>
          <h1 className="hs-title" style={{ fontSize: 'clamp(38px, 6vw, 68px)' }}>
            TRAINING RESULT
          </h1>
          {isNewBest && (
            <div
              className="hs-badge hs-pop"
              style={{
                alignSelf: 'center',
                color: 'var(--crit)',
                borderColor: 'var(--crit)',
                boxShadow: '0 0 22px rgba(255,211,77,0.35)',
              }}
            >
              NEW PERSONAL BEST
            </div>
          )}
        </header>

        {/* Headline five */}
        <div
          className="hs-panel hs-slide-up"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 12,
            padding: 20,
            justifyItems: 'center',
          }}
        >
          <RadialStat label="PUNCH SPEED" value={result.punchSpeed} max={100} accent="var(--player)" size={128} />
          <RadialStat label="ACCURACY" value={accuracy} max={100} accent="var(--good)" size={128} />
          <div className="hs-stack" style={{ gap: 2, alignItems: 'center', justifyContent: 'center' }}>
            <StatBig label="REACTION" value={`${reactionSec.toFixed(2)}s`} accent="var(--warn)" sub={`best ${bestReactionSec.toFixed(2)}s`} />
            <Delta value={prevReactionSec > 0 ? reactionSec - prevReactionSec : 0} unit="s" invert />
          </div>
          <div className="hs-stack" style={{ gap: 2, alignItems: 'center', justifyContent: 'center' }}>
            <StatBig label="BEST COMBO" value={result.bestCombo} accent="var(--crit)" />
            <Delta value={result.bestCombo - prev.bestCombo} />
          </div>
          <RadialStat label="DEFENSE" value={result.defense} max={100} accent="var(--counter)" size={128} />
        </div>

        {/* Detail */}
        <div
          className="hs-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}
        >
          <section className="hs-panel" style={{ padding: 16 }}>
            <div className="hs-label" style={{ marginBottom: 8 }}>TARGETS</div>
            <StatRow label="Hit" value={result.targetsHit} accent="var(--good)" />
            <StatRow label="Missed" value={result.targetsMissed} accent="var(--enemy)" />
            <StatRow label="Total" value={total} />
            <div style={{ marginTop: 10 }}>
              <BarStat label="Accuracy" value={accuracy} suffix="%" accent="var(--good)" />
            </div>
          </section>

          <section className="hs-panel" style={{ padding: 16 }}>
            <div className="hs-label" style={{ marginBottom: 8 }}>POWER</div>
            <StatRow label="Average" value={Math.round(result.avgPower)} />
            <StatRow label="Best" value={Math.round(result.bestPower)} accent="var(--crit)" />
            <div style={{ marginTop: 10 }}>
              <SplitBar
                label="Hands used"
                left={result.perHand.left}
                right={result.perHand.right}
                leftLabel="LEFT"
                rightLabel="RIGHT"
              />
            </div>
          </section>

          <section className="hs-panel" style={{ padding: 16 }}>
            <div className="hs-label" style={{ marginBottom: 8 }}>DEFENCE</div>
            <StatRow label="Blocks" value={result.blocks} accent="var(--player)" />
            <StatRow label="Dodges" value={result.dodges} accent="var(--counter)" />
            <StatRow label="Defence rate" value={`${Math.round(result.defense)}%`} />
            <StatRow label="Session length" value={`${Math.round(result.durationSec)}s`} />
          </section>

          <section className="hs-panel" style={{ padding: 16 }}>
            <div className="hs-label" style={{ marginBottom: 8 }}>PERSONAL BESTS</div>
            <StatRow label="Best score" value={Math.max(records.bestScore, result.score)} accent="var(--crit)" />
            <StatRow label="Best accuracy" value={`${Math.round(Math.max(records.bestAccuracy, accuracy))}%`} />
            <StatRow label="Best combo" value={Math.max(records.bestCombo, result.bestCombo)} />
            <StatRow label="Sessions" value={records.sessions} />
          </section>
        </div>

        <div className="hs-row" style={{ justifyContent: 'center', gap: 12, marginTop: 4 }}>
          <button type="button" className="hs-btn hs-btn--primary" onClick={onRetry}>
            TRAIN AGAIN
          </button>
          <button type="button" className="hs-btn hs-btn--ghost" onClick={onMainMenu}>
            MAIN MENU
          </button>
        </div>
      </div>
    </div>
  );
}

export default TrainingResults;
