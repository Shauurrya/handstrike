import { FilesetResolver } from '@mediapipe/tasks-vision';
import { CameraError } from './CameraManager';

/** The package does not export this type, so derive it from the resolver. */
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/**
 * Resolves the MediaPipe runtime. The WASM and the .task models are vendored
 * into public/ by scripts/prepare-assets.mjs so a deployed build never depends
 * on a third-party CDN; the CDN is only a safety net if vendoring failed.
 */

const LOCAL_WASM = '/mediapipe/wasm';
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

export const LOCAL_HAND_MODEL = '/models/hand_landmarker.task';
export const LOCAL_POSE_MODEL = '/models/pose_landmarker_lite.task';
export const CDN_HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
export const CDN_POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export type AssetSource = 'local' | 'cdn' | 'unknown';

let filesetPromise: Promise<{ fileset: WasmFileset; source: AssetSource }> | null = null;

/** A dev server happily returns index.html for a missing file, so check the type too. */
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'force-cache' });
    if (!res.ok) return false;
    return !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

export async function resolveFileset(): Promise<{ fileset: WasmFileset; source: AssetSource }> {
  if (filesetPromise) return filesetPromise;

  filesetPromise = (async () => {
    const useLocal = await probe(`${LOCAL_WASM}/vision_wasm_internal.js`);
    const path = useLocal ? LOCAL_WASM : CDN_WASM;
    try {
      return { fileset: await FilesetResolver.forVisionTasks(path), source: useLocal ? 'local' : 'cdn' };
    } catch (err) {
      if (useLocal) {
        // Vendored copy is broken — fall back rather than failing outright.
        try {
          return { fileset: await FilesetResolver.forVisionTasks(CDN_WASM), source: 'cdn' as const };
        } catch {
          /* fall through to the thrown error below */
        }
      }
      throw new CameraError(
        'MODEL_FAILED',
        `Could not load the vision runtime (${err instanceof Error ? err.message : 'unknown error'}).`,
      );
    }
  })();

  try {
    return await filesetPromise;
  } catch (err) {
    filesetPromise = null;
    throw err;
  }
}

/** Picks the vendored model when it is actually being served, else the CDN copy. */
export async function resolveModelPath(local: string, cdn: string): Promise<{ path: string; source: AssetSource }> {
  const ok = await probe(local);
  return ok ? { path: local, source: 'local' } : { path: cdn, source: 'cdn' };
}
