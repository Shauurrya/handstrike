/**
 * Shown when the camera or the vision model cannot start.
 *
 * A failed permission prompt is the single most likely first-run experience, so
 * this screen is written as a calm set of next steps rather than an error: no
 * codes in the headline, no blame, and a keyboard route out so the player can
 * reach the fight even if the camera never works on this machine.
 */

export interface CameraErrorScreenProps {
  kind: string;
  message: string;
  onRetry(): void;
  onUseKeyboard(): void;
  onBack(): void;
}

/** Plain-language name for the situation — never the raw error code. */
const HEADLINES: Record<string, string> = {
  DENIED: 'PERMISSION NEEDED',
  NOT_FOUND: 'NO CAMERA DETECTED',
  IN_USE: 'CAMERA IS BUSY',
  INSECURE_CONTEXT: 'SECURE CONNECTION REQUIRED',
  UNSUPPORTED: 'BROWSER NOT SUPPORTED',
  MODEL_FAILED: 'VISION MODEL UNAVAILABLE',
};

const REMEDIES: Record<string, string[]> = {
  DENIED: [
    'Click the camera icon at the right of the browser address bar.',
    'Choose "Allow" for this site, then press TRY AGAIN.',
    'If the icon is missing, the block may be set in the site permissions panel.',
  ],
  NOT_FOUND: [
    'Connect a webcam, or check that a built-in one is switched on.',
    'Reload the page once the camera is plugged in.',
    'External cameras sometimes need a moment to be recognised.',
  ],
  IN_USE: [
    'Another app is holding the camera — Zoom, Teams, OBS or a second browser tab.',
    'Close it completely, then press TRY AGAIN.',
  ],
  INSECURE_CONTEXT: [
    'Browsers only hand out the camera over HTTPS or on localhost.',
    'Open the game from an https:// address or from http://localhost.',
  ],
  UNSUPPORTED: [
    'This browser does not expose the camera APIs the game needs.',
    'A recent Chromium browser — Chrome, Edge or Brave — is the safest choice.',
  ],
  MODEL_FAILED: [
    'The hand and pose model could not finish loading.',
    'Check the connection and reload the page.',
    'A strict content blocker can also stop the model files from arriving.',
  ],
};

const GENERIC: string[] = [
  'Press TRY AGAIN — a fresh camera request often succeeds.',
  'If nothing changes, reload the page and start again.',
  'Keyboard play is always available in the meantime.',
];

function CameraIcon() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5A2 2 0 0 1 5 6.5h3l1.4-2h5.2L16 6.5h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12.5" r="3.4" />
      <path d="M3.5 3.5 20.5 21" opacity="0.9" />
    </svg>
  );
}

export function CameraErrorScreen({ kind, message, onRetry, onUseKeyboard, onBack }: CameraErrorScreenProps) {
  const key = kind.toUpperCase();
  const headline = HEADLINES[key] ?? 'CAMERA UNAVAILABLE';
  const steps = REMEDIES[key] ?? GENERIC;

  return (
    <div className="hs-screen hs-fade-in">
      <div className="hs-screen__inner" style={{ maxWidth: 640, gap: 18 }}>
        <div className="hs-stack" style={{ gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <span style={{ color: 'var(--warn)', opacity: 0.85 }}>
            <CameraIcon />
          </span>
          <span className="hs-subtitle" style={{ fontSize: 10, letterSpacing: '0.4em', color: 'var(--warn)' }}>
            {headline}
          </span>
          <h1
            className="hs-title"
            style={{
              fontSize: 'clamp(1.9rem, 3.6vw, 2.85rem)',
              textShadow: '0 0 30px rgba(255, 176, 32, 0.22)',
            }}
          >
            CAMERA NOT AVAILABLE
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--ink-dim)', maxWidth: 520 }}>
            {message}
          </p>
        </div>

        <div className="hs-panel">
          <span className="hs-label" style={{ letterSpacing: '0.24em' }}>TRY THIS</span>
          <ul className="hs-stack" style={{ gap: 9, marginTop: 12 }}>
            {steps.map((step) => (
              <li key={step} className="hs-row" style={{ gap: 11, alignItems: 'flex-start' }}>
                {/* Neon tick standing in for a bullet — flush with the first text line. */}
                <span
                  aria-hidden="true"
                  style={{
                    flex: '0 0 auto',
                    width: 10,
                    height: 2,
                    marginTop: 9,
                    borderRadius: 1,
                    backgroundColor: 'var(--warn)',
                    boxShadow: '0 0 8px rgba(255, 176, 32, 0.6)',
                  }}
                />
                <span style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink)' }}>{step}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="hs-row" style={{ gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="hs-btn hs-btn--primary" onClick={onRetry}>
            TRY AGAIN
          </button>
          <button type="button" className="hs-btn" onClick={onUseKeyboard}>
            PLAY WITH KEYBOARD
          </button>
          <button type="button" className="hs-btn hs-btn--ghost" onClick={onBack}>
            BACK TO MENU
          </button>
        </div>

        <p style={{ fontSize: 11.5, textAlign: 'center', color: 'var(--ink-faint)' }}>
          Keyboard play runs the full fight — you throw punches with keys instead of your hands.
        </p>
      </div>
    </div>
  );
}

export default CameraErrorScreen;
