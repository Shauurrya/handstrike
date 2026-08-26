import type { CSSProperties, ReactNode } from 'react';

/**
 * Developer read-out for the vision -> combat pipeline.
 *
 * This is instrumentation, not a feature: everything is monospace, dense and
 * fixed-precision so a value that changes by 0.01 between frames is visible as a
 * digit flip rather than as text that jitters sideways. It is deliberately the
 * only surface in the game that looks like a terminal.
 */

export interface DebugPanelProps {
  visible: boolean;
  fps: number;
  visionFps: number;
  inferenceMs: number;
  backend: string;
  assetSource: string;
  resolution: string;
  particles: number;
  left: { tracked: boolean; x: number; y: number; speed: number; accel: number; palm: number };
  right: { tracked: boolean; x: number; y: number; speed: number; accel: number; palm: number };
  poseTracked: boolean;
  lean: number;
  crouch: number;
  lastAction: string | null;
  confidence: number;
  aiState: string;
  aiReason: string;
  aiAdaptation: string;
  gap: number;
  phase: string;
  thresholds: { punchSpeed: number; punchTravel: number; dodge: number; duck: number; guard: number };
  onClose(): void;
}

type HandDebug = DebugPanelProps['left'];

const PANEL_W = 236;

/** Non-finite values are a real failure mode here, so they get their own glyph. */
const fmt = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : '--.--');

/** Keeps the sign column occupied so signed values do not shift as they cross 0. */
const signed = (v: number, digits = 2): string =>
  Number.isFinite(v) ? `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(digits)}` : '--.--';

const trackColor = (on: boolean): string => (on ? 'var(--good)' : 'var(--ink-faint)');

const confColor = (c: number): string =>
  c >= 0.66 ? 'var(--good)' : c >= 0.33 ? 'var(--warn)' : 'var(--ink-faint)';

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  minWidth: 0,
};

const keyStyle: CSSProperties = {
  color: 'var(--ink-faint)',
  letterSpacing: '0.06em',
  flexShrink: 0,
};

const valStyle: CSSProperties = {
  textAlign: 'right',
  maxWidth: '64%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function Row({ k, v, color }: { k: string; v: ReactNode; color?: string }) {
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{k}</span>
      <span style={{ ...valStyle, color: color ?? 'var(--ink)' }}>{v}</span>
    </div>
  );
}

function Section({ title, accent, children }: { title: string; accent?: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 7 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 3,
          color: accent ?? 'var(--ink-dim)',
          letterSpacing: '0.14em',
          fontSize: 9,
        }}
      >
        <span>{title}</span>
        {/* Rule fills whatever the label leaves, so headers read as one band. */}
        <span style={{ flex: 1, height: 1, backgroundColor: 'var(--edge)' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</div>
    </section>
  );
}

function HandSection({ title, hand }: { title: string; hand: HandDebug }) {
  const c = trackColor(hand.tracked);
  return (
    <Section title={title} accent={c}>
      <Row k="X / Y" v={`${fmt(hand.x, 3)} ${fmt(hand.y, 3)}`} color={c} />
      <Row k="SPEED" v={fmt(hand.speed)} color={c} />
      <Row k="ACCEL" v={fmt(hand.accel)} color={c} />
      <Row k="PALM" v={fmt(hand.palm, 3)} color={c} />
    </Section>
  );
}

export function DebugPanel({
  visible,
  fps,
  visionFps,
  inferenceMs,
  backend,
  assetSource,
  resolution,
  particles,
  left,
  right,
  poseTracked,
  lean,
  crouch,
  lastAction,
  confidence,
  aiState,
  aiReason,
  aiAdaptation,
  gap,
  phase,
  thresholds,
  onClose,
}: DebugPanelProps) {
  if (!visible) return null;

  const poseColor = trackColor(poseTracked);

  return (
    <aside
      className="hs-interactive hs-fade-in"
      aria-label="Debug panel"
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 40,
        width: PANEL_W,
        maxHeight: 'calc(100% - 20px)',
        overflowY: 'auto',
        padding: '7px 9px 9px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        lineHeight: 1.42,
        fontVariantNumeric: 'tabular-nums',
        fontFeatureSettings: '"tnum" 1',
        color: 'var(--ink)',
        backgroundColor: 'rgba(6, 7, 13, 0.88)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--edge)',
        borderRadius: 'var(--r-sm)',
        boxShadow: 'var(--shadow-2)',
      }}
    >
      <header style={{ ...rowStyle, alignItems: 'center' }}>
        <span style={{ color: 'var(--player)', letterSpacing: '0.18em', fontSize: 9 }}>
          DEBUG
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close debug panel"
          style={{
            width: 15,
            height: 15,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1,
            color: 'var(--ink-faint)',
            border: '1px solid var(--edge)',
            borderRadius: 3,
          }}
        >
          x
        </button>
      </header>

      <Section title="TRACKING">
        <Row k="LEFT" v={left.tracked ? 'TRACKED' : 'LOST'} color={trackColor(left.tracked)} />
        <Row k="RIGHT" v={right.tracked ? 'TRACKED' : 'LOST'} color={trackColor(right.tracked)} />
        <Row k="POSE" v={poseTracked ? 'TRACKED' : 'LOST'} color={poseColor} />
      </Section>

      <HandSection title="LEFT HAND" hand={left} />
      <HandSection title="RIGHT HAND" hand={right} />

      <Section title="POSE" accent={poseColor}>
        <Row k="LEAN" v={signed(lean)} color={poseColor} />
        <Row k="CROUCH" v={fmt(crouch)} color={poseColor} />
      </Section>

      <Section title="ACTION">
        <Row k="LAST" v={lastAction ?? '—'} color={lastAction ? 'var(--ink)' : 'var(--ink-faint)'} />
        <Row k="CONF" v={fmt(confidence)} color={confColor(confidence)} />
        <Row k="T.SPEED" v={fmt(thresholds.punchSpeed)} color="var(--ink-dim)" />
        <Row k="T.TRAVEL" v={fmt(thresholds.punchTravel)} color="var(--ink-dim)" />
        <Row k="T.DODGE" v={fmt(thresholds.dodge)} color="var(--ink-dim)" />
        <Row k="T.DUCK" v={fmt(thresholds.duck)} color="var(--ink-dim)" />
        <Row k="T.GUARD" v={signed(thresholds.guard)} color="var(--ink-dim)" />
      </Section>

      <Section title="AI" accent="var(--enemy)">
        <Row k="STATE" v={aiState || '—'} />
        <Row k="PHASE" v={phase || '—'} />
        <Row k="GAP" v={fmt(gap, 0)} />
        <Row k="ADAPT" v={aiAdaptation || '—'} color="var(--ink-dim)" />
        {/* Reason is free text from the controller, so it wraps instead of clipping. */}
        <div style={{ color: 'var(--ink-dim)', fontSize: 9, lineHeight: 1.35, wordBreak: 'break-word' }}>
          {aiReason || '—'}
        </div>
      </Section>

      <Section title="ENGINE">
        <Row k="FPS" v={fmt(fps, 1)} color={fps < 50 ? 'var(--warn)' : 'var(--ink)'} />
        <Row k="VIS FPS" v={fmt(visionFps, 1)} color={visionFps < 20 ? 'var(--warn)' : 'var(--ink)'} />
        <Row k="INFER" v={`${fmt(inferenceMs, 1)} ms`} />
        <Row k="BACKEND" v={backend || '—'} color={backend === 'GPU' ? 'var(--good)' : 'var(--ink-dim)'} />
        <Row k="ASSETS" v={assetSource || '—'} color="var(--ink-dim)" />
        <Row k="RES" v={resolution || '—'} color="var(--ink-dim)" />
        <Row k="PARTS" v={fmt(particles, 0)} color="var(--ink-dim)" />
      </Section>
    </aside>
  );
}

export default DebugPanel;
