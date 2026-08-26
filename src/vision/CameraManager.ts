/**
 * Owns the webcam stream and every way it can fail.
 *
 * PRIVACY: the stream is attached to a local <video> element and read by
 * MediaPipe inside this tab. No frame is ever uploaded, recorded or persisted,
 * and there is no server to upload it to.
 */

export type CameraErrorKind =
  | 'DENIED'
  | 'NOT_FOUND'
  | 'IN_USE'
  | 'INSECURE_CONTEXT'
  | 'UNSUPPORTED'
  | 'MODEL_FAILED'
  | 'UNKNOWN';

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface BrowserSupport {
  /** Everything needed for webcam control. */
  supported: boolean;
  missing: string[];
  /** Everything needed to render and play with the keyboard. */
  canRender: boolean;
  renderMissing: string[];
}

export function checkBrowserSupport(): BrowserSupport {
  if (typeof window === 'undefined') {
    return { supported: false, missing: ['window'], canRender: false, renderMissing: ['window'] };
  }

  const renderMissing: string[] = [];
  if (typeof WebAssembly !== 'object') renderMissing.push('WebAssembly');
  if (!document.createElement('canvas').getContext('2d')) renderMissing.push('Canvas 2D');

  const cameraMissing: string[] = [];
  if (!window.isSecureContext) cameraMissing.push('a secure context (HTTPS or localhost)');
  if (!navigator.mediaDevices?.getUserMedia) cameraMissing.push('camera access (getUserMedia)');

  const missing = [...renderMissing, ...cameraMissing];
  return {
    supported: missing.length === 0,
    missing,
    canRender: renderMissing.length === 0,
    renderMissing,
  };
}

export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return new CameraError('INSECURE_CONTEXT', 'Camera access requires HTTPS or localhost.');
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return new CameraError('UNSUPPORTED', 'This browser does not expose a camera API.');
  }
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('DENIED', 'Camera permission was denied.');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('NOT_FOUND', 'No camera device was found.');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('IN_USE', 'The camera is already in use by another application.');
    default:
      return new CameraError('UNKNOWN', err instanceof Error ? err.message : 'The camera failed to start.');
  }
}

export type CameraLostHandler = (error: CameraError) => void;

export class CameraManager {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private trackCleanup: (() => void) | null = null;
  private readonly lostHandlers = new Set<CameraLostHandler>();

  get active(): boolean {
    return !!this.stream?.active;
  }

  get resolution(): string {
    if (!this.video || !this.video.videoWidth) return '-';
    return `${this.video.videoWidth}x${this.video.videoHeight}`;
  }

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  onLost(fn: CameraLostHandler): () => void {
    this.lostHandlers.add(fn);
    return () => this.lostHandlers.delete(fn);
  }

  /** Requests the stream and binds it to the given element. Safe to call twice. */
  async start(video: HTMLVideoElement): Promise<void> {
    const support = checkBrowserSupport();
    if (!support.supported) {
      throw new CameraError(
        window.isSecureContext ? 'UNSUPPORTED' : 'INSECURE_CONTEXT',
        `Missing: ${support.missing.join(', ')}`,
      );
    }

    if (!this.stream || !this.stream.active) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 60 },
            facingMode: 'user',
          },
          audio: false,
        });
      } catch (err) {
        throw toCameraError(err);
      }
    }

    this.video = video;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new CameraError('UNKNOWN', 'The camera timed out while starting.')),
        12_000,
      );
      const done = (): void => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', done);
        resolve();
      };
      if (video.readyState >= 2) done();
      else video.addEventListener('loadedmetadata', done);
    });

    try {
      await video.play();
    } catch (err) {
      // Autoplay can be refused even when muted; the frame loop still works
      // as long as the track is live, so only treat a dead track as fatal.
      if (!this.stream.getVideoTracks().some((t) => t.readyState === 'live')) {
        throw toCameraError(err);
      }
    }

    this.attachTrackListeners();
  }

  /**
   * A revoked or unplugged camera simply stops presenting frames, so the vision
   * loop would go quiet with no error. Listen for it explicitly.
   */
  private attachTrackListeners(): void {
    this.detachTrackListeners();
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const onLost = (): void => {
      const error = new CameraError('NOT_FOUND', 'The camera stream ended.');
      for (const handler of this.lostHandlers) handler(error);
    };
    track.addEventListener('ended', onLost);
    track.addEventListener('mute', onLost);
    this.trackCleanup = () => {
      track.removeEventListener('ended', onLost);
      track.removeEventListener('mute', onLost);
    };
  }

  private detachTrackListeners(): void {
    this.trackCleanup?.();
    this.trackCleanup = null;
  }

  stop(): void {
    this.detachTrackListeners();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  dispose(): void {
    this.stop();
    this.lostHandlers.clear();
    this.video = null;
  }
}
