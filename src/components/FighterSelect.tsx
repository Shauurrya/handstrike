import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Difficulty, DifficultyProfile, EnemyDef } from '@/types';
import { invLerp } from '@/utils/math';

export interface FighterSelectProps {
  enemies: EnemyDef[];
  difficulties: DifficultyProfile[];
  selectedEnemyId: string;
  selectedDifficulty: Difficulty;
  onSelectEnemy(id: string): void;
  onSelectDifficulty(d: Difficulty): void;
  onConfirm(): void;
  onBack(): void;
  renderPortrait(styleId: string, size: number): ReactNode;
}

interface StatRow {
  label: string;
  /** 0..1 */
  value: number;
  color: string;
}

/**
 * Brain knobs are tuning values, not display values, so each one is remapped
 * onto the 0..1 band the meters read. The ranges below are the span the roster
 * actually uses — a champion should peg a meter, a rookie should not.
 */
function statsFor(enemy: EnemyDef): StatRow[] {
  return [
    { label: 'POWER', value: invLerp(0.7, 1.5, enemy.powerScale), color: 'var(--enemy)' },
    { label: 'SPEED', value: invLerp(0.7, 1.5, enemy.speedScale), color: 'var(--player)' },
    { label: 'DEFENCE', value: invLerp(0, 1, enemy.brain.blockBias), color: 'var(--counter)' },
    { label: 'IQ', value: invLerp(0, 0.5, enemy.brain.learningRate), color: 'var(--crit)' },
  ];
}

function StatMeter({ label, value, color }: StatRow) {
  const pct = Math.round(value * 100);
  return (
    <div className="hs-stack" style={{ gap: 5 }}>
      <div className="hs-spread" style={{ alignItems: 'baseline' }}>
        <span className="hs-label">{label}</span>
        <span className="hs-num" style={{ fontSize: 12, color }}>
          {pct}
        </span>
      </div>
      <div className="hs-meter" role="img" aria-label={`${label} ${pct} of 100`}>
        <div className="hs-meter__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function FighterSelect({
  enemies,
  difficulties,
  selectedEnemyId,
  selectedDifficulty,
  onSelectEnemy,
  onSelectDifficulty,
  onConfirm,
  onBack,
  renderPortrait,
}: FighterSelectProps) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = Math.max(0, enemies.findIndex((e) => e.id === selectedEnemyId));
  const selected = enemies[activeIndex] as EnemyDef | undefined;

  /** The grid is auto-fit, so the column count is measured rather than assumed. */
  const columnCount = (): number => {
    const cards = cardRefs.current.filter((c): c is HTMLButtonElement => c !== null);
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let n = 0;
    for (const card of cards) {
      if (card.offsetTop !== top) break;
      n += 1;
    }
    return Math.max(1, n);
  };

  const moveSelection = (delta: number) => {
    if (!enemies.length) return;
    const next = Math.min(enemies.length - 1, Math.max(0, activeIndex + delta));
    if (next === activeIndex) return;
    onSelectEnemy(enemies[next].id);
    cardRefs.current[next]?.focus();
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        moveSelection(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveSelection(columnCount());
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveSelection(-columnCount());
        break;
      default:
        break;
    }
  };

  return (
    <div className="hs-screen">
      <div className="hs-screen__inner hs-stack" style={{ gap: 18 }}>
        <header className="hs-spread" style={{ alignItems: 'flex-end' }}>
          <div>
            <h1 className="hs-title" style={{ margin: 0, fontSize: 46, lineHeight: 1 }}>
              SELECT OPPONENT
            </h1>
            <p className="hs-subtitle" style={{ margin: '4px 0 0' }}>
              {enemies.length} FIGHTERS ON THE CARD
            </p>
          </div>
          <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" onClick={onBack}>
            BACK
          </button>
        </header>

        <div className="hs-row" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div
            className="hs-grid"
            role="group"
            aria-label="Opponents"
            onKeyDown={onGridKeyDown}
            style={{ flex: '1 1 auto', minWidth: 0, maxHeight: '52vh', overflowY: 'auto', padding: 4 }}
          >
            {enemies.map((enemy, i) => {
              const isSelected = enemy.id === selectedEnemyId;
              return (
                <button
                  key={enemy.id}
                  ref={(el) => {
                    cardRefs.current[i] = el;
                  }}
                  type="button"
                  aria-pressed={isSelected}
                  className="hs-panel"
                  onClick={() => onSelectEnemy(enemy.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    textAlign: 'center',
                    color: 'inherit',
                    borderColor: isSelected ? 'var(--enemy)' : 'var(--edge)',
                    boxShadow: isSelected ? 'var(--glow-enemy)' : 'none',
                    transform: isSelected ? 'translateY(-4px)' : 'none',
                    transition: 'transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
                  }}
                >
                  <div style={{ height: 96, display: 'flex', alignItems: 'center' }}>
                    {renderPortrait(enemy.styleId, 96)}
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 22,
                      letterSpacing: '0.04em',
                      color: isSelected ? 'var(--ink)' : 'var(--ink-dim)',
                    }}
                  >
                    {enemy.name}
                  </span>
                  <span className="hs-label" style={{ textTransform: 'none' }}>
                    {enemy.title}
                  </span>
                  <span className="hs-chip">{enemy.archetype.toUpperCase()}</span>
                </button>
              );
            })}
          </div>

          <aside
            className="hs-panel hs-stack"
            style={{ flex: '0 0 320px', width: 320, gap: 14, maxHeight: '52vh', overflowY: 'auto' }}
          >
            {selected ? (
              <>
                <div className="hs-stack" style={{ gap: 2 }}>
                  <span className="hs-label">DOSSIER</span>
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: 'var(--font-display)',
                      fontSize: 34,
                      lineHeight: 1,
                      color: 'var(--enemy)',
                    }}
                  >
                    {selected.name}
                  </h2>
                  <span className="hs-subtitle">{selected.title}</span>
                </div>

                <div className="hs-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="hs-chip">{selected.archetype.toUpperCase()}</span>
                  <span className="hs-chip">
                    <span className="hs-num">{selected.maxHp}</span> HP
                  </span>
                  <span className="hs-chip">
                    <span className="hs-num">{selected.maxStamina}</span> STA
                  </span>
                </div>

                <p style={{ margin: 0, color: 'var(--ink-dim)', fontSize: 13, lineHeight: 1.6 }}>{selected.bio}</p>

                <div className="hs-divider" />

                <div className="hs-stack" style={{ gap: 12 }}>
                  {statsFor(selected).map((stat) => (
                    <StatMeter key={stat.label} {...stat} />
                  ))}
                </div>
              </>
            ) : (
              <p className="hs-label" style={{ margin: 0 }}>
                NO FIGHTER SELECTED
              </p>
            )}
          </aside>
        </div>

        <div className="hs-stack" style={{ gap: 8 }}>
          <span className="hs-label">DIFFICULTY</span>
          <div className="hs-row" role="group" aria-label="Difficulty" style={{ gap: 10, flexWrap: 'wrap' }}>
            {difficulties.map((d) => {
              const isActive = d.id === selectedDifficulty;
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={isActive}
                  className={`hs-btn${isActive ? ' is-active' : ''}`}
                  onClick={() => onSelectDifficulty(d.id)}
                  style={{
                    flex: '1 1 0',
                    minWidth: 160,
                    height: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 3,
                    textAlign: 'left',
                    paddingTop: 10,
                    paddingBottom: 10,
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 19, letterSpacing: '0.04em' }}>
                    {d.name}
                  </span>
                  <span className="hs-label" style={{ textTransform: 'none', lineHeight: 1.4 }}>
                    {d.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="hs-spread" style={{ alignItems: 'center' }}>
          <button type="button" className="hs-btn hs-btn--ghost" onClick={onBack}>
            BACK
          </button>
          <button
            type="button"
            className="hs-btn hs-btn--primary"
            onClick={onConfirm}
            disabled={!selected}
            style={{ minWidth: 260, fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '0.12em' }}
          >
            FIGHT
          </button>
        </div>
      </div>
    </div>
  );
}

export default FighterSelect;
