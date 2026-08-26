import { useEffect, useRef, useState } from 'react';

export interface MainMenuProps {
  cameraStatus: 'idle' | 'requesting' | 'ready' | 'error';
  cameraMessage: string | null;
  onQuickFight(): void;
  onTraining(): void;
  onCareer(): void;
  onHowToPlay(): void;
  onSettings(): void;
  onEnableCamera(): void;
  careerRank: string;
  hasProgress: boolean;
}

interface MenuItem {
  id: string;
  label: string;
  caption: string;
  primary?: boolean;
  run(): void;
}

/** Dot colour, LED class and copy for each camera state. */
const CAMERA_META: Record<MainMenuProps['cameraStatus'], { dotClass: string; color: string; text: string }> = {
  idle: { dotClass: 'hs-dot hs-dot--off', color: 'var(--ink-faint)', text: 'CAMERA OFFLINE' },
  requesting: { dotClass: 'hs-dot hs-dot--warn', color: 'var(--warn)', text: 'REQUESTING ACCESS' },
  ready: { dotClass: 'hs-dot hs-dot--on', color: 'var(--good)', text: 'CAMERA READY' },
  error: { dotClass: 'hs-dot hs-dot--off', color: 'var(--enemy)', text: 'CAMERA UNAVAILABLE' },
};

export function MainMenu({
  cameraStatus,
  cameraMessage,
  onQuickFight,
  onTraining,
  onCareer,
  onHowToPlay,
  onSettings,
  onEnableCamera,
  careerRank,
  hasProgress,
}: MainMenuProps) {
  const [index, setIndex] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  // The window listener is installed once, so it reads the live menu through refs
  // rather than being torn down and rebuilt on every parent re-render.
  const itemsRef = useRef<MenuItem[]>([]);
  const indexRef = useRef(0);

  const items: MenuItem[] = [
    { id: 'quick', label: 'QUICK FIGHT', caption: 'Exhibition bout', primary: true, run: onQuickFight },
    { id: 'training', label: 'TRAINING', caption: 'Reaction and power drills', run: onTraining },
    { id: 'career', label: 'CAREER', caption: 'Climb the ladder to the belt', run: onCareer },
    { id: 'howto', label: 'HOW TO PLAY', caption: 'Gestures and controls', run: onHowToPlay },
    { id: 'settings', label: 'SETTINGS', caption: 'Detection, audio, display', run: onSettings },
  ];

  useEffect(() => {
    itemsRef.current = items;
    indexRef.current = index;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = itemsRef.current;
      if (!list.length) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const next = (indexRef.current + dir + list.length) % list.length;
        indexRef.current = next;
        setIndex(next);
        buttons.current[next]?.focus();
        return;
      }

      if (e.key === 'Enter') {
        // A focused button already fires on Enter; only synthesise the activation
        // when focus is parked somewhere else (e.g. straight after page load).
        if (document.activeElement instanceof HTMLButtonElement) return;
        e.preventDefault();
        list[indexRef.current]?.run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cam = CAMERA_META[cameraStatus];
  const showEnable = cameraStatus === 'idle' || cameraStatus === 'error';

  return (
    <div className="hs-screen">
      <div className="hs-scanlines" aria-hidden="true" />
      <div className="hs-screen__inner hs-stack" style={{ gap: 26, maxWidth: 720 }}>
        <header className="hs-stack" style={{ gap: 6, alignItems: 'center', textAlign: 'center' }}>
          <h1 className="hs-title" style={{ margin: 0, lineHeight: 0.9, letterSpacing: '0.02em' }}>
            <span style={{ color: 'var(--ink)' }}>HAND</span>
            <span style={{ color: 'var(--player)', textShadow: 'var(--glow-player)' }}>STRIKE</span>
          </h1>
          <p className="hs-subtitle" style={{ margin: 0 }}>REAL-TIME WEBCAM BOXING</p>
          {hasProgress ? (
            <span className="hs-badge" style={{ marginTop: 8 }}>
              RANK <span className="hs-num" style={{ color: 'var(--crit)' }}>{careerRank}</span>
            </span>
          ) : null}
        </header>

        <nav className="hs-stack" style={{ gap: 10 }} aria-label="Main menu">
          {items.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              className={`hs-btn${item.primary ? ' hs-btn--primary' : ''}${i === index ? ' is-active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onFocus={() => setIndex(i)}
              onClick={item.run}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'flex-start',
                gap: 14,
                textAlign: 'left',
                paddingTop: 14,
                paddingBottom: 14,
              }}
            >
              <span className="hs-num" style={{ opacity: 0.5, fontSize: 12 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 26, letterSpacing: '0.04em' }}>
                {item.label}
              </span>
              <span className="hs-label" style={{ marginLeft: 'auto' }}>
                {item.caption}
              </span>
            </button>
          ))}
        </nav>

        <div className="hs-panel hs-stack" style={{ gap: 10 }}>
          <div className="hs-spread" style={{ alignItems: 'center', gap: 12 }}>
            <div className="hs-row" style={{ alignItems: 'center', gap: 10 }}>
              <span className={cam.dotClass} style={{ background: cam.color }} aria-hidden="true" />
              <span className="hs-value" style={{ color: cam.color, fontSize: 13 }}>
                {cam.text}
              </span>
            </div>
            {showEnable ? (
              <button type="button" className="hs-btn hs-btn--sm" onClick={onEnableCamera}>
                ENABLE CAMERA
              </button>
            ) : null}
          </div>

          {cameraMessage ? (
            <p className="hs-label" style={{ margin: 0, textTransform: 'none', lineHeight: 1.5 }}>
              {cameraMessage}
            </p>
          ) : null}

          <div className="hs-divider" />

          <p className="hs-label" style={{ margin: 0, textTransform: 'none', color: 'var(--ink-faint)' }}>
            Camera processing happens locally on your device.
          </p>
        </div>

        <p className="hs-label" style={{ margin: 0, textAlign: 'center' }}>
          <span className="hs-kbd">&uarr;</span> <span className="hs-kbd">&darr;</span> NAVIGATE
          <span style={{ margin: '0 10px', color: 'var(--edge2)' }}>/</span>
          <span className="hs-kbd">ENTER</span> SELECT
        </p>
      </div>
    </div>
  );
}

export default MainMenu;
