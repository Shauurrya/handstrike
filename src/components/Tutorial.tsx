import type { ReactNode } from 'react';

export interface TutorialProps {
  onBack(): void;
  onStart(): void;
}

const LINE = 'var(--ink-faint)';
const HOT = 'var(--player)';
const ARROW = 'var(--crit)';

type GestureId = 'punchL' | 'punchR' | 'guard' | 'dodgeL' | 'dodgeR' | 'duck' | 'rage';

interface GuideEntry {
  id: GestureId;
  input: string;
  action: string;
  color: string;
  note: string;
}

const GUIDE: GuideEntry[] = [
  { id: 'punchL', input: 'LEFT HAND', action: 'LEFT PUNCH', color: HOT, note: 'Snap your left hand out and back.' },
  { id: 'punchR', input: 'RIGHT HAND', action: 'RIGHT PUNCH', color: HOT, note: 'Snap your right hand out and back.' },
  { id: 'guard', input: 'BOTH HANDS UP', action: 'GUARD', color: 'var(--good)', note: 'Hold both hands beside your head.' },
  { id: 'dodgeL', input: 'MOVE LEFT', action: 'DODGE LEFT', color: 'var(--counter)', note: 'Shift your whole body left.' },
  { id: 'dodgeR', input: 'MOVE RIGHT', action: 'DODGE RIGHT', color: 'var(--counter)', note: 'Shift your whole body right.' },
  { id: 'duck', input: 'MOVE DOWN', action: 'DUCK', color: 'var(--counter)', note: 'Bend your knees and drop straight down.' },
  { id: 'rage', input: 'BOTH FISTS RAISED HIGH', action: 'RAGE', color: 'var(--rage)', note: 'Throw both fists above your head.' },
];

const KEYBOARD: { keys: string[]; action: string }[] = [
  { keys: ['A', 'D'], action: 'Move left / right' },
  { keys: ['J'], action: 'Left jab' },
  { keys: ['K'], action: 'Right cross' },
  { keys: ['U'], action: 'Left hook' },
  { keys: ['I'], action: 'Right hook' },
  { keys: ['O'], action: 'Uppercut' },
  { keys: ['SPACE'], action: 'Guard' },
  { keys: ['SHIFT'], action: 'Dodge' },
  { keys: ['E'], action: 'Rage' },
  { keys: ['ESC'], action: 'Pause' },
];

/** Arrowheads are drawn as geometry rather than markers so no two diagrams
 *  need to share a <defs> id. */
function Arrow({ x1, y1, x2, y2, color = ARROW }: { x1: number; y1: number; x2: number; y2: number; color?: string }) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = 9;
  const spread = 0.42;
  const ax = x2 - h * Math.cos(a - spread);
  const ay = y2 - h * Math.sin(a - spread);
  const bx = x2 - h * Math.cos(a + spread);
  const by = y2 - h * Math.sin(a + spread);
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={3} strokeLinecap="round" />
      <polygon points={`${x2},${y2} ${ax},${ay} ${bx},${by}`} fill={color} />
    </g>
  );
}

function Figure({
  dx = 0,
  crouch = false,
  ghost = false,
  children,
}: {
  dx?: number;
  crouch?: boolean;
  ghost?: boolean;
  children?: ReactNode;
}) {
  return (
    <g
      transform={`translate(${dx} 0)`}
      fill="none"
      stroke={ghost ? 'var(--edge2)' : LINE}
      strokeWidth={3.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={ghost ? 0.6 : 1}
    >
      {crouch ? (
        <>
          <circle cx={70} cy={42} r={11} />
          <line x1={70} y1={53} x2={70} y2={74} />
          <polyline points="70,74 54,84 58,96" />
          <polyline points="70,74 86,84 82,96" />
        </>
      ) : (
        <>
          <circle cx={70} cy={26} r={11} />
          <line x1={70} y1={37} x2={70} y2={66} />
          <line x1={70} y1={66} x2={56} y2={94} />
          <line x1={70} y1={66} x2={84} y2={94} />
        </>
      )}
      {children}
    </g>
  );
}

function Arm({ points, color, width = 4 }: { points: string; color: string; width?: number }) {
  return <polyline points={points} stroke={color} strokeWidth={width} />;
}

function Glove({ x, y, color }: { x: number; y: number; color: string }) {
  return <circle cx={x} cy={y} r={7.5} fill={color} stroke="none" />;
}

function Diagram({ id }: { id: GestureId }) {
  const body = (() => {
    switch (id) {
      case 'punchL':
        return (
          <>
            <Figure>
              <Arm points="70,44 86,42 80,26" color={LINE} />
              <Glove x={80} y={24} color={LINE} />
              <Arm points="70,44 50,45 30,46" color={HOT} />
              <Glove x={26} y={46} color={HOT} />
            </Figure>
            <Arrow x1={60} y1={108} x2={22} y2={108} />
          </>
        );
      case 'punchR':
        return (
          <>
            <Figure>
              <Arm points="70,44 54,42 60,26" color={LINE} />
              <Glove x={60} y={24} color={LINE} />
              <Arm points="70,44 90,45 110,46" color={HOT} />
              <Glove x={114} y={46} color={HOT} />
            </Figure>
            <Arrow x1={80} y1={108} x2={118} y2={108} />
          </>
        );
      case 'guard':
        return (
          <>
            <path d="M44,20 A28,28 0 0 1 96,20" fill="none" stroke="var(--good)" strokeWidth={2.5} strokeDasharray="5 6" />
            <Figure>
              <Arm points="70,46 54,44 58,26" color="var(--good)" />
              <Glove x={58} y={24} color="var(--good)" />
              <Arm points="70,46 86,44 82,26" color="var(--good)" />
              <Glove x={82} y={24} color="var(--good)" />
            </Figure>
            <Arrow x1={30} y1={76} x2={30} y2={44} color="var(--good)" />
            <Arrow x1={110} y1={76} x2={110} y2={44} color="var(--good)" />
          </>
        );
      case 'dodgeL':
        return (
          <>
            <Figure dx={10} ghost>
              <Arm points="70,46 54,44 58,26" color="var(--edge2)" width={3.4} />
              <Arm points="70,46 86,44 82,26" color="var(--edge2)" width={3.4} />
            </Figure>
            <Figure dx={-22}>
              <Arm points="70,46 54,44 58,26" color="var(--counter)" />
              <Glove x={58} y={24} color="var(--counter)" />
              <Arm points="70,46 86,44 82,26" color="var(--counter)" />
              <Glove x={82} y={24} color="var(--counter)" />
            </Figure>
            <Arrow x1={94} y1={108} x2={48} y2={108} color="var(--counter)" />
          </>
        );
      case 'dodgeR':
        return (
          <>
            <Figure dx={-10} ghost>
              <Arm points="70,46 54,44 58,26" color="var(--edge2)" width={3.4} />
              <Arm points="70,46 86,44 82,26" color="var(--edge2)" width={3.4} />
            </Figure>
            <Figure dx={22}>
              <Arm points="70,46 54,44 58,26" color="var(--counter)" />
              <Glove x={58} y={24} color="var(--counter)" />
              <Arm points="70,46 86,44 82,26" color="var(--counter)" />
              <Glove x={82} y={24} color="var(--counter)" />
            </Figure>
            <Arrow x1={46} y1={108} x2={92} y2={108} color="var(--counter)" />
          </>
        );
      case 'duck':
        return (
          <>
            <Figure ghost>
              <Arm points="70,46 54,44 58,26" color="var(--edge2)" width={3.4} />
              <Arm points="70,46 86,44 82,26" color="var(--edge2)" width={3.4} />
            </Figure>
            <Figure crouch>
              <Arm points="70,60 56,58 62,42" color="var(--counter)" />
              <Glove x={62} y={40} color="var(--counter)" />
              <Arm points="70,60 84,58 78,42" color="var(--counter)" />
              <Glove x={78} y={40} color="var(--counter)" />
            </Figure>
            <Arrow x1={116} y1={30} x2={116} y2={82} color="var(--counter)" />
          </>
        );
      case 'rage':
      default:
        return (
          <>
            <Figure>
              <Arm points="70,44 56,28 52,12" color="var(--rage)" />
              <Glove x={52} y={10} color="var(--rage)" />
              <Arm points="70,44 84,28 88,12" color="var(--rage)" />
              <Glove x={88} y={10} color="var(--rage)" />
            </Figure>
            <g stroke="var(--warn)" strokeWidth={2.6} strokeLinecap="round">
              <line x1={38} y1={8} x2={44} y2={2} />
              <line x1={34} y1={18} x2={41} y2={16} />
              <line x1={40} y1={30} x2={46} y2={25} />
              <line x1={102} y1={8} x2={96} y2={2} />
              <line x1={106} y1={18} x2={99} y2={16} />
              <line x1={100} y1={30} x2={94} y2={25} />
            </g>
            <Arrow x1={22} y1={96} x2={22} y2={54} color="var(--rage)" />
            <Arrow x1={118} y1={96} x2={118} y2={54} color="var(--rage)" />
          </>
        );
    }
  })();

  return (
    <svg viewBox="0 0 140 118" width="100%" height={124} role="presentation" focusable="false" aria-hidden="true">
      {body}
    </svg>
  );
}

export function Tutorial({ onBack, onStart }: TutorialProps) {
  return (
    <div className="hs-screen">
      <div className="hs-screen__inner hs-stack" style={{ gap: 16 }}>
        <header className="hs-spread" style={{ alignItems: 'flex-end' }}>
          <div>
            <h1 className="hs-title" style={{ margin: 0, fontSize: 46, lineHeight: 1 }}>
              HOW TO PLAY
            </h1>
            <p className="hs-subtitle" style={{ margin: '4px 0 0' }}>YOUR BODY IS THE CONTROLLER</p>
          </div>
          <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" onClick={onBack}>
            BACK
          </button>
        </header>

        <div className="hs-stack" style={{ gap: 18, maxHeight: '64vh', overflowY: 'auto', padding: 4 }}>
          {/* Deliberately first: knowing which fighter is yours and what the
              corner panel is showing has to land before any gesture does. */}
          <section className="hs-stack" style={{ gap: 10 }} aria-label="Reading the screen">
            <span className="hs-label">READING THE SCREEN</span>
            <div className="hs-grid">
              <div className="hs-panel hs-stack" style={{ gap: 8 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 22,
                    letterSpacing: '0.05em',
                    color: 'var(--player)',
                  }}
                >
                  YOU — ON THE LEFT
                </span>
                <span className="hs-hint">
                  Your fighter stands on the left, tagged <strong style={{ color: 'var(--player)' }}>YOU</strong> with a
                  teal ring on the mat. Everything you do in front of the camera happens to that fighter. Your health
                  and stamina are the top-left bars.
                </span>
              </div>

              <div className="hs-panel hs-stack" style={{ gap: 8 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 22,
                    letterSpacing: '0.05em',
                    color: 'var(--enemy)',
                  }}
                >
                  OPPONENT — ON THE RIGHT
                </span>
                <span className="hs-hint">
                  The AI fighter stands on the right in <strong style={{ color: 'var(--enemy)' }}>magenta</strong>, with
                  its name and bars in the top-right. It blocks, dodges, counters and learns your habits as the fight
                  goes on.
                </span>
              </div>

              <div className="hs-panel hs-stack" style={{ gap: 8 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 22,
                    letterSpacing: '0.05em',
                    color: 'var(--crit)',
                  }}
                >
                  CAMERA PANEL
                </span>
                <span className="hs-hint">
                  Bottom-right shows exactly what the camera sees: your{' '}
                  <strong style={{ color: '#31e6c8' }}>left hand in teal</strong>,{' '}
                  <strong style={{ color: '#ffd34d' }}>right hand in gold</strong>, and your{' '}
                  <strong style={{ color: 'var(--counter)' }}>body in violet</strong>. Trails follow fast movement and a
                  ring bursts wherever a punch is read. If a skeleton is missing, the game cannot see that part of you.
                </span>
              </div>
            </div>
          </section>

          <section className="hs-stack" style={{ gap: 10 }} aria-label="Gesture controls">
            <span className="hs-label">GESTURES</span>
            <div className="hs-grid">
              {GUIDE.map((g) => (
                <div key={g.id} className="hs-panel hs-stack" style={{ gap: 8 }}>
                  <Diagram id={g.id} />
                  <div className="hs-divider" />
                  <div className="hs-stack" style={{ gap: 4 }}>
                    <span className="hs-label">{g.input}</span>
                    <span
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 22,
                        letterSpacing: '0.05em',
                        color: g.color,
                      }}
                    >
                      &rarr; {g.action}
                    </span>
                    <span className="hs-hint">{g.note}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section
            className="hs-panel hs-stack"
            aria-label="Detection tips"
            style={{
              gap: 10,
              borderLeft: '3px solid var(--warn)',
              background: 'linear-gradient(90deg, rgba(255,176,32,0.07), transparent 55%)',
            }}
          >
            <span className="hs-label" style={{ color: 'var(--warn)' }}>
              READ THIS FIRST
            </span>
            <ul className="hs-stack" style={{ gap: 8, margin: 0, paddingLeft: 20, color: 'var(--ink)' }}>
              <li style={{ lineHeight: 1.5 }}>Throw punches using quick visible hand movements.</li>
              <li style={{ lineHeight: 1.5 }}>Do not punch directly toward the camera.</li>
              <li style={{ lineHeight: 1.5 }}>Keep your hands visible to the webcam.</li>
            </ul>
          </section>

          <section className="hs-stack" style={{ gap: 10 }} aria-label="Keyboard fallback">
            <div className="hs-spread" style={{ alignItems: 'baseline' }}>
              <span className="hs-label">KEYBOARD FALLBACK</span>
              <span className="hs-label" style={{ textTransform: 'none' }}>
                Works with or without the camera.
              </span>
            </div>
            <div className="hs-panel hs-panel--flush">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <caption className="hs-label" style={{ captionSide: 'top', textAlign: 'left', padding: '10px 14px' }}>
                  KEY BINDINGS
                </caption>
                <thead>
                  <tr>
                    <th className="hs-label" style={{ textAlign: 'left', padding: '6px 14px', width: 170 }}>
                      KEY
                    </th>
                    <th className="hs-label" style={{ textAlign: 'left', padding: '6px 14px' }}>
                      ACTION
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {KEYBOARD.map((row) => (
                    <tr key={row.action} style={{ borderTop: '1px solid var(--edge)' }}>
                      <td style={{ padding: '7px 14px' }}>
                        {row.keys.map((k, i) => (
                          <span key={k}>
                            {i > 0 ? <span style={{ color: 'var(--ink-faint)', margin: '0 6px' }}>/</span> : null}
                            <span className="hs-kbd">{k}</span>
                          </span>
                        ))}
                      </td>
                      <td style={{ padding: '7px 14px', color: 'var(--ink-dim)', fontSize: 13 }}>{row.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="hs-spread" style={{ alignItems: 'center' }}>
          <button type="button" className="hs-btn hs-btn--ghost" onClick={onBack}>
            BACK
          </button>
          <button
            type="button"
            className="hs-btn hs-btn--primary"
            onClick={onStart}
            style={{ minWidth: 260, fontFamily: 'var(--font-display)', fontSize: 22, letterSpacing: '0.1em' }}
          >
            START FIGHTING
          </button>
        </div>
      </div>
    </div>
  );
}

export default Tutorial;
