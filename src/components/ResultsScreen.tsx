import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { RadialStat, Sparkline, SplitBar, StatBig, StatRow, BarStat } from '@/components/StatBits';
import type { FightResult } from '@/store/appState';
import type { FightIQ, FightStats } from '@/types';
import { clamp } from '@/utils/math';

/**
 * Post-fight analytics.
 *
 * The engine hands over raw counters; everything a reader actually cares about
 * (accuracy, per-hand power, combo shape) is derived here. Every derivation is
 * written to survive an empty fight — a bout where nothing was thrown must read
 * as a row of honest zeroes, never as NaN or Infinity leaking into the DOM.
 */

export interface ResultsScreenProps {
  result: FightResult;
  onRematch(): void;
  onChangeOpponent(): void;
  onMainMenu(): void;
  onContinueCareer?: () => void;
}

/* -------------------------------------------------------------------------- */
/* numeric guards                                                             */
/* -------------------------------------------------------------------------- */

const n = (v: number | undefined | null): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Strip anything non-numeric out of a sample array before it reaches a chart. */
const samples = (v: readonly number[] | undefined | null): number[] => {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
  return out;
};

const average = (xs: number[]): number => {
  if (!xs.length) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
};

const peak = (xs: number[]): number => {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
};

const int = (v: number): string => String(Math.round(n(v)));
const pct = (v: number): string => `${Math.round(clamp(n(v), 0, 100))}%`;
const one = (v: number): string => n(v).toFixed(1);

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.round(n(ms) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const upper = (v: string | undefined | null): string =>
  typeof v === 'string' && v.trim() ? v.toUpperCase() : '—';

/* -------------------------------------------------------------------------- */
/* presentation tables                                                        */
/* -------------------------------------------------------------------------- */

const OUTCOME: Record<FightResult['outcome'], { word: string; accent: string }> = {
  victory: { word: 'VICTORY', accent: 'var(--good)' },
  defeat: { word: 'DEFEAT', accent: 'var(--enemy)' },
  draw: { word: 'DRAW', accent: 'var(--warn)' },
};

const METHOD: Record<FightResult['method'], string> = {
  KO: 'KNOCKOUT',
  TKO: 'TECHNICAL KNOCKOUT',
  DECISION: "JUDGES' DECISION",
};

const soft = (accent: string, amount: number): string =>
  `color-mix(in srgb, ${accent} ${amount}%, transparent)`;

/* -------------------------------------------------------------------------- */
/* local building blocks                                                      */
/* -------------------------------------------------------------------------- */

/** A well cut into a panel. Darker than its host so the grid reads as inset. */
function Cell(props: { title: string; accent: string; span?: number; children: ReactNode }): JSX.Element {
  const { title, accent, span, children } = props;
  const style: CSSProperties = {
    gridColumn: span && span > 1 ? `span ${span}` : undefined,
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
    minWidth: 0,
    padding: '10px 13px 12px',
    borderRadius: 'var(--r-md)',
    border: '1px solid var(--edge)',
    background: 'linear-gradient(180deg, rgba(0,0,0,.34), rgba(0,0,0,.12))',
  };
  return (
    <section style={style}>
      <div className="hs-row" style={{ gap: 8 }}>
        <span
          aria-hidden="true"
          style={{
            width: 3,
            height: 11,
            flex: '0 0 3px',
            borderRadius: 2,
            background: accent,
            boxShadow: `0 0 10px ${soft(accent, 80)}`,
          }}
        />
        <h3 className="hs-label" style={{ color: 'var(--ink-dim)', letterSpacing: '.2em' }}>
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

function HandPower(props: { label: string; accent: string; values: number[] }): JSX.Element {
  const { label, accent, values } = props;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div className="hs-spread" style={{ gap: 8 }}>
        <span className="hs-label" style={{ color: accent }}>{label}</span>
        <span className="hs-value hs-num" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
          {values.length} THROWN
        </span>
      </div>
      <Sparkline values={values} accent={accent} height={26} />
      <div className="hs-row" style={{ gap: 16 }}>
        <span className="hs-row" style={{ gap: 6 }}>
          <span className="hs-label">AVG</span>
          <span className="hs-value hs-num" style={{ fontSize: 13 }}>{int(average(values))}</span>
        </span>
        <span className="hs-row" style={{ gap: 6 }}>
          <span className="hs-label">BEST</span>
          <span className="hs-value hs-num" style={{ fontSize: 13, color: accent }}>{int(peak(values))}</span>
        </span>
      </div>
    </div>
  );
}

function Pips(props: { won: number; total: number; color: string; align: 'start' | 'end' }): JSX.Element {
  const { won, total, color, align } = props;
  const slots: number[] = [];
  for (let i = 0; i < total; i += 1) slots.push(i);
  return (
    <div
      className="hs-row"
      style={{ gap: 5, flexDirection: align === 'end' ? 'row-reverse' : 'row' }}
      aria-label={`${won} of ${total} rounds`}
    >
      {slots.map((i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 24,
            height: 5,
            borderRadius: 3,
            background: i < won ? color : 'var(--edge)',
            boxShadow: i < won ? `0 0 12px ${soft(color, 65)}` : 'none',
          }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* screen                                                                     */
/* -------------------------------------------------------------------------- */

export function ResultsScreen(props: ResultsScreenProps): JSX.Element {
  const { result, onRematch, onChangeOpponent, onMainMenu, onContinueCareer } = props;

  // Treated as partial so a truncated payload degrades to zeroes instead of throwing.
  const stats: Partial<FightStats> = result.stats ?? {};
  const iq: Partial<FightIQ> = result.iq ?? {};

  const outcome = OUTCOME[result.outcome] ?? OUTCOME.draw;
  const accent = outcome.accent;
  const methodLabel = METHOD[result.method] ?? 'DECISION';
  const methodLine =
    result.outcome === 'victory'
      ? `WIN BY ${methodLabel}`
      : result.outcome === 'defeat'
        ? `LOSS BY ${methodLabel}`
        : `DRAW · ${methodLabel}`;

  const landed = n(stats.landed);
  const missed = n(stats.missed);
  const thrown = landed + missed;
  const accuracy = thrown > 0 ? (landed / thrown) * 100 : 0;

  const leftPower = samples(stats.powerByHand?.left);
  const rightPower = samples(stats.powerByHand?.right);
  const combos = samples(stats.comboLengths);
  const avgCombo = average(combos);

  const roundsWon = result.roundsWon ?? { player: 0, enemy: 0 };
  const playerRounds = Math.max(0, Math.round(n(roundsWon.player)));
  const enemyRounds = Math.max(0, Math.round(n(roundsWon.enemy)));
  const roundReached = Math.max(1, Math.round(n(result.roundReached)));
  const totalRounds = Math.max(roundReached, playerRounds + enemyRounds, 1);

  const career = result.career;
  const careerNote = career?.completed
    ? 'LADDER COMPLETE — THE BELT IS YOURS'
    : career?.newRank
      ? `PROMOTED TO ${career.newRank}`
      : career?.advanced
        ? 'ADVANCED TO THE NEXT CONTENDER'
        : null;

  const primaryAction = onContinueCareer ?? onRematch;

  // Arcade screens are expected to answer to the keyboard: Enter takes the
  // headline action, Escape always backs out to the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onMainMenu();
        return;
      }
      if (e.key === 'Enter') {
        // A focused button already fires on Enter; don't double-activate.
        if (document.activeElement instanceof HTMLButtonElement) return;
        e.preventDefault();
        primaryAction();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onMainMenu, primaryAction]);

  return (
    <div className="hs-screen">
      <div className="hs-scanlines" aria-hidden="true" />

      <div
        className="hs-screen__inner"
        style={{ maxWidth: 1240, maxHeight: '100%', minHeight: 0, gap: 12 }}
      >
        {/* 1 — verdict banner ------------------------------------------------ */}
        <header
          className="hs-panel hs-pop"
          style={{
            padding: '14px 22px',
            borderColor: soft(accent, 34),
            boxShadow: `inset 0 1px 0 rgba(var(--ink-rgb),.06), 0 24px 60px -30px ${soft(accent, 70)}, var(--shadow-2)`,
            flex: '0 0 auto',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 1,
              borderRadius: 'var(--r-lg)',
              pointerEvents: 'none',
              background: `radial-gradient(115% 170% at 0% 55%, ${soft(accent, 13)}, transparent 60%)`,
            }}
          />
          <div className="hs-spread" style={{ position: 'relative', gap: 20, alignItems: 'center' }}>
            <div className="hs-row" style={{ gap: 16, alignItems: 'stretch' }}>
              <span
                aria-hidden="true"
                style={{
                  width: 4,
                  flex: '0 0 4px',
                  borderRadius: 2,
                  background: accent,
                  boxShadow: `0 0 24px ${soft(accent, 85)}`,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <h1
                  className="hs-title"
                  style={{
                    fontSize: 'clamp(2.6rem, 7.4vh, 4.6rem)',
                    letterSpacing: '0.015em',
                    backgroundImage: `linear-gradient(180deg, var(--ink) 0%, ${accent} 58%, ${soft(accent, 42)} 100%)`,
                    textShadow: `0 0 28px ${soft(accent, 40)}, 0 0 78px ${soft(accent, 22)}`,
                  }}
                >
                  {outcome.word}
                </h1>
                <p className="hs-subtitle" style={{ color: accent, letterSpacing: '0.3em' }}>
                  {methodLine}
                </p>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 6,
                minWidth: 0,
              }}
            >
              <span className="hs-label">OPPONENT</span>
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(1.3rem, 2.2vw, 1.9rem)',
                  letterSpacing: '0.05em',
                  lineHeight: 1,
                  textTransform: 'uppercase',
                  color: 'var(--ink)',
                }}
              >
                {upper(result.enemyName)}
              </span>
              <div className="hs-row" style={{ gap: 8 }}>
                <span className="hs-chip" style={{ color: 'var(--warn)', borderColor: soft('var(--warn)', 34) }}>
                  {upper(result.difficulty)}
                </span>
                <span className="hs-badge">
                  <span className="hs-label" style={{ color: 'var(--ink-faint)' }}>TIME</span>
                  <span className="hs-num">{mmss(n(stats.fightDurationMs))}</span>
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* 2 + 3 — the analytics stack. This is the only part allowed to
            scroll, so the verdict and the actions never leave the viewport. */}
        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingRight: 4,
          }}
        >
          <section className="hs-panel hs-slide-up" style={{ padding: 14 }}>
            <div className="hs-spread" style={{ marginBottom: 12, gap: 12 }}>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 20,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--ink)',
                }}
              >
                Fight Data
              </h2>
              <span className="hs-badge">
                <span className="hs-label" style={{ color: 'var(--ink-faint)' }}>THROWN</span>
                <span className="hs-num" style={{ color: 'var(--player)' }}>{int(thrown)}</span>
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 12,
              }}
            >
              <Cell title="PUNCHES" accent="var(--player)">
                <div className="hs-row" style={{ gap: 12, alignItems: 'center' }}>
                  <RadialStat label="ACCURACY" value={accuracy} max={100} accent="var(--player)" size={86} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <StatRow label="LANDED" value={landed} accent="var(--good)" />
                    <StatRow label="MISSED" value={missed} accent="var(--ink-dim)" />
                    <StatRow label="GUARDED" value={n(stats.blockedByOpponent)} accent="var(--warn)" />
                    <StatRow label="RATIO" value={pct(accuracy)} accent="var(--player)" />
                  </div>
                </div>
              </Cell>

              <Cell title="DAMAGE" accent="var(--enemy)">
                <SplitBar
                  label="DEALT VS TAKEN"
                  left={n(stats.damageDealt)}
                  right={n(stats.damageTaken)}
                  leftLabel="DEALT"
                  rightLabel="TAKEN"
                  leftColor="var(--player)"
                  rightColor="var(--enemy)"
                />
                <div>
                  <StatRow label="KNOCKDOWNS SCORED" value={n(stats.knockdownsScored)} accent="var(--crit)" />
                  <StatRow label="KNOCKDOWNS TAKEN" value={n(stats.knockdownsTaken)} accent="var(--enemy)" />
                  <StatRow label="NET DAMAGE" value={Math.round(n(stats.damageDealt) - n(stats.damageTaken))} />
                </div>
              </Cell>

              <Cell title="DEFENCE" accent="var(--counter)">
                <div>
                  <StatRow label="BLOCKS" value={n(stats.blocks)} />
                  <StatRow label="DODGES" value={n(stats.dodges)} />
                  <StatRow label="PERFECT BLOCKS" value={n(stats.perfectBlocks)} accent="var(--crit)" />
                  <StatRow label="PERFECT DODGES" value={n(stats.perfectDodges)} accent="var(--crit)" />
                  <StatRow label="COUNTERS" value={n(stats.counters)} accent="var(--counter)" />
                </div>
              </Cell>

              <Cell title="COMBOS" accent="var(--rage)">
                <div className="hs-row" style={{ gap: 14, alignItems: 'flex-start' }}>
                  <StatBig
                    label="BEST CHAIN"
                    value={Math.round(n(stats.bestCombo))}
                    unit="HITS"
                    accent="var(--rage)"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Sparkline values={combos} accent="var(--rage)" height={30} />
                    <StatRow label="CHAINS" value={combos.length} />
                    <StatRow label="AVERAGE" value={one(avgCombo)} accent="var(--rage)" />
                  </div>
                </div>
              </Cell>

              <Cell title="POWER" accent="var(--crit)" span={2}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, .72fr) minmax(0, 1fr) minmax(0, 1fr)',
                    gap: 16,
                    alignItems: 'flex-start',
                  }}
                >
                  <StatBig
                    label="PEAK STRIKE"
                    value={Math.round(n(stats.highestPower))}
                    unit="PWR"
                    accent="var(--crit)"
                    sub="Highest recorded"
                  />
                  <HandPower label="LEFT PUNCH" accent="var(--player)" values={leftPower} />
                  <HandPower label="RIGHT PUNCH" accent="var(--counter)" values={rightPower} />
                </div>
              </Cell>
            </div>
          </section>

          <section className="hs-panel hs-slide-up" style={{ padding: 14 }}>
            <div className="hs-spread" style={{ marginBottom: 12, gap: 12 }}>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 20,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--ink)',
                }}
              >
                Player Fight IQ
              </h2>
              <span className="hs-label">READ FROM YOUR OWN TENDENCIES</span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
                gap: '12px 26px',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: '10px 20px',
                }}
              >
                <BarStat label="AGGRESSION" value={n(iq.aggression)} max={100} accent="var(--rage)" suffix="%" />
                <BarStat label="DEFENSE" value={n(iq.defense)} max={100} accent="var(--player)" suffix="%" />
                <BarStat label="COUNTERING" value={n(iq.countering)} max={100} accent="var(--counter)" suffix="%" />
                <BarStat label="ACCURACY" value={n(iq.accuracy)} max={100} accent="var(--crit)" suffix="%" />
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  minWidth: 0,
                  paddingLeft: 20,
                  borderLeft: '1px solid var(--edge)',
                }}
              >
                <StatRow label="ATTACK PREFERENCE" value={upper(iq.favouriteAttack)} accent="var(--crit)" />
                <StatRow label="PREFERRED HAND" value={upper(iq.preferredHand)} accent="var(--player)" />
                <StatRow label="AVERAGE COMBO" value={one(n(iq.averageCombo))} accent="var(--rage)" />
                <StatRow label="DODGE PREFERENCE" value={upper(iq.dodgePreference)} accent="var(--counter)" />
              </div>
            </div>
          </section>
        </div>

        {/* 4 — round summary ------------------------------------------------- */}
        <div className="hs-spread" style={{ flex: '0 0 auto', gap: 16, padding: '0 4px' }}>
          <div className="hs-row" style={{ gap: 12 }}>
            <span className="hs-label" style={{ color: 'var(--player)' }}>YOU</span>
            <Pips won={playerRounds} total={totalRounds} color="var(--player)" align="start" />
            <span className="hs-value hs-num" style={{ color: 'var(--player)' }}>{playerRounds}</span>
          </div>

          <span className="hs-chip">
            ROUND <span className="hs-num" style={{ color: 'var(--ink)' }}>{roundReached}</span> OF{' '}
            <span className="hs-num" style={{ color: 'var(--ink)' }}>{totalRounds}</span>
          </span>

          <div className="hs-row" style={{ gap: 12 }}>
            <span className="hs-value hs-num" style={{ color: 'var(--enemy)' }}>{enemyRounds}</span>
            <Pips won={enemyRounds} total={totalRounds} color="var(--enemy)" align="end" />
            <span className="hs-label" style={{ color: 'var(--enemy)' }}>{upper(result.enemyName)}</span>
          </div>
        </div>

        {/* 5 — career callout + actions --------------------------------------- */}
        {careerNote ? (
          <div
            className="hs-pop"
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              borderRadius: 'var(--r-md)',
              border: `1px solid ${soft('var(--crit)', 45)}`,
              background: `linear-gradient(90deg, ${soft('var(--crit)', 16)}, transparent 70%)`,
              boxShadow: `0 0 34px -12px ${soft('var(--crit)', 80)}`,
            }}
          >
            <span
              className="hs-dot hs-dot--on"
              style={{ background: 'var(--crit)', boxShadow: '0 0 12px var(--crit)' }}
              aria-hidden="true"
            />
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 18,
                letterSpacing: '0.12em',
                color: 'var(--crit)',
              }}
            >
              {careerNote}
            </span>
          </div>
        ) : null}

        <div className="hs-spread" style={{ flex: '0 0 auto', gap: 12 }}>
          <div className="hs-row" style={{ gap: 10 }}>
            <button
              type="button"
              className={`hs-btn${onContinueCareer ? '' : ' hs-btn--primary'}`}
              onClick={onRematch}
            >
              REMATCH
            </button>
            <button type="button" className="hs-btn" onClick={onChangeOpponent}>
              CHANGE OPPONENT
            </button>
            <button type="button" className="hs-btn hs-btn--ghost" onClick={onMainMenu}>
              MAIN MENU
            </button>
          </div>

          <div className="hs-row" style={{ gap: 12 }}>
            <span className="hs-label" style={{ color: 'var(--ink-faint)' }}>
              <span className="hs-kbd">ENTER</span> CONFIRM
              <span style={{ margin: '0 8px', color: 'var(--edge2)' }}>/</span>
              <span className="hs-kbd">ESC</span> MENU
            </span>
            {onContinueCareer ? (
              <button type="button" className="hs-btn hs-btn--primary" onClick={onContinueCareer}>
                CONTINUE CAREER
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResultsScreen;
