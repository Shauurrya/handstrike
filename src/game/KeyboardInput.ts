/**
 * Keyboard fallback.
 *
 * The webcam is the intended controller, but a keyboard path matters for three
 * real reasons: developing without waving at a laptop for an hour, playing when
 * no camera is available, and accessibility for anyone who cannot use the
 * motion controls.
 */

export type KeyAction =
  | 'jab'
  | 'cross'
  | 'hookL'
  | 'hookR'
  | 'uppercut'
  | 'dodgeLeft'
  | 'dodgeRight'
  | 'duck'
  | 'rage'
  | 'pause';

const ACTION_KEYS: Record<string, KeyAction> = {
  KeyJ: 'jab',
  KeyK: 'cross',
  KeyU: 'hookL',
  KeyI: 'hookR',
  KeyO: 'uppercut',
  KeyQ: 'dodgeLeft',
  KeyE: 'rage',
  KeyS: 'duck',
  Escape: 'pause',
};

export interface KeyBindingRow {
  keys: string[];
  label: string;
}

/** Shown on the How To Play screen so the docs cannot drift from the code. */
export const KEYBOARD_HELP: KeyBindingRow[] = [
  { keys: ['A', 'D'], label: 'Move' },
  { keys: ['J'], label: 'Left jab' },
  { keys: ['K'], label: 'Right cross' },
  { keys: ['U'], label: 'Left hook' },
  { keys: ['I'], label: 'Right hook' },
  { keys: ['O'], label: 'Uppercut' },
  { keys: ['Space'], label: 'Guard' },
  { keys: ['Shift'], label: 'Dodge' },
  { keys: ['S'], label: 'Duck' },
  { keys: ['E'], label: 'Rage' },
  { keys: ['Esc'], label: 'Pause' },
];

export class KeyboardInput {
  private readonly held = new Set<string>();
  private readonly queue: KeyAction[] = [];
  private attached = false;
  private onPause: (() => void) | null = null;

  setPauseHandler(fn: (() => void) | null): void {
    this.onPause = fn;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.handleDown);
    window.addEventListener('keyup', this.handleUp);
    window.addEventListener('blur', this.handleBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.handleDown);
    window.removeEventListener('keyup', this.handleUp);
    window.removeEventListener('blur', this.handleBlur);
    this.held.clear();
    this.queue.length = 0;
  }

  private handleDown = (e: KeyboardEvent): void => {
    // Never steal keys from a focused input or a modal's controls.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    if (e.code === 'Escape') {
      this.onPause?.();
      return;
    }

    if (this.held.has(e.code)) return;
    this.held.add(e.code);

    // Shift picks its dodge direction from whichever way you are leaning.
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.queue.push(this.held.has('KeyD') ? 'dodgeRight' : 'dodgeLeft');
      e.preventDefault();
      return;
    }

    const action = ACTION_KEYS[e.code];
    if (action && action !== 'pause') {
      this.queue.push(action);
      e.preventDefault();
    }
    if (e.code === 'Space') e.preventDefault();
  };

  private handleUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** A lost window must not leave a key stuck down. */
  private handleBlur = (): void => {
    this.held.clear();
  };

  /** Returns and clears the actions pressed since the last call. */
  drain(): KeyAction[] {
    if (this.queue.length === 0) return EMPTY;
    const out = this.queue.slice();
    this.queue.length = 0;
    return out;
  }

  get guardHeld(): boolean {
    return this.held.has('Space');
  }

  get duckHeld(): boolean {
    return this.held.has('KeyS');
  }

  moveAxis(): number {
    let axis = 0;
    if (this.held.has('KeyA') || this.held.has('ArrowLeft')) axis -= 1;
    if (this.held.has('KeyD') || this.held.has('ArrowRight')) axis += 1;
    return axis;
  }

  get anyKeyHeld(): boolean {
    return this.held.size > 0;
  }
}

const EMPTY: KeyAction[] = [];
