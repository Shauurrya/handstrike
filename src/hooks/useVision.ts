import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VisionFrame } from '@/types/vision';
import { CameraError, type CameraErrorKind } from '@/vision/CameraManager';
import { VisionController } from '@/vision/VisionController';
import { loadCalibration } from '@/store/appState';

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'error';

export interface VisionHandle {
  controller: VisionController;
  /**
   * Attaches to the app's single long-lived <video>. Nothing else may claim
   * this ref: it is the element the MediaStream is bound to, and previews read
   * pixels out of it via `controller.videoElement` rather than rendering their
   * own <video>.
   */
  videoRef: React.RefObject<HTMLVideoElement>;
  status: CameraStatus;
  error: { kind: CameraErrorKind; message: string } | null;
  /** Throttled snapshot for React consumers; the engine reads the raw frame. */
  frame: VisionFrame;
  enable(): Promise<void>;
  disable(): void;
  clearError(): void;
}

/**
 * Bridges the imperative vision loop into React without re-rendering the tree
 * 30 times a second. Components get a snapshot at ~10Hz, which is plenty for
 * status dots and readouts; the game engine reads `controller.latest` directly
 * every frame so gameplay never pays for React.
 */
export function useVision(): VisionHandle {
  const controller = useMemo(() => new VisionController(), []);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<{ kind: CameraErrorKind; message: string } | null>(null);
  const [frame, setFrame] = useState<VisionFrame>(() => controller.latest);

  // Restore the saved calibration profile before the first frame is processed.
  useEffect(() => {
    controller.setCalibration(loadCalibration());
  }, [controller]);

  useEffect(() => {
    const unsubscribeError = controller.onError((e) => {
      setStatus('error');
      setError({ kind: e.kind, message: e.message });
    });
    return () => {
      unsubscribeError();
    };
  }, [controller]);

  // Poll the controller instead of subscribing per-frame: a setState on every
  // vision frame would thrash the whole React tree for no visible benefit.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const pump = (t: number): void => {
      if (t - last >= 100) {
        last = t;
        setFrame(controller.latest);
      }
      raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(raf);
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  const enable = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (controller.cameraActive) {
      setStatus('ready');
      return;
    }
    setStatus('requesting');
    setError(null);
    try {
      await controller.start(video);
      setStatus('ready');
    } catch (e) {
      const err = e instanceof CameraError ? e : new CameraError('UNKNOWN', 'The camera could not be started.');
      setStatus('error');
      setError({ kind: err.kind, message: err.message });
    }
  }, [controller]);

  const disable = useCallback(() => {
    controller.stop();
    setStatus('idle');
  }, [controller]);

  const clearError = useCallback(() => {
    setError(null);
    setStatus(controller.cameraActive ? 'ready' : 'idle');
  }, [controller]);

  return { controller, videoRef, status, error, frame, enable, disable, clearError };
}
