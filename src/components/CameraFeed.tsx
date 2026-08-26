import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { VisionController } from '@/vision/VisionController';

/**
 * The one and only way the camera is shown to the player.
 *
 * It deliberately does NOT render a <video>. The MediaStream is bound to a
 * single long-lived <video> owned by the app root, and every preview blits
 * pixels out of that element into its own canvas. Rendering a second <video>
 * and pointing the same ref at it — which is what this replaced — silently
 * moved the ref off the element that actually held the stream, so the visible
 * preview stayed black while tracking kept running against the hidden one.
 *
 * Drawing to a canvas also buys the thing that matters here: the tracking
 * overlay composites into the same surface as the image, in the same
 * coordinate space, so the skeleton cannot drift out of alignment with the
 * body underneath it.
 */

export type FeedMode = 'camera' | 'sketch';

export interface CameraFeedProps {
  controller: VisionController;
  mirrored: boolean;
  /**
   * `camera` paints the webcam image with the tracking drawn over it.
   * `sketch` drops the image entirely and renders the skeleton alone on a dark
   * field — easier to read at a glance, and it keeps the player's actual room
   * off the screen.
   */
  mode?: FeedMode;
  /** `cover` fills and crops; `contain` shows the whole sensor frame. */
  fit?: 'cover' | 'contain';
  /** Skeleton, trails and punch bursts. */
  overlay?: boolean;
  /** L / R badges on the hands. */
  labels?: boolean;
  /** Dims the image so foreground UI stays legible over it. */
  dim?: number;
  style?: CSSProperties;
  className?: string;
}

/** Shown instead of the image until the first camera frame decodes. */
function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  ctx.fillStyle = '#0b0d16';
  ctx.fillRect(0, 0, w, h);

  // A slow sweep, so a stalled camera still looks alive rather than crashed.
  const sweep = ((t / 2200) % 1) * (w + 160) - 80;
  const grad = ctx.createLinearGradient(sweep - 80, 0, sweep + 80, 0);
  grad.addColorStop(0, 'rgba(49,230,200,0)');
  grad.addColorStop(0.5, 'rgba(49,230,200,0.07)');
  grad.addColorStop(1, 'rgba(49,230,200,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(138,144,173,0.75)';
  ctx.font = `600 ${Math.max(9, Math.round(w / 26))}px 'IBM Plex Mono', ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('NO SIGNAL', w / 2, h / 2);
}

/** The dark field the sketch skeleton is drawn onto. */
function drawSketchField(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#05060c';
  ctx.fillRect(0, 0, w, h);

  // A faint grid gives the floating hand somewhere to sit, so the panel does
  // not read as an empty black hole when nothing is tracked.
  ctx.strokeStyle = 'rgba(120, 132, 180, 0.055)';
  ctx.lineWidth = 1;
  const step = Math.max(18, Math.round(w / 12));
  ctx.beginPath();
  for (let x = step; x < w; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
  }
  for (let y = step; y < h; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

export function CameraFeed({
  controller,
  mirrored,
  mode = 'camera',
  fit = 'cover',
  overlay = true,
  labels = true,
  dim = 0,
  style,
  className,
}: CameraFeedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Props are read through a ref so the draw loop is started exactly once and
  // never restarts mid-stream when a parent re-renders.
  const opts = useRef({ mirrored, mode, fit, overlay, labels, dim });
  opts.current = { mirrored, mode, fit, overlay, labels, dim };

  useEffect(() => {
    let raf = 0;

    const draw = (t: number): void => {
      raf = requestAnimationFrame(draw);

      const canvas = canvasRef.current;
      if (!canvas) return;

      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const o = opts.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const video = controller.videoElement;
      const ready = !!video && video.readyState >= 2 && video.videoWidth > 0;
      const sketch = o.mode === 'sketch';

      // Sketch mode still needs the sensor's aspect to place landmarks, but it
      // can fall back to 4:3 before the first frame decodes rather than sitting
      // on a NO SIGNAL card — the skeleton is what matters, not the image.
      if (!ready && !sketch) {
        drawPlaceholder(ctx, cssW, cssH, t);
        return;
      }

      const vw = ready ? video.videoWidth : 4;
      const vh = ready ? video.videoHeight : 3;
      const scale = o.fit === 'contain' ? Math.min(cssW / vw, cssH / vh) : Math.max(cssW / vw, cssH / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (cssW - dw) / 2;
      const dy = (cssH - dh) / 2;

      if (sketch) {
        drawSketchField(ctx, cssW, cssH);
      } else {
        if (o.fit === 'contain') {
          ctx.fillStyle = '#0b0d16';
          ctx.fillRect(0, 0, cssW, cssH);
        }

        ctx.save();
        if (o.mirrored) {
          // Flip about the canvas centre so the destination rect stays correct.
          ctx.translate(cssW, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video as HTMLVideoElement, cssW - dx - dw, dy, dw, dh);
        } else {
          ctx.drawImage(video as HTMLVideoElement, dx, dy, dw, dh);
        }
        ctx.restore();

        if (o.dim > 0) {
          ctx.fillStyle = `rgba(6,7,13,${Math.min(1, o.dim)})`;
          ctx.fillRect(0, 0, cssW, cssH);
        }
      }

      if (o.overlay || sketch) {
        controller.drawTracking(
          ctx,
          { x: dx, y: dy, w: dw, h: dh, mirrored: o.mirrored, showLabels: o.labels, glow: sketch },
          t,
        );
      }

      if (sketch && !controller.cameraActive) {
        ctx.fillStyle = 'rgba(138,144,173,0.7)';
        ctx.font = `600 ${Math.max(9, Math.round(cssW / 26))}px 'IBM Plex Mono', ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NO SIGNAL', cssW / 2, cssH / 2);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [controller]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label="Camera preview with motion tracking overlay"
      style={{ display: 'block', width: '100%', height: '100%', ...style }}
    />
  );
}

export default CameraFeed;
