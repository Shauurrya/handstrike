import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Settings } from '@/store/appState';

export interface SettingsScreenProps {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onBack(): void;
  onRecalibrate(): void;
  onResetProgress(): void;
}

/** ms the destructive reset stays armed before it disarms itself again. */
const ARM_WINDOW_MS = 4000;

const trackStyle = (on: boolean): CSSProperties => ({
  position: 'relative',
  flex: '0 0 auto',
  width: 46,
  height: 24,
  padding: 0,
  borderRadius: 999,
  border: `1px solid ${on ? 'var(--player)' : 'var(--edge2)'}`,
  background: on ? 'rgba(49, 230, 200, 0.16)' : 'var(--panel2)',
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease',
});

const knobStyle = (on: boolean): CSSProperties => ({
  position: 'absolute',
  top: 3,
  left: 3,
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: on ? 'var(--player)' : 'var(--ink-faint)',
  boxShadow: on ? 'var(--glow-player)' : 'none',
  transform: on ? 'translateX(22px)' : 'none',
  transition: 'transform 140ms ease, background 140ms ease',
});

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="hs-panel hs-stack" style={{ gap: 14 }} aria-label={title}>
      <span className="hs-label" style={{ color: 'var(--player)' }}>
        {title}
      </span>
      <div className="hs-divider" />
      {children}
    </section>
  );
}

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="hs-spread" style={{ alignItems: 'center', gap: 18 }}>
      <span className="hs-stack" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 14, color: 'var(--ink)' }}>{label}</span>
        {hint ? <span className="hs-hint">{hint}</span> : null}
      </span>
      {control}
    </div>
  );
}

function Toggle({ label, hint, checked, onToggle }: { label: string; hint?: string; checked: boolean; onToggle(next: boolean): void }) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={() => onToggle(!checked)}
          style={trackStyle(checked)}
        >
          <span aria-hidden="true" style={knobStyle(checked)} />
        </button>
      }
    />
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  onInput,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onInput(next: number): void;
}) {
  return (
    <div className="hs-stack" style={{ gap: 8 }}>
      <div className="hs-spread" style={{ alignItems: 'baseline' }}>
        <span style={{ fontSize: 14, color: 'var(--ink)' }}>{label}</span>
        <span className="hs-num" style={{ fontSize: 13, color: 'var(--player)' }}>
          {display}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onInput(Number(e.currentTarget.value))}
        style={{ width: '100%', accentColor: 'var(--player)', cursor: 'pointer' }}
      />
      {hint ? (
        <span className="hs-label" style={{ textTransform: 'none', lineHeight: 1.45 }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  hint,
  options,
  value,
  onSelect,
}: {
  label: string;
  hint?: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onSelect(next: T): void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <div className="hs-row" role="group" aria-label={label} style={{ gap: 6 }}>
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                aria-pressed={active}
                className={`hs-btn hs-btn--sm${active ? ' is-active' : ''}`}
                onClick={() => onSelect(opt.value)}
                style={{ minWidth: 56 }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      }
    />
  );
}

const FEED_MODE_OPTIONS = [
  { value: 'camera' as const, label: 'CAMERA' },
  { value: 'sketch' as const, label: 'SKETCH' },
];

const PARTICLE_OPTIONS = [
  { value: 'low' as const, label: 'LOW' },
  { value: 'medium' as const, label: 'MED' },
  { value: 'high' as const, label: 'HIGH' },
];

const ROUND_COUNT_OPTIONS = [
  { value: 1, label: '1' },
  { value: 3, label: '3' },
  { value: 5, label: '5' },
];

const ROUND_LENGTH_OPTIONS = [
  { value: 60, label: '1:00' },
  { value: 120, label: '2:00' },
  { value: 180, label: '3:00' },
];

export function SettingsScreen({ settings, onChange, onBack, onRecalibrate, onResetProgress }: SettingsScreenProps) {
  const [resetArmed, setResetArmed] = useState(false);
  const armTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    },
    [],
  );

  // Wiping progress is unrecoverable, so the button arms first and only fires on
  // a second, deliberate click.
  const onResetClick = () => {
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    if (resetArmed) {
      setResetArmed(false);
      onResetProgress();
      return;
    }
    setResetArmed(true);
    armTimer.current = window.setTimeout(() => {
      armTimer.current = null;
      setResetArmed(false);
    }, ARM_WINDOW_MS);
  };

  return (
    <div className="hs-screen">
      <div className="hs-screen__inner hs-stack" style={{ gap: 16 }}>
        <header className="hs-spread" style={{ alignItems: 'flex-end' }}>
          <div>
            <h1 className="hs-title" style={{ margin: 0, fontSize: 46, lineHeight: 1 }}>
              SETTINGS
            </h1>
            <p className="hs-subtitle" style={{ margin: '4px 0 0' }}>TUNE THE RING</p>
          </div>
          <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" onClick={onBack}>
            BACK
          </button>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 16,
            alignItems: 'start',
            maxHeight: '66vh',
            overflowY: 'auto',
            padding: 4,
          }}
        >
          <Group title="AUDIO">
            <Toggle label="Sound effects" checked={settings.sound} onToggle={(v) => onChange({ sound: v })} />
            <Toggle label="Music" checked={settings.music} onToggle={(v) => onChange({ music: v })} />
            <Slider
              label="Master volume"
              value={settings.masterVolume}
              min={0}
              max={1}
              step={0.05}
              display={`${Math.round(settings.masterVolume * 100)}%`}
              onInput={(v) => onChange({ masterVolume: v })}
            />
          </Group>

          <Group title="CONTROLS">
            <Slider
              label="Detection sensitivity"
              value={settings.sensitivity}
              min={0.5}
              max={1.6}
              step={0.05}
              display={settings.sensitivity.toFixed(2)}
              hint="Lower values make punches trigger more easily. Raise it if the game reads punches you did not throw."
              onInput={(v) => onChange({ sensitivity: v })}
            />
            <Toggle
              label="Keyboard fallback"
              hint="Play with the keyboard when the camera is unavailable."
              checked={settings.keyboardFallback}
              onToggle={(v) => onChange({ keyboardFallback: v })}
            />
            <Row
              label="Calibration"
              hint="Re-measure your neutral stance and reach."
              control={
                <button type="button" className="hs-btn hs-btn--sm" onClick={onRecalibrate}>
                  RECALIBRATE
                </button>
              }
            />
          </Group>

          <Group title="DISPLAY">
            <Toggle
              label="Camera panel"
              hint="Live webcam preview in the corner of the fight."
              checked={settings.showCameraPanel}
              onToggle={(v) => onChange({ showCameraPanel: v })}
            />
            <Segmented
              label="Feed style"
              hint="CAMERA shows your webcam with tracking drawn on top. SKETCH shows the glowing skeleton alone on black — easier to read, and your room stays off screen."
              options={FEED_MODE_OPTIONS}
              value={settings.feedMode}
              onSelect={(v) => onChange({ feedMode: v })}
            />
            <Toggle
              label="Tracking overlay"
              hint="Skeleton, motion trails and a burst wherever a punch is read. Shows you exactly what the camera sees."
              checked={settings.showLandmarks}
              onToggle={(v) => onChange({ showLandmarks: v })}
            />
            <Toggle label="Screen shake" checked={settings.screenShake} onToggle={(v) => onChange({ screenShake: v })} />
            <Segmented
              label="Particles"
              options={PARTICLE_OPTIONS}
              value={settings.particles}
              onSelect={(v) => onChange({ particles: v })}
            />
            <Toggle
              label="Reduced motion"
              hint="Damp flashes, shake and camera moves."
              checked={settings.reducedMotion}
              onToggle={(v) => onChange({ reducedMotion: v })}
            />
            <Toggle
              label="Mirror camera"
              hint="Show the feed the way a mirror would."
              checked={settings.mirrorCamera}
              onToggle={(v) => onChange({ mirrorCamera: v })}
            />
          </Group>

          <Group title="FIGHT">
            <Segmented
              label="Rounds"
              options={ROUND_COUNT_OPTIONS}
              value={settings.roundCount}
              onSelect={(v) => onChange({ roundCount: v })}
            />
            <Segmented
              label="Round length"
              options={ROUND_LENGTH_OPTIONS}
              value={settings.roundSeconds}
              onSelect={(v) => onChange({ roundSeconds: v })}
            />
          </Group>

          <Group title="DEVELOPER">
            <Toggle
              label="Debug panel"
              hint="Show vision timings, AI state and hitboxes."
              checked={settings.debug}
              onToggle={(v) => onChange({ debug: v })}
            />
          </Group>

          <Group title="DANGER ZONE">
            <Row
              label="Reset all progress"
              hint={
                resetArmed
                  ? 'Click again to erase career progress, records and calibration.'
                  : 'Erases career progress, records and calibration.'
              }
              control={
                <button type="button" className="hs-btn hs-btn--danger hs-btn--sm" onClick={onResetClick}>
                  {resetArmed ? 'CONFIRM RESET' : 'RESET ALL PROGRESS'}
                </button>
              }
            />
          </Group>
        </div>

        <div className="hs-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="hs-btn hs-btn--primary" onClick={onBack} style={{ minWidth: 200 }}>
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsScreen;
