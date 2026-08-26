import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { clamp, clamp01, easeOut } from '@/utils/math';

/**
 * Shared readouts for the post-fight and training analytics screens.
 *
 * Every figure sweeps in on mount: a report that snaps into existence reads as a
 * data dump, while a short ease-out read-out reads as a machine reporting back.
 * Anyone who has asked the OS for less motion gets the final value immediately.
 */

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReduced);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/** rAF count-up driver. Resumes from wherever it is if the target changes mid-flight. */
function useAnimatedNumber(target: number, durationMs = 850, delayMs = 0): number {
  const safe = Number.isFinite(target) ? target : 0;
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? safe : 0);
  const currentRef = useRef(reduced ? safe : 0);

  useEffect(() => {
    if (reduced) {
      currentRef.current = safe;
      setValue(safe);
      return;
    }
    const from = currentRef.current;
    const startAt = performance.now() + delayMs;
    let raf = requestAnimationFrame(function step(now: number) {
      const p = clamp01((now - startAt) / durationMs);
      const next = from + (safe - from) * easeOut(p);
      currentRef.current = next;
      setValue(next);
      if (p < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [safe, durationMs, delayMs, reduced]);

  return value;
}

/** Fade-and-rise for the parts of a stat that are text rather than a number. */
function useRevealStyle(delayMs = 0, dy = 8): CSSProperties {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const id = window.setTimeout(() => setShown(true), delayMs + 20);
    return () => window.clearTimeout(id);
  }, [reduced, delayMs]);

  if (reduced) return {};
  return {
    opacity: shown ? 1 : 0,
    transform: shown ? 'none' : `translateY(${dy}px)`,
    transition: 'opacity .42s ease, transform .42s cubic-bezier(.2,.85,.25,1)',
  };
}

/** Keep the digit count stable while a value counts up so nothing jitters. */
const decimalsFor = (v: number): number => {
  if (!Number.isFinite(v) || Number.isInteger(v)) return 0;
  const abs = Math.abs(v);
  return abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
};

const fmt = (v: number, decimals: number): string => (Number.isFinite(v) ? v.toFixed(decimals) : '0');

const GLOW = '0 0 18px color-mix(in srgb, currentColor 38%, transparent)';

export function StatRow(props: {
  label: string;
  value: string | number;
  accent?: string;
  mono?: boolean;
}): JSX.Element {
  const { label, value, accent = 'var(--ink)', mono = true } = props;
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const decimals = numeric === null ? 0 : decimalsFor(numeric);
  const animated = useAnimatedNumber(numeric ?? 0);
  const reveal = useRevealStyle(0, 6);

  return (
    <div
      className="hs-spread"
      style={{ ...reveal, alignItems: 'baseline', gap: 8, padding: '3px 0' }}
    >
      <span className="hs-label" style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <span
        aria-hidden="true"
        style={{ flex: 1, borderBottom: '1px dotted var(--edge2)', opacity: 0.55, marginBottom: 4 }}
      />
      <span
        className={mono ? 'hs-value hs-num' : 'hs-value'}
        style={{ color: accent, whiteSpace: 'nowrap' }}
      >
        {numeric === null ? String(value) : fmt(animated, decimals)}
      </span>
    </div>
  );
}

export function StatBig(props: {
  label: string;
  value: string | number;
  unit?: string;
  accent?: string;
  sub?: string;
}): JSX.Element {
  const { label, value, unit, accent = 'var(--ink)', sub } = props;
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const decimals = numeric === null ? 0 : decimalsFor(numeric);
  const animated = useAnimatedNumber(numeric ?? 0, 950);
  const reveal = useRevealStyle(0, 10);

  return (
    <div style={{ ...reveal, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span className="hs-label">{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, color: accent }}>
        <span
          className="hs-num"
          style={{
            fontSize: 'clamp(26px, 2.6vw, 38px)',
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-.01em',
            textShadow: GLOW,
          }}
        >
          {numeric === null ? String(value) : fmt(animated, decimals)}
        </span>
        {unit ? (
          <span className="hs-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>{unit}</span>
        ) : null}
      </div>
      {sub ? <span className="hs-subtitle" style={{ fontSize: 10 }}>{sub}</span> : null}
    </div>
  );
}

export function BarStat(props: {
  label: string;
  value: number;
  max?: number;
  accent?: string;
  suffix?: string;
}): JSX.Element {
  const { label, value, max = 100, accent = 'var(--player)', suffix = '' } = props;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const target = clamp(Number.isFinite(value) ? value : 0, 0, safeMax);
  const animated = useAnimatedNumber(target, 900);
  const pct = clamp01(animated / safeMax) * 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div className="hs-spread" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className="hs-label">{label}</span>
        <span className="hs-value hs-num" style={{ color: accent }}>
          {fmt(animated, decimalsFor(target))}{suffix}
        </span>
      </div>
      <div className="hs-meter">
        <div
          className="hs-meter__fill"
          style={{
            width: `${pct}%`,
            background: accent,
            color: accent,
            boxShadow: '0 0 12px color-mix(in srgb, currentColor 55%, transparent)',
          }}
        />
      </div>
    </div>
  );
}

/** 270-degree arc gauge. Hand-drawn SVG — no chart library anywhere in this build. */
export function RadialStat(props: {
  label: string;
  value: number;
  max?: number;
  accent?: string;
  size?: number;
}): JSX.Element {
  const { label, value, max = 100, accent = 'var(--player)', size = 120 } = props;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const target = clamp(Number.isFinite(value) ? value : 0, 0, safeMax);
  const animated = useAnimatedNumber(target, 1050);

  const box = Math.max(72, size);
  const stroke = Math.max(6, Math.round(box * 0.075));
  const c = box / 2;
  const r = c - stroke / 2 - 2;
  const circumference = 2 * Math.PI * r;
  const arc = circumference * 0.75;
  const progress = clamp01(animated / safeMax);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const angle = ((135 + t * 270) * Math.PI) / 180;
    const inner = r - stroke / 2 - 9;
    const outer = r - stroke / 2 - 4;
    return {
      t,
      x1: c + Math.cos(angle) * inner,
      y1: c + Math.sin(angle) * inner,
      x2: c + Math.cos(angle) * outer,
      y2: c + Math.sin(angle) * outer,
    };
  });

  return (
    <svg
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      style={{ color: accent, display: 'block', overflow: 'visible' }}
      role="img"
      aria-label={`${label} ${fmt(target, safeMax <= 10 ? 1 : 0)} of ${safeMax}`}
    >
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="var(--edge2)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${arc} ${circumference}`}
        transform={`rotate(135 ${c} ${c})`}
      />
      {ticks.map((tk) => (
        <line
          key={tk.t}
          x1={tk.x1}
          y1={tk.y1}
          x2={tk.x2}
          y2={tk.y2}
          stroke="var(--edge2)"
          strokeWidth={1}
          strokeLinecap="round"
        />
      ))}
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${arc * progress} ${circumference}`}
        transform={`rotate(135 ${c} ${c})`}
        style={{ filter: 'drop-shadow(0 0 6px currentColor)' }}
      />
      <text
        x={c}
        y={c}
        textAnchor="middle"
        dominantBaseline="central"
        className="hs-num"
        style={{ fill: 'currentColor', fontSize: box * 0.28, fontWeight: 700 }}
      >
        {fmt(animated, safeMax <= 10 ? 1 : 0)}
      </text>
      <text
        x={c}
        y={c + box * 0.29}
        textAnchor="middle"
        className="hs-label"
        style={{ fill: 'var(--ink-dim)', fontSize: Math.max(8, box * 0.083) }}
      >
        {label}
      </text>
    </svg>
  );
}

export function SplitBar(props: {
  label: string;
  left: number;
  right: number;
  leftLabel: string;
  rightLabel: string;
  leftColor?: string;
  rightColor?: string;
}): JSX.Element {
  const {
    label,
    left,
    right,
    leftLabel,
    rightLabel,
    leftColor = 'var(--player)',
    rightColor = 'var(--enemy)',
  } = props;

  const l = Math.max(0, Number.isFinite(left) ? left : 0);
  const r = Math.max(0, Number.isFinite(right) ? right : 0);
  const total = l + r;
  // With nothing recorded the bar rests dead centre rather than collapsing to a sliver.
  const targetPct = total > 0 ? (l / total) * 100 : 50;
  const p = useAnimatedNumber(1, 900);
  const pct = 50 + (targetPct - 50) * p;
  const reveal = useRevealStyle(0, 8);

  return (
    <div style={{ ...reveal, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span className="hs-label">{label}</span>
      <div
        style={{
          display: 'flex',
          gap: 2,
          height: 10,
          borderRadius: 'var(--r-sm)',
          overflow: 'hidden',
          background: 'var(--bg2)',
          border: '1px solid var(--edge)',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            background: leftColor,
            color: leftColor,
            boxShadow: '0 0 12px color-mix(in srgb, currentColor 50%, transparent)',
          }}
        />
        <div
          style={{
            width: `${100 - pct}%`,
            background: rightColor,
            color: rightColor,
            boxShadow: '0 0 12px color-mix(in srgb, currentColor 50%, transparent)',
          }}
        />
      </div>
      <div className="hs-spread" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className="hs-row" style={{ gap: 6, alignItems: 'baseline' }}>
          <span className="hs-label" style={{ color: leftColor }}>{leftLabel}</span>
          <span className="hs-value hs-num">{fmt(l * p, decimalsFor(l))}</span>
        </span>
        <span className="hs-row" style={{ gap: 6, alignItems: 'baseline' }}>
          <span className="hs-value hs-num">{fmt(r * p, decimalsFor(r))}</span>
          <span className="hs-label" style={{ color: rightColor }}>{rightLabel}</span>
        </span>
      </div>
    </div>
  );
}

export function Sparkline(props: {
  values: number[];
  accent?: string;
  width?: number;
  height?: number;
}): JSX.Element {
  const { values, accent = 'var(--player)', width = 140, height = 36 } = props;
  const gradientId = useId();
  const draw = useAnimatedNumber(1, 1100);

  const geo = useMemo(() => {
    const w = Math.max(24, width);
    const h = Math.max(14, height);
    const pad = 3;
    const clean: number[] = [];
    for (const v of values) if (Number.isFinite(v)) clean.push(v);
    if (!clean.length) return { w, h, line: '', area: '', len: 0, last: null as [number, number] | null };

    // A single sample still deserves to read as a line rather than a dot.
    const series = clean.length === 1 ? [clean[0], clean[0]] : clean;
    let lo = series[0];
    let hi = series[0];
    for (const v of series) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const n = series.length;
    const pts: [number, number][] = series.map((v, i) => [
      pad + (i / (n - 1)) * (w - pad * 2),
      h - pad - ((v - lo) / span) * (h - pad * 2),
    ]);

    let len = 0;
    for (let i = 1; i < pts.length; i += 1) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    const line = pts.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(2)} ${h} L${pts[0][0].toFixed(2)} ${h} Z`;
    return { w, h, line, area, len, last: pts[pts.length - 1] };
  }, [values, width, height]);

  return (
    <svg
      width={geo.w}
      height={geo.h}
      viewBox={`0 0 ${geo.w} ${geo.h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ color: accent, display: 'block', width: '100%', height: geo.h }}
    >
      {geo.line ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'currentColor', stopOpacity: 0.32 }} />
              <stop offset="100%" style={{ stopColor: 'currentColor', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <path d={geo.area} fill={`url(#${gradientId})`} opacity={draw} />
          <path
            d={geo.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            strokeDasharray={geo.len}
            strokeDashoffset={geo.len * (1 - draw)}
          />
          {geo.last ? (
            <circle
              cx={geo.last[0]}
              cy={geo.last[1]}
              r={2}
              fill="currentColor"
              opacity={draw}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </>
      ) : (
        <path
          d={`M3 ${geo.h / 2} L${geo.w - 3} ${geo.h / 2}`}
          fill="none"
          stroke="var(--edge2)"
          strokeWidth={1}
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
