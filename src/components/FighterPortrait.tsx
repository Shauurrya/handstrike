import { useEffect, useRef } from 'react';
import { getStyle } from '@/data/fighters';
import { getSkin } from '@/render/skins';

export interface FighterPortraitProps {
  styleId: string;
  size: number;
  /** Pause the idle bob for dense lists. */
  still?: boolean;
}

/**
 * Renders a fighter bust with the same skin that paints them in the ring, so a
 * card on the select screen always matches the fighter you actually face.
 */
export function FighterPortrait({ styleId, size, still = false }: FighterPortraitProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const style = getStyle(styleId);
    const skin = getSkin(style.id);
    let raf = 0;
    let mounted = true;

    const paint = (t: number): void => {
      if (!mounted) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      skin.drawPortrait(ctx, style, { x: 0, y: 0, w: size, h: size }, still ? 0 : t);
      if (!still) raf = requestAnimationFrame(paint);
    };

    paint(still ? 0 : performance.now());

    return () => {
      mounted = false;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [styleId, size, still]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: 'var(--r-md)', display: 'block' }}
      aria-hidden="true"
    />
  );
}

export default FighterPortrait;
