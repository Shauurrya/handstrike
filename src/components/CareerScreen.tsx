import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { CareerStage } from '@/data/career';
import type { CareerProgress } from '@/store/appState';
import type { Difficulty, EnemyDef } from '@/types';
import { clamp01 } from '@/utils/math';

export interface CareerScreenProps {
  stages: CareerStage[];
  enemies: EnemyDef[];
  progress: CareerProgress;
  onFight(stageIndex: number): void;
  onBack(): void;
  onReset(): void;
  renderPortrait(styleId: string, size: number): ReactNode;
}

type StageStatus = 'done' | 'current' | 'locked';

/**
 * The ladder reads top-to-bottom as a single climb, so status is expressed in
 * colour before it is expressed in words: green behind you, live cyan where you
 * stand, dead grey ahead. Difficulty keeps its own scale so the two never blur.
 */
const STATUS_ACCENT: Record<StageStatus, string> = {
  done: 'var(--good)',
  current: 'var(--player)',
  locked: 'var(--ink-faint)',
};

const DIFFICULTY_ACCENT: Record<Difficulty, string> = {
  easy: 'var(--good)',
  normal: 'var(--player)',
  hard: 'var(--warn)',
  champion: 'var(--enemy)',
};

const RANK_ACCENT: Record<string, string> = {
  ROOKIE: 'var(--ink-dim)',
  CONTENDER: 'var(--player)',
  PRO: 'var(--counter)',
  CHAMPION: 'var(--crit)',
};

/** Career figures come out of localStorage, so nothing here trusts the number. */
const count = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

const pad2 = (n: number): string => String(n + 1).padStart(2, '0');

const accentGlow = (color: string, strength = 0.34): string =>
  `0 0 0 1px color-mix(in srgb, ${color} 42%, transparent), 0 14px 34px -16px color-mix(in srgb, ${color} ${Math.round(strength * 100)}%, transparent)`;

function CheckIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.2 8.7 6.5 12 12.8 4.6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LockIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.3" y="7" width="9.4" height="6.6" rx="1.7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.6 7V5.1a2.4 2.4 0 0 1 4.8 0V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function BeltIcon({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 20 16" fill="none" aria-hidden="true">
      <path
        d="M1.6 12.6 3.1 4.2 7 8.2 10 2.6 13 8.2 16.9 4.2 18.4 12.6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="color-mix(in srgb, currentColor 18%, transparent)"
      />
      <path d="M2.4 14.6h15.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Spine node. Sits on top of the rail with an opaque core so the line reads as broken by it. */
function SpineNode({ status }: { status: StageStatus }): JSX.Element {
  const accent = STATUS_ACCENT[status];
  const live = status === 'current';
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: live ? 22 : 18,
        height: live ? 22 : 18,
        borderRadius: '50%',
        color: accent,
        background: status === 'locked' ? 'var(--bg)' : `color-mix(in srgb, ${accent} 22%, var(--bg))`,
        border: `2px solid ${status === 'locked' ? 'var(--edge2)' : accent}`,
        boxShadow: status === 'locked' ? 'none' : `0 0 14px -2px ${accent}`,
      }}
    >
      {status === 'done' ? <CheckIcon size={10} /> : null}
      {live ? (
        <span
          className="hs-dot hs-dot--on"
          style={{ width: 7, height: 7, background: accent, boxShadow: `0 0 10px ${accent}` }}
        />
      ) : null}
    </span>
  );
}

function RecordCell({ label, value, accent }: { label: string; value: number; accent: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, paddingRight: 4 }}>
      <span className="hs-label">{label}</span>
      <span
        className="hs-num"
        style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: accent, textShadow: `0 0 18px color-mix(in srgb, ${accent} 40%, transparent)` }}
      >
        {value}
      </span>
    </div>
  );
}

export function CareerScreen({
  stages,
  enemies,
  progress,
  onFight,
  onBack,
  onReset,
  renderPortrait,
}: CareerScreenProps): JSX.Element {
  const [confirmReset, setConfirmReset] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<HTMLLIElement | null>(null);

  const enemyById = useMemo(() => {
    const map = new Map<string, EnemyDef>();
    for (const e of enemies) map.set(e.id, e);
    return map;
  }, [enemies]);

  const total = stages.length;
  const cleared = Math.min(Math.max(0, count(progress.stageIndex)), total);
  const complete = total > 0 && cleared >= total;
  const rank = complete ? 'CHAMPION' : progress.rank;
  const rankColor = RANK_ACCENT[rank] ?? 'var(--player)';
  const ladderPct = total > 0 ? clamp01(cleared / total) * 100 : 0;

  const hasProgress = cleared > 0 || count(progress.wins) > 0 || count(progress.losses) > 0;

  // A disarmed-by-timeout confirm is safer than one that lingers: a stray second
  // click minutes later must not wipe a career.
  useEffect(() => {
    if (!confirmReset) return;
    const id = window.setTimeout(() => setConfirmReset(false), 4000);
    return () => window.clearTimeout(id);
  }, [confirmReset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // Escape backs out of the arming state first, then out of the screen.
      setConfirmReset((armed) => {
        if (!armed) onBack();
        return false;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Park the live bout in the middle of the rail. Measured against the scroll box
  // rather than scrollIntoView, which would also drag the screen behind it.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    if (complete) {
      box.scrollTop = box.scrollHeight;
      return;
    }
    const node = currentRef.current;
    if (!node) return;
    const delta = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop = Math.max(0, box.scrollTop + delta - (box.clientHeight - node.offsetHeight) / 2);
  }, [complete, cleared]);

  const handleReset = (): void => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    onReset();
  };

  return (
    <div className="hs-screen">
      <div className="hs-screen__inner hs-stack" style={{ gap: 14, maxWidth: 1060 }}>
        <header className="hs-spread" style={{ alignItems: 'flex-end' }}>
          <div>
            <h1 className="hs-title" style={{ margin: 0, fontSize: 42, lineHeight: 1 }}>
              CAREER
            </h1>
            <p className="hs-subtitle" style={{ margin: '4px 0 0' }}>
              {total} BOUTS TO THE BELT
            </p>
          </div>
          <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" onClick={onBack}>
            BACK
          </button>
        </header>

        {/* Rank banner + record strip */}
        <section className="hs-panel hs-stack hs-slide-up" style={{ gap: 12, padding: 16 }}>
          <div className="hs-spread" style={{ alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
            <div className="hs-stack" style={{ gap: 0, minWidth: 0 }}>
              <span className="hs-label">CURRENT RANK</span>
              <div className="hs-row" style={{ gap: 12, alignItems: 'center' }}>
                <span style={{ color: rankColor, display: 'inline-flex' }}>
                  <BeltIcon size={30} />
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 46,
                    lineHeight: 0.95,
                    letterSpacing: '0.02em',
                    color: rankColor,
                    textShadow: `0 0 26px color-mix(in srgb, ${rankColor} 40%, transparent)`,
                  }}
                >
                  {rank}
                </span>
              </div>
            </div>

            <div
              className="hs-row"
              style={{ gap: 22, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-end' }}
            >
              <RecordCell label="WINS" value={count(progress.wins)} accent="var(--good)" />
              <RecordCell label="LOSSES" value={count(progress.losses)} accent="var(--enemy)" />
              <RecordCell label="KO WINS" value={count(progress.koWins)} accent="var(--crit)" />
              <RecordCell label="BEST COMBO" value={count(progress.bestCombo)} accent="var(--counter)" />
              <RecordCell label="BEST POWER" value={count(progress.bestPower)} accent="var(--rage)" />
            </div>
          </div>

          <div className="hs-stack" style={{ gap: 5 }}>
            <div className="hs-spread" style={{ alignItems: 'baseline' }}>
              <span className="hs-label">LADDER PROGRESS</span>
              <span className="hs-num" style={{ fontSize: 12, color: rankColor }}>
                {cleared} / {total}
              </span>
            </div>
            <div
              className="hs-meter hs-meter--lg"
              role="img"
              aria-label={`${cleared} of ${total} bouts won`}
            >
              <div className="hs-meter__fill" style={{ width: `${ladderPct}%`, background: rankColor }} />
              {stages.slice(1).map((stage, i) => (
                <span
                  key={`tick-${stage.enemyId}-${i}`}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${((i + 1) / Math.max(1, total)) * 100}%`,
                    width: 2,
                    background: 'rgba(0,0,0,0.65)',
                  }}
                />
              ))}
            </div>
          </div>
        </section>

        {/* The ladder itself. The rail lives inside the scroller so it travels with the rows. */}
        <div
          ref={scrollRef}
          style={{
            position: 'relative',
            overflowY: 'auto',
            overflowX: 'hidden',
            maxHeight: 'min(46vh, 420px)',
            paddingRight: 4,
          }}
        >
          <ol style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 20,
                top: 12,
                bottom: 12,
                width: 2,
                borderRadius: 2,
                background: 'linear-gradient(180deg, var(--edge2), var(--edge) 70%, transparent)',
              }}
            />
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 20,
                top: 12,
                height: `calc((100% - 24px) * ${ladderPct / 100})`,
                width: 2,
                borderRadius: 2,
                background: `linear-gradient(180deg, var(--good), ${rankColor})`,
                boxShadow: `0 0 14px -1px ${rankColor}`,
                transition: 'height 320ms var(--ease-out)',
              }}
            />

            {stages.map((stage, i) => {
              // CareerStage carries its own ladder index; progress.stageIndex is keyed
              // to it, so trust the field and fall back to array order only if absent.
              const stageIndex = Number.isInteger(stage.index) ? stage.index : i;
              const status: StageStatus = stageIndex < cleared ? 'done' : stageIndex === cleared ? 'current' : 'locked';
              const isCurrent = status === 'current' && !complete;
              const accent = STATUS_ACCENT[status];
              const enemy = enemyById.get(stage.enemyId) ?? null;
              const diffAccent = DIFFICULTY_ACCENT[stage.difficulty] ?? 'var(--ink-dim)';
              const dim = status === 'locked' ? 0.5 : status === 'done' ? 0.72 : 1;

              const clamp: CSSProperties = {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: isCurrent ? 2 : 1,
                overflow: 'hidden',
              };

              return (
                <li
                  key={`${stage.enemyId}-${stageIndex}`}
                  ref={isCurrent ? currentRef : undefined}
                  className="hs-slide-up"
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 0,
                    animationDelay: `${Math.min(i, 6) * 55}ms`,
                  }}
                >
                  <div
                    style={{
                      flex: '0 0 42px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <SpineNode status={status} />
                  </div>

                  <div
                    className="hs-panel"
                    style={{
                      flex: '1 1 auto',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: '10px 14px',
                      minWidth: 0,
                      opacity: dim,
                      borderColor: isCurrent ? accent : 'var(--edge)',
                      boxShadow: isCurrent ? accentGlow(accent, 0.4) : 'var(--shadow-1)',
                      transform: isCurrent ? 'translateY(-2px)' : 'none',
                      transition: 'transform 160ms var(--ease-out), box-shadow 160ms var(--ease-out), opacity 160ms linear',
                    }}
                  >
                    <div
                      style={{
                        flex: '0 0 62px',
                        width: 62,
                        height: 62,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        borderRadius: 'var(--r-md)',
                        border: '1px solid var(--edge)',
                        background: 'radial-gradient(70% 70% at 50% 20%, var(--panel2), var(--bg))',
                        filter: status === 'locked' ? 'grayscale(1) brightness(0.7)' : 'none',
                      }}
                    >
                      {enemy ? (
                        renderPortrait(enemy.styleId, 58)
                      ) : (
                        <span className="hs-num" style={{ color: 'var(--ink-faint)', fontSize: 18 }}>
                          ?
                        </span>
                      )}
                    </div>

                    <div className="hs-stack" style={{ gap: 3, flex: '1 1 auto', minWidth: 0 }}>
                      <div className="hs-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <span className="hs-num" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                          BOUT {pad2(stageIndex)}
                        </span>
                        <span
                          className="hs-label"
                          style={{ color: isCurrent ? accent : 'var(--ink-dim)', letterSpacing: '0.16em' }}
                        >
                          {stage.title}
                        </span>
                        <span
                          className="hs-chip"
                          style={{
                            color: diffAccent,
                            borderColor: `color-mix(in srgb, ${diffAccent} 42%, var(--edge))`,
                            background: `color-mix(in srgb, ${diffAccent} 9%, transparent)`,
                          }}
                        >
                          {stage.difficulty.toUpperCase()}
                        </span>
                      </div>

                      <div className="hs-row" style={{ gap: 10, alignItems: 'baseline', minWidth: 0 }}>
                        <span
                          style={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 21,
                            lineHeight: 1.05,
                            letterSpacing: '0.03em',
                            color: isCurrent ? 'var(--ink)' : 'var(--ink-dim)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {enemy ? enemy.name : 'OPPONENT TBA'}
                        </span>
                        <span
                          className="hs-label"
                          style={{ color: 'var(--ink-faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {enemy ? enemy.title : stage.enemyId.toUpperCase()}
                        </span>
                      </div>

                      <p
                        style={{
                          ...clamp,
                          margin: 0,
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: 'var(--ink-dim)',
                        }}
                      >
                        {stage.blurb}
                      </p>
                    </div>

                    <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', minWidth: 116, justifyContent: 'flex-end' }}>
                      {status === 'done' ? (
                        <span
                          className="hs-chip"
                          style={{
                            color: 'var(--good)',
                            borderColor: 'color-mix(in srgb, var(--good) 40%, var(--edge))',
                          }}
                        >
                          <CheckIcon size={11} />
                          DEFEATED
                        </span>
                      ) : isCurrent ? (
                        <button
                          type="button"
                          className="hs-btn hs-btn--primary"
                          onClick={() => onFight(stageIndex)}
                          style={{ minWidth: 116, fontSize: 18, letterSpacing: '0.12em' }}
                        >
                          FIGHT
                        </button>
                      ) : (
                        <span className="hs-chip" style={{ color: 'var(--ink-faint)' }}>
                          <LockIcon size={11} />
                          LOCKED
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}

            {/* Terminal node: the belt. Locked silhouette until the last bell, then the payoff. */}
            <li style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
              <div style={{ flex: '0 0 42px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span
                  aria-hidden="true"
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: complete ? 24 : 18,
                    height: complete ? 24 : 18,
                    borderRadius: '50%',
                    color: complete ? 'var(--crit)' : 'var(--ink-faint)',
                    background: complete ? 'color-mix(in srgb, var(--crit) 24%, var(--bg))' : 'var(--bg)',
                    border: `2px solid ${complete ? 'var(--crit)' : 'var(--edge2)'}`,
                    boxShadow: complete ? '0 0 20px -2px var(--crit)' : 'none',
                  }}
                >
                  {complete ? <CheckIcon size={11} /> : <LockIcon size={10} />}
                </span>
              </div>

              <div
                className={complete ? 'hs-panel hs-pop' : 'hs-panel'}
                style={{
                  flex: '1 1 auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '12px 14px',
                  minWidth: 0,
                  opacity: complete ? 1 : 0.5,
                  borderColor: complete ? 'var(--crit)' : 'var(--edge)',
                  boxShadow: complete ? accentGlow('var(--crit)', 0.45) : 'var(--shadow-1)',
                  background: complete
                    ? 'linear-gradient(120deg, color-mix(in srgb, var(--crit) 12%, var(--panel2)), var(--panel) 62%)'
                    : undefined,
                }}
              >
                <span style={{ color: complete ? 'var(--crit)' : 'var(--ink-faint)', display: 'inline-flex', flex: '0 0 auto' }}>
                  <BeltIcon size={complete ? 40 : 28} />
                </span>
                <div className="hs-stack" style={{ gap: 2, flex: '1 1 auto', minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: complete ? 30 : 20,
                      lineHeight: 1.05,
                      letterSpacing: '0.06em',
                      color: complete ? 'var(--crit)' : 'var(--ink-dim)',
                      textShadow: complete ? '0 0 28px color-mix(in srgb, var(--crit) 45%, transparent)' : 'none',
                    }}
                  >
                    {complete ? 'UNDISPUTED CHAMPION' : 'THE BELT'}
                  </span>
                  <span className="hs-label" style={{ textTransform: 'none', color: 'var(--ink-dim)' }}>
                    {complete
                      ? `Ladder cleared — ${count(progress.wins)} wins, ${count(progress.koWins)} inside the distance.`
                      : `${Math.max(0, total - cleared)} bouts still between you and the title.`}
                  </span>
                </div>
                {complete ? (
                  <span
                    className="hs-chip"
                    style={{
                      flex: '0 0 auto',
                      color: 'var(--crit)',
                      borderColor: 'color-mix(in srgb, var(--crit) 45%, var(--edge))',
                      background: 'color-mix(in srgb, var(--crit) 10%, transparent)',
                    }}
                  >
                    CAREER COMPLETE
                  </span>
                ) : null}
              </div>
            </li>
          </ol>
        </div>

        <footer className="hs-spread" style={{ alignItems: 'center', gap: 12 }}>
          <p className="hs-label" style={{ margin: 0 }}>
            <span className="hs-kbd">ESC</span> BACK
            <span style={{ margin: '0 10px', color: 'var(--edge2)' }}>/</span>
            {complete ? 'THE LADDER IS YOURS' : 'ONLY THE LIVE BOUT CAN BE FOUGHT'}
          </p>
          <button
            type="button"
            className={`hs-btn hs-btn--sm ${confirmReset ? 'hs-btn--danger' : 'hs-btn--ghost'}`}
            onClick={handleReset}
            disabled={!hasProgress}
            aria-live="polite"
            title={confirmReset ? 'Click again to erase all career progress' : 'Erase all career progress'}
          >
            {confirmReset ? 'CONFIRM — ERASE CAREER' : 'RESET CAREER'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default CareerScreen;
