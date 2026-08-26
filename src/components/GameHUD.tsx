import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { COMBO } from '@/config/gameConfig';
import { clamp01 } from '@/utils/math';

/**
 * Pure display overlay for the fight. Every value arrives as a prop; the only
 * local state here is animation state (damage ghost, combo pop, announcement
 * entry) because those read from *changes* over time rather than the snapshot.
 */

export interface GameHUDProps {
  playerName: string;
  enemyName: string;
  playerHp: number;
  playerHpMax: number;
  enemyHp: number;
  enemyHpMax: number;
  playerStamina: number;
  playerStaminaMax: number;
  enemyStamina: number;
  enemyStaminaMax: number;
  rage: number;
  rageMax: number;
  rageActive: boolean;
  round: number;
  roundTotal: number;
  timeLeft: number;
  roundsWon: { player: number; enemy: number };
  combo: number;
  comboWindow: number;
  lastAction: string | null;
  strikePower: number;
  announcement: { text: string; sub?: string; tone?: 'neutral' | 'good' | 'bad' | 'rage' } | null;
  knockdownCount: number | null;
}

type Align = 'left' | 'right';

const SEGMENTS = 14;

/**
 * "YOU ◀" / "▶ CPU". The arrow points at the side of the arena that fighter
 * occupies, which is the piece the name alone was missing — a name in the top
 * corner does not tell you which of two similar silhouettes it belongs to.
 * The on-canvas tags carry the same colours.
 */
function SideBadge({ side }: { side: 'player' | 'enemy' }) {
  const isPlayer = side === 'player';
  const color = isPlayer ? 'var(--player)' : 'var(--enemy)';
  const rgbVar = isPlayer ? 'var(--player-rgb)' : 'var(--enemy-rgb)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
        padding: '2px 7px',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.14em',
        color,
        backgroundColor: `rgba(${rgbVar}, 0.14)`,
        border: `1px solid rgba(${rgbVar}, 0.45)`,
        lineHeight: 1.4,
      }}
    >
      {isPlayer ? '◀ YOU' : 'CPU ▶'}
    </span>
  );
}

const TONE_COLOR: Record<'neutral' | 'good' | 'bad' | 'rage', string> = {
  neutral: 'var(--ink)',
  good: 'var(--good)',
  bad: 'var(--enemy)',
  rage: 'var(--rage)',
};

const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const staminaColor = (frac: number): string =>
  frac <= 0.12 ? 'var(--enemy)' : frac <= 0.3 ? 'var(--warn)' : 'var(--good)';

const segmentColor = (t: number): string =>
  t < 0.45 ? 'var(--player)' : t < 0.78 ? 'var(--crit)' : 'var(--rage)';

/**
 * Lagging "damage ghost". Snaps upward instantly (round resets, heals) but
 * drains downward after a short hold so a hit reads as a visible chunk.
 */
function useDamageGhost(value: number, holdMs = 200, drainMs = 480): number {
  const [ghost, setGhost] = useState(value);
  const anim = useRef({ ghost: value, from: value, target: value, start: 0, raf: 0 });

  useEffect(() => {
    const s = anim.current;
    s.target = value;

    if (value >= s.ghost) {
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      s.ghost = value;
      s.from = value;
      setGhost(value);
      return;
    }

    s.from = s.ghost;
    s.start = performance.now();
    if (s.raf) return; // a drain is already running; it will pick up the new target

    const tick = (): void => {
      const elapsed = performance.now() - s.start - holdMs;
      if (elapsed <= 0) {
        s.raf = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, elapsed / drainMs);
      const k = 1 - Math.pow(1 - t, 3);
      s.ghost = s.from + (s.target - s.from) * k;
      setGhost(s.ghost);
      s.raf = t >= 1 ? 0 : requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  }, [value, holdMs, drainMs]);

  useEffect(() => {
    const s = anim.current;
    return () => {
      if (s.raf) cancelAnimationFrame(s.raf);
    };
  }, []);

  return ghost;
}

interface FillProps {
  pct: number;
  color: string;
  align: Align;
  opacity?: number;
  extra?: CSSProperties;
}

/**
 * Fills are absolutely anchored to their own edge and the track's transform is
 * pinned to none, so the bar direction is correct whatever `--flip` does in CSS.
 */
const fillStyle = ({ pct, color, align, opacity, extra }: FillProps): CSSProperties => ({
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: align === 'left' ? 0 : 'auto',
  right: align === 'right' ? 0 : 'auto',
  width: `${clamp01(pct) * 100}%`,
  backgroundColor: color,
  opacity,
  borderRadius: 'inherit',
  ...extra,
});

interface TrackProps {
  align: Align;
  height: number;
  children: ReactNode;
  glow?: string;
}

function Track({ align, height, children, glow }: TrackProps) {
  return (
    <div
      className={align === 'right' ? 'hs-meter hs-meter--flip' : 'hs-meter'}
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'block',
        transform: 'none',
        width: '100%',
        height,
        borderRadius: height >= 12 ? 4 : 3,
        backgroundColor: 'var(--panel2)',
        boxShadow: glow ? `0 0 14px ${glow}` : undefined,
      }}
    >
      {children}
    </div>
  );
}

function HpBar({ hp, max, color, align }: { hp: number; max: number; color: string; align: Align }) {
  const safeMax = Math.max(1, max);
  const ghost = useDamageGhost(hp);
  // The ghost/real gap is the hit itself, so it doubles as the flash driver.
  const flash = clamp01((ghost - hp) / (safeMax * 0.1));

  return (
    <Track align={align} height={16} glow={flash > 0.05 ? color : undefined}>
      <div style={fillStyle({ pct: ghost / safeMax, color: 'var(--crit)', align, opacity: 0.55 })} />
      <div
        style={fillStyle({
          pct: hp / safeMax,
          color,
          align,
          extra: { transition: 'width 90ms linear' },
        })}
      />
      <div
        style={fillStyle({
          pct: hp / safeMax,
          color: 'var(--ink)',
          align,
          opacity: flash * 0.75,
          extra: { pointerEvents: 'none' },
        })}
      />
    </Track>
  );
}

function StatBar({ value, max, align }: { value: number; max: number; align: Align }) {
  const frac = clamp01(value / Math.max(1, max));
  return (
    <Track align={align} height={6}>
      <div
        style={fillStyle({
          pct: frac,
          color: staminaColor(frac),
          align,
          extra: { transition: 'width 140ms linear' },
        })}
      />
    </Track>
  );
}

function RageBar({ value, max, active }: { value: number; max: number; active: boolean }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const frac = clamp01(value / Math.max(1, max));

  // Scrolling gradient is driven straight into the DOM node: an indefinite
  // animation must not re-render the whole HUD 60 times a second.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = (): void => {
      const el = fillRef.current;
      if (el) el.style.backgroundPosition = `${(performance.now() / 14) % 200}% 0`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <Track align="left" height={8} glow={active ? 'rgba(255,106,0,0.45)' : undefined}>
      <div
        ref={fillRef}
        style={fillStyle({
          pct: active ? 1 : frac,
          color: 'var(--rage)',
          align: 'left',
          opacity: active ? 1 : frac > 0.98 ? 1 : 0.85,
          extra: active
            ? {
                backgroundImage:
                  'repeating-linear-gradient(115deg, var(--rage) 0 12px, var(--crit) 12px 24px)',
                backgroundSize: '200% 100%',
              }
            : { transition: 'width 160ms linear' },
        })}
      />
    </Track>
  );
}

function Pips({ won, total, color }: { won: number; total: number; color: string }) {
  return (
    <div className="hs-row" style={{ gap: 5, alignItems: 'center' }}>
      {Array.from({ length: Math.max(1, total) }, (_, i) => (
        <span
          key={i}
          className={i < won ? 'hs-dot hs-dot--on' : 'hs-dot hs-dot--off'}
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            display: 'block',
            backgroundColor: i < won ? color : 'var(--edge2)',
            boxShadow: i < won ? `0 0 8px ${color}` : 'none',
          }}
        />
      ))}
    </div>
  );
}

function PowerMeter({ power }: { power: number }) {
  const filled = Math.round((clamp01(power / 100) * SEGMENTS));
  return (
    <div className="hs-row" style={{ gap: 3, alignItems: 'stretch', flex: 1 }}>
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const on = i < filled;
        const t = i / (SEGMENTS - 1);
        return (
          <span
            key={i}
            style={{
              flex: 1,
              height: 12,
              borderRadius: 2,
              backgroundColor: on ? segmentColor(t) : 'var(--edge)',
              opacity: on ? 1 : 0.55,
              boxShadow: on && t > 0.78 ? '0 0 8px rgba(255,106,0,0.6)' : 'none',
              transition: 'background-color 70ms linear, opacity 70ms linear',
            }}
          />
        );
      })}
    </div>
  );
}

export function GameHUD({
  playerName,
  enemyName,
  playerHp,
  playerHpMax,
  enemyHp,
  enemyHpMax,
  playerStamina,
  playerStaminaMax,
  enemyStamina,
  enemyStaminaMax,
  rage,
  rageMax,
  rageActive,
  round,
  roundTotal,
  timeLeft,
  roundsWon,
  combo,
  comboWindow,
  lastAction,
  strikePower,
  announcement,
  knockdownCount,
}: GameHUDProps) {
  const [comboPop, setComboPop] = useState(false);
  const [annIn, setAnnIn] = useState(false);
  const annText = announcement?.text ?? null;

  useEffect(() => {
    if (combo <= 0) {
      setComboPop(false);
      return;
    }
    setComboPop(true);
    const id = window.setTimeout(() => setComboPop(false), 170);
    return () => window.clearTimeout(id);
  }, [combo]);

  // Force an off frame before the on frame so the entry transition actually runs
  // when one announcement replaces another.
  useEffect(() => {
    if (!annText) {
      setAnnIn(false);
      return;
    }
    setAnnIn(false);
    const raf = requestAnimationFrame(() => setAnnIn(true));
    return () => cancelAnimationFrame(raf);
  }, [annText]);

  const urgent = timeLeft <= 10;
  // timeLeft ticks every frame, so the sub-second remainder is a free pulse clock.
  const tick = urgent ? 1 - (timeLeft - Math.floor(timeLeft)) : 0;
  const comboFrac = clamp01(comboWindow / COMBO.windowMs);
  const tone = announcement?.tone ?? 'neutral';
  const toneColor = TONE_COLOR[tone];

  const nameStyle: CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: 26,
    lineHeight: 1,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
        fontFamily: 'var(--font-ui)',
        color: 'var(--ink)',
        userSelect: 'none',
      }}
    >
      <div
        className="hs-row"
        style={{ alignItems: 'flex-start', gap: 22, padding: '16px 22px 0' }}
      >
        {/* PLAYER */}
        <div className="hs-stack" style={{ gap: 6, width: 360, minWidth: 0 }}>
          <div className="hs-spread" style={{ alignItems: 'baseline' }}>
            <span className="hs-row" style={{ alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <SideBadge side="player" />
              <span style={{ ...nameStyle, color: 'var(--player)' }}>{playerName}</span>
            </span>
            <span className="hs-num" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ink-dim)' }}>
              {Math.max(0, Math.round(playerHp))}
              <span style={{ color: 'var(--ink-faint)' }}>/{Math.round(playerHpMax)}</span>
            </span>
          </div>

          <HpBar hp={playerHp} max={playerHpMax} color="var(--player)" align="left" />
          <StatBar value={playerStamina} max={playerStaminaMax} align="left" />

          <div className="hs-row" style={{ gap: 8, alignItems: 'center', marginTop: 2 }}>
            <span className="hs-label" style={{ fontSize: 9, color: rageActive ? 'var(--rage)' : 'var(--ink-faint)', width: 34 }}>
              RAGE
            </span>
            <div style={{ flex: 1 }}>
              <RageBar value={rage} max={rageMax} active={rageActive} />
            </div>
            {rageActive && (
              <span
                className="hs-badge"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 12,
                  letterSpacing: '0.14em',
                  padding: '2px 7px',
                  borderRadius: 'var(--r-sm)',
                  color: 'var(--bg)',
                  backgroundColor: 'var(--rage)',
                  whiteSpace: 'nowrap',
                }}
              >
                RAGE MODE
              </span>
            )}
          </div>

          {/* Read-out for the last recognised gesture and how hard it landed. */}
          <div
            className="hs-panel"
            style={{
              marginTop: 8,
              padding: '9px 11px',
              backgroundColor: 'rgba(13,15,25,0.72)',
              backdropFilter: 'blur(6px)',
            }}
          >
            <div className="hs-spread" style={{ alignItems: 'baseline', marginBottom: 7 }}>
              <span className="hs-label" style={{ fontSize: 9 }}>RECENT ACTION</span>
              <span
                className="hs-value"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: lastAction ? 'var(--ink)' : 'var(--ink-faint)',
                  letterSpacing: '0.06em',
                }}
              >
                {lastAction ?? '—'}
              </span>
            </div>
            <div className="hs-row" style={{ alignItems: 'center', gap: 9 }}>
              <span className="hs-label" style={{ fontSize: 9, width: 62, flexShrink: 0 }}>STRIKE PWR</span>
              <PowerMeter power={strikePower} />
              <span
                className="hs-num"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 14, width: 30, textAlign: 'right', color: 'var(--ink)' }}
              >
                {Math.round(clamp01(strikePower / 100) * 100)}
              </span>
            </div>
          </div>
        </div>

        {/* CENTRE — round, clock, cards */}
        <div className="hs-stack" style={{ flex: 1, alignItems: 'center', gap: 2, minWidth: 0 }}>
          <span className="hs-label" style={{ fontSize: 10, letterSpacing: '0.28em' }}>
            ROUND {round} <span style={{ color: 'var(--ink-faint)' }}>/ {roundTotal}</span>
          </span>
          <span
            className="hs-num"
            style={{
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: 46,
              lineHeight: 1,
              fontWeight: 700,
              letterSpacing: '0.02em',
              color: urgent ? 'var(--warn)' : 'var(--ink)',
              textShadow: urgent ? '0 0 22px rgba(255,176,32,0.55)' : '0 2px 10px rgba(0,0,0,0.6)',
              transform: `scale(${1 + tick * 0.05})`,
            }}
          >
            {formatClock(timeLeft)}
          </span>
          <div className="hs-row" style={{ gap: 16, alignItems: 'center', marginTop: 4 }}>
            <Pips won={roundsWon.player} total={roundTotal} color="var(--player)" />
            <span className="hs-label" style={{ fontSize: 9, color: 'var(--ink-faint)' }}>CARDS</span>
            <Pips won={roundsWon.enemy} total={roundTotal} color="var(--enemy)" />
          </div>
        </div>

        {/* ENEMY — mirrored */}
        <div className="hs-stack" style={{ gap: 6, width: 360, minWidth: 0 }}>
          <div className="hs-spread" style={{ alignItems: 'baseline' }}>
            <span className="hs-num" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ink-dim)' }}>
              {Math.max(0, Math.round(enemyHp))}
              <span style={{ color: 'var(--ink-faint)' }}>/{Math.round(enemyHpMax)}</span>
            </span>
            <span className="hs-row" style={{ alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ ...nameStyle, color: 'var(--enemy)', textAlign: 'right' }}>{enemyName}</span>
              <SideBadge side="enemy" />
            </span>
          </div>
          <HpBar hp={enemyHp} max={enemyHpMax} color="var(--enemy)" align="right" />
          <StatBar value={enemyStamina} max={enemyStaminaMax} align="right" />
        </div>
      </div>

      {/* COMBO */}
      {combo > 1 && (
        <div
          className="hs-stack"
          style={{
            position: 'absolute',
            left: '9%',
            bottom: 118,
            gap: 5,
            alignItems: 'flex-start',
            transform: `scale(${comboPop ? 1.16 : 1})`,
            transformOrigin: 'left bottom',
            transition: 'transform 240ms cubic-bezier(0.2, 1.5, 0.35, 1)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: combo >= COMBO.bigComboAt ? 58 : 44,
              lineHeight: 0.9,
              letterSpacing: '0.02em',
              color: combo >= COMBO.bigComboAt ? 'var(--crit)' : 'var(--player)',
              textShadow: combo >= COMBO.bigComboAt
                ? '0 0 26px rgba(255,211,77,0.6), 0 4px 0 rgba(0,0,0,0.45)'
                : '0 0 18px rgba(49,230,200,0.45), 0 3px 0 rgba(0,0,0,0.45)',
            }}
          >
            COMBO <span className="hs-num">x{combo}</span>
          </span>
          <div
            style={{
              width: 132,
              height: 3,
              borderRadius: 2,
              backgroundColor: 'var(--edge)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${comboFrac * 100}%`,
                backgroundColor: comboFrac < 0.3 ? 'var(--warn)' : 'var(--player)',
                transition: 'width 80ms linear',
              }}
            />
          </div>
        </div>
      )}

      {/* ANNOUNCEMENTS */}
      {announcement && (
        <div
          aria-live="polite"
          className="hs-stack"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '34%',
            alignItems: 'center',
            gap: 6,
            textAlign: 'center',
            opacity: annIn ? 1 : 0,
            transform: `scale(${annIn ? 1 : 1.35})`,
            transition: 'opacity 160ms ease-out, transform 280ms cubic-bezier(0.15, 1.4, 0.3, 1)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 96,
              lineHeight: 0.86,
              letterSpacing: '0.03em',
              color: toneColor,
              textShadow: `0 0 46px ${tone === 'neutral' ? 'rgba(238,241,255,0.35)' : 'currentColor'}, 0 6px 0 rgba(0,0,0,0.5)`,
            }}
          >
            {announcement.text}
          </span>
          {announcement.sub && (
            <span
              className="hs-subtitle"
              style={{ fontSize: 14, letterSpacing: '0.34em', color: 'var(--ink-dim)' }}
            >
              {announcement.sub}
            </span>
          )}
        </div>
      )}

      {/* KNOCKDOWN COUNT */}
      {knockdownCount !== null && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span
            className="hs-num"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 220,
              lineHeight: 0.8,
              color: 'var(--crit)',
              textShadow: '0 0 70px rgba(255,211,77,0.55), 0 10px 0 rgba(0,0,0,0.55)',
            }}
          >
            {knockdownCount}
          </span>
        </div>
      )}
    </div>
  );
}

export default GameHUD;
