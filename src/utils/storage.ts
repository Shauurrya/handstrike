/**
 * localStorage wrapper that degrades to an in-memory map.
 * The game is fully playable with storage blocked (private mode, disabled
 * cookies) — progression simply does not persist between sessions.
 */

const PREFIX = 'handstrike:';

const memory = new Map<string, string>();

let available: boolean | null = null;

function storageAvailable(): boolean {
  if (available !== null) return available;
  try {
    const probe = `${PREFIX}__probe__`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export const isPersistent = (): boolean => storageAvailable();

export function readJSON<T>(key: string, fallback: T): T {
  const full = PREFIX + key;
  try {
    const raw = storageAvailable() ? window.localStorage.getItem(full) : (memory.get(full) ?? null);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function writeJSON<T>(key: string, value: T): void {
  const full = PREFIX + key;
  try {
    const raw = JSON.stringify(value);
    if (storageAvailable()) window.localStorage.setItem(full, raw);
    else memory.set(full, raw);
  } catch {
    /* quota or serialisation failure — progression just will not persist */
  }
}

export function removeKey(key: string): void {
  const full = PREFIX + key;
  try {
    if (storageAvailable()) window.localStorage.removeItem(full);
    else memory.delete(full);
  } catch {
    /* ignore */
  }
}

export const STORAGE_KEYS = {
  settings: 'settings',
  career: 'career',
  calibration: 'calibration',
  training: 'training',
  records: 'records',
} as const;
