import type { RenderState } from '@/types/fighter';
import { PALETTE } from '@/config/gameConfig';
import { clamp01 } from '@/utils/math';

/**
 * The "which one am I?" layer.
 *
 * Two fighters in matching silhouettes on a busy arena background is not
 * self-explanatory, and a name in the corner of the HUD does not answer the
 * question while the player is looking at the middle of the screen. So the
 * answer is drawn onto the fighters themselves: a coloured stance ring on the
 * mat and a floating tag over the head, both keyed to the same colours the HUD
 * uses for each side.
 *
 * Both are quiet during normal play and loud for a couple of seconds at the
 * start of a round, which is exactly when the player is looking for them.
 */

const TAU = Math.PI * 2;
const FONT = "'Rajdhani', 'IBM Plex Sans', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

export interface TagTarget {
  render: RenderState;
  label: string;
  /** Drives colour and the caret style. */
  side: 'player' | 'enemy';
}

/** Converts #rrggbb to "r, g, b" once, cached — this runs every frame. */
const rgbCache = new Map<string, string>();
function rgb(hex: string): string {
  let v = rgbCache.get(hex);
  if (v) return v;
  v = `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
  rgbCache.set(hex, v);
  return v;
}

/**
 * A flattened ring on the mat under a fighter. Reads as "this one is yours"
 * without competing with the fighter art for attention.
 */
function drawStanceRing(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  colour: string,
  emphasis: number,
  timeMs: number,
): void {
  if (rs.alpha <= 0.02) return;

  const w = rs.height * 0.34;
  const h = w * 0.3;
  const x = rs.worldX;
  const y = rs.worldY;
  const c = rgb(colour);

  // A slow pulse keeps it alive without drawing the eye during exchanges.
  const pulse = 0.5 + 0.5 * Math.sin(timeMs / 620);
  const base = (0.2 + 0.16 * pulse + 0.5 * emphasis) * rs.alpha;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, h / w);

  const grad = ctx.createRadialGradient(0, 0, w * 0.25, 0, 0, w);
  grad.addColorStop(0, `rgba(${c}, ${base * 0.34})`);
  grad.addColorStop(0.72, `rgba(${c}, ${base * 0.13})`);
  grad.addColorStop(1, `rgba(${c}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, w, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = `rgba(${c}, ${base})`;
  ctx.lineWidth = (2 + 2.4 * emphasis) / (h / w);
  ctx.beginPath();
  ctx.arc(0, 0, w * 0.82, 0, TAU);
  ctx.stroke();

  ctx.restore();
}

/** Floating pill above the head, with a caret pointing at its fighter. */
function drawTag(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  target: TagTarget,
  colour: string,
  emphasis: number,
  timeMs: number,
): void {
  if (rs.alpha <= 0.02) return;

  const c = rgb(colour);
  const isPlayer = target.side === 'player';
  const scale = 1 + 0.34 * emphasis;

  // Bob only while emphasised — a permanently bobbing tag is noise.
  const bob = Math.sin(timeMs / 420) * 3 * emphasis;
  const headY = rs.worldY - rs.height;
  const y = headY - 44 - 10 * emphasis + bob;

  const text = target.label.toUpperCase();
  const fontSize = Math.round((isPlayer ? 19 : 16) * scale);

  ctx.save();
  ctx.globalAlpha = rs.alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${fontSize}px ${isPlayer ? FONT : MONO}`;

  const padX = 13 * scale;
  const w = ctx.measureText(text).width + padX * 2;
  const h = (isPlayer ? 27 : 24) * scale;
  const x = rs.worldX;
  const r = h / 2;

  // Body
  ctx.fillStyle = `rgba(6, 7, 13, ${0.72 + 0.2 * emphasis})`;
  ctx.strokeStyle = `rgba(${c}, ${0.55 + 0.45 * emphasis})`;
  ctx.lineWidth = 1.5 + 1.2 * emphasis;
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + r, y - h / 2);
  ctx.lineTo(x + w / 2 - r, y - h / 2);
  ctx.arc(x + w / 2 - r, y, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x - w / 2 + r, y + h / 2);
  ctx.arc(x - w / 2 + r, y, r, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  if (emphasis > 0.01) {
    ctx.shadowColor = `rgba(${c}, ${0.6 * emphasis})`;
    ctx.shadowBlur = 18 * emphasis;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Caret, tying the tag to the body under it.
  const caretW = 7 * scale;
  const caretH = 7 * scale;
  const caretTop = y + h / 2;
  ctx.fillStyle = `rgba(${c}, ${0.7 + 0.3 * emphasis})`;
  ctx.beginPath();
  ctx.moveTo(x - caretW, caretTop);
  ctx.lineTo(x + caretW, caretTop);
  ctx.lineTo(x, caretTop + caretH);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = isPlayer ? colour : `rgba(${c}, 0.92)`;
  ctx.font = `700 ${fontSize}px ${isPlayer ? FONT : MONO}`;
  ctx.letterSpacing = '0.1em';
  ctx.fillText(text, x, y + 1);
  ctx.letterSpacing = '0px';

  // Only while the round is opening, and only for the player: the one line
  // that removes all doubt about which body responds to their hands.
  if (isPlayer && emphasis > 0.05) {
    ctx.globalAlpha = rs.alpha * emphasis;
    ctx.fillStyle = `rgba(${c}, 0.85)`;
    ctx.font = `600 ${Math.round(11 * scale)}px ${MONO}`;
    ctx.letterSpacing = '0.24em';
    ctx.fillText('YOUR FIGHTER', x, y - h / 2 - 13 * scale);
    ctx.letterSpacing = '0px';
  }

  ctx.restore();
}

/**
 * Ground rings draw *under* the fighters, so this is a separate call from the
 * overhead tags rather than one combined pass.
 *
 * @param emphasis 0 = the quiet always-on state, 1 = round-start callout.
 */
export function drawStanceRings(
  ctx: CanvasRenderingContext2D,
  targets: readonly TagTarget[],
  emphasis: number,
  timeMs: number,
): void {
  const e = clamp01(emphasis);
  ctx.save();
  for (const target of targets) {
    const colour = target.side === 'player' ? PALETTE.player : PALETTE.enemy;
    drawStanceRing(ctx, target.render, colour, e, timeMs);
  }
  ctx.restore();
}

/** Overhead tags only, for drawing after the fighters. */
export function drawOverheadTags(
  ctx: CanvasRenderingContext2D,
  targets: readonly TagTarget[],
  emphasis: number,
  timeMs: number,
): void {
  const e = clamp01(emphasis);
  ctx.save();
  for (const target of targets) {
    if (target.render.downed) continue;
    const colour = target.side === 'player' ? PALETTE.player : PALETTE.enemy;
    drawTag(ctx, target.render, target, colour, e, timeMs);
  }
  ctx.restore();
}
