/**
 * Vendors the MediaPipe WASM runtime + task models into public/ so the game runs
 * without ever touching a CDN. Never fails the build: the vision layer falls back
 * to the public CDN when an asset is missing.
 */
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDest = resolve(root, 'public/mediapipe/wasm');

const MODELS = [
  {
    dest: resolve(root, 'public/models/hand_landmarker.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    label: 'hand landmarker',
  },
  {
    dest: resolve(root, 'public/models/pose_landmarker_lite.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    label: 'pose landmarker (lite)',
  },
];

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function copyWasm() {
  if (!(await exists(wasmSrc))) {
    console.log('[assets] tasks-vision wasm not found in node_modules, skipping');
    return;
  }
  await mkdir(wasmDest, { recursive: true });
  await cp(wasmSrc, wasmDest, { recursive: true });
  console.log('[assets] wasm runtime -> public/mediapipe/wasm');
}

async function fetchModel({ dest, url, label }) {
  if (await exists(dest)) {
    console.log(`[assets] ${label} already present`);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`[assets] ${label} -> ${dest.replace(root, '.')}`);
  } catch (err) {
    console.log(`[assets] ${label} download skipped (${err.message}) - CDN fallback will be used`);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await copyWasm();
  for (const model of MODELS) await fetchModel(model);
} catch (err) {
  console.log(`[assets] preparation skipped: ${err.message}`);
}
