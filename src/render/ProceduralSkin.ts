import type { FighterSkin, FighterStyle, JointName, RenderState } from '@/types/fighter';
import { clamp, clamp01 } from '@/utils/math';

/**
 * Paints a posed skeleton as an actual boxer.
 *
 * Everything is drawn in screen space: joints are converted up front rather
 * than flipping the canvas Y axis, because a negative-Y transform breaks
 * gradients, text and arc winding.
 *
 * The look comes from four cheap tricks stacked together — tapered limbs
 * instead of lines, a dark outline on every part, a light-to-shadow gradient
 * across the body, and a rim light on the silhouette edge.
 */

interface Pt {
  x: number;
  y: number;
}

/** Screen-space joint cache, reused every frame. */
const P: Record<JointName, Pt> = {
  pelvis: { x: 0, y: 0 },
  chest: { x: 0, y: 0 },
  neck: { x: 0, y: 0 },
  head: { x: 0, y: 0 },
  shoulderL: { x: 0, y: 0 },
  elbowL: { x: 0, y: 0 },
  handL: { x: 0, y: 0 },
  shoulderR: { x: 0, y: 0 },
  elbowR: { x: 0, y: 0 },
  handR: { x: 0, y: 0 },
  hipL: { x: 0, y: 0 },
  kneeL: { x: 0, y: 0 },
  footL: { x: 0, y: 0 },
  hipR: { x: 0, y: 0 },
  kneeR: { x: 0, y: 0 },
  footR: { x: 0, y: 0 },
};

const JOINTS: JointName[] = [
  'pelvis', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'handL',
  'shoulderR', 'elbowR', 'handR',
  'hipL', 'kneeL', 'footL',
  'hipR', 'kneeR', 'footR',
];

// ---------------------------------------------------------------- colour

const hexCache = new Map<string, [number, number, number]>();

function parseHex(hex: string): [number, number, number] {
  const cached = hexCache.get(hex);
  if (cached) return cached;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h, 16);
  const rgb: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  hexCache.set(hex, rgb);
  return rgb;
}

const shadeCache = new Map<string, string>();

/** Darkens (amount < 1) or lightens (amount > 1) a hex colour. */
function shade(hex: string, amount: number): string {
  const key = `${hex}|${amount}`;
  const hit = shadeCache.get(key);
  if (hit) return hit;
  const [r, g, b] = parseHex(hex);
  const f = (c: number): number =>
    Math.round(amount <= 1 ? c * amount : c + (255 - c) * (amount - 1));
  const out = `rgb(${clamp(f(r), 0, 255)},${clamp(f(g), 0, 255)},${clamp(f(b), 0, 255)})`;
  shadeCache.set(key, out);
  return out;
}

const alphaCache = new Map<string, string>();

function withAlpha(hex: string, a: number): string {
  const key = `${hex}|a${a.toFixed(2)}`;
  const hit = alphaCache.get(key);
  if (hit) return hit;
  const [r, g, b] = parseHex(hex);
  const out = `rgba(${r},${g},${b},${a})`;
  alphaCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- geometry

/**
 * A limb as a tapered capsule. Two circles of different radii joined by their
 * outer tangents — this is the single biggest reason the fighters do not read
 * as stick figures.
 */
function limbPath(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, ra: number, rb: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(ra, rb), 0, Math.PI * 2);
    return;
  }
  const nx = -dy / len;
  const ny = dx / len;
  // Tangent tilt keeps the taper smooth when the two radii differ a lot.
  const dr = ra - rb;
  const s = clamp(dr / len, -1, 1);
  const c = Math.sqrt(Math.max(0, 1 - s * s));

  const t1x = nx * c + (dx / len) * s;
  const t1y = ny * c + (dy / len) * s;

  ctx.beginPath();
  ctx.arc(a.x, a.y, ra, Math.atan2(t1y, t1x), Math.atan2(-t1y, -t1x), false);
  ctx.arc(b.x, b.y, rb, Math.atan2(-t1y, -t1x), Math.atan2(t1y, t1x), false);
  ctx.closePath();
}

function midPoint(a: Pt, b: Pt, out: Pt): Pt {
  out.x = (a.x + b.x) * 0.5;
  out.y = (a.y + b.y) * 0.5;
  return out;
}

const SCRATCH1: Pt = { x: 0, y: 0 };
const SCRATCH2: Pt = { x: 0, y: 0 };
const SCRATCH3: Pt = { x: 0, y: 0 };

// ---------------------------------------------------------------- the skin

export class ProceduralSkin implements FighterSkin {
  readonly id: string;

  constructor(id = 'procedural') {
    this.id = id;
  }

  draw(ctx: CanvasRenderingContext2D, rs: RenderState, style: FighterStyle, timeMs: number): void {
    const unit = (rs.height / 100) * (rs.scale || 1);
    if (unit <= 0) return;

    this.project(rs, unit);

    const f = style.features ?? {};
    const bulk = f.bulk ?? 1;
    const outline = Math.max(1.4, unit * 2.2);
    const lit = shade(style.skin, 1.16);
    const dark = style.skinShadow;
    const line = shade(style.skinShadow, 0.42);
    const facing = rs.facing;

    ctx.save();
    ctx.globalAlpha = clamp01(rs.alpha);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (rs.rage > 0.02) {
      ctx.shadowColor = withAlpha('#ff6a00', 0.55 * rs.rage);
      ctx.shadowBlur = unit * 10 * rs.rage;
    }

    this.drawShadow(ctx, rs, unit);
    this.drawRearLeg(ctx, style, unit, bulk, outline, line);
    this.drawRearArm(ctx, unit, bulk, outline, line, dark);
    this.drawTorso(ctx, style, unit, bulk, outline, line, lit, dark, facing);
    this.drawHead(ctx, style, unit, bulk, outline, line, lit, facing);
    this.drawLeadLeg(ctx, style, unit, bulk, outline, line);
    this.drawLeadArm(ctx, style, unit, bulk, outline, line, lit);
    this.drawGloves(ctx, rs, style, unit, bulk, outline);

    ctx.shadowBlur = 0;
    this.drawRimLight(ctx, rs, unit, facing);

    if (rs.rage > 0.35) this.drawEmbers(ctx, rs, unit, timeMs);
    if (rs.flash > 0.01) this.drawFlash(ctx, rs, unit, bulk);

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1;
    ctx.restore();
  }

  // ------------------------------------------------------------ projection

  private project(rs: RenderState, unit: number): void {
    const rot = rs.rot;
    const rootX = rs.root.x;
    const rootY = rs.root.y;
    const pelvis = rs.pose.pelvis;
    const px = pelvis.x + rootX;
    const py = pelvis.y + rootY;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const useRot = Math.abs(rot) > 1e-4;

    for (const name of JOINTS) {
      const j = rs.pose[name];
      let lx = j.x + rootX;
      let ly = j.y + rootY;
      if (useRot) {
        const dx = lx - px;
        const dy = ly - py;
        lx = px + dx * cos - dy * sin;
        ly = py + dx * sin + dy * cos;
      }
      const out = P[name];
      out.x = rs.worldX + rs.facing * lx * unit;
      out.y = rs.worldY - ly * unit;
    }
  }

  // ------------------------------------------------------------ parts

  private drawShadow(ctx: CanvasRenderingContext2D, rs: RenderState, unit: number): void {
    // Anchored to the pelvis so a knocked-down body's shadow follows the torso
    // rather than staying under where the feet used to be.
    const anchorX = Math.abs(rs.rot) > 0.5 ? (P.pelvis.x + P.chest.x) * 0.5 : rs.worldX;
    const lift = clamp01((rs.worldY - P.pelvis.y) / (unit * 55));
    const w = unit * 26 * (1.25 - lift * 0.35);
    const h = unit * 5.2 * (1.1 - lift * 0.3);
    ctx.save();
    ctx.globalAlpha *= 0.42 * (1 - lift * 0.35);
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(anchorX, rs.worldY + unit * 0.6, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private strokeFill(
    ctx: CanvasRenderingContext2D,
    fill: string | CanvasGradient,
    outline: number,
    line: string,
  ): void {
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = outline;
    ctx.strokeStyle = line;
    ctx.stroke();
  }

  private drawRearLeg(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
  ): void {
    const thigh = unit * 5.4 * bulk;
    const calf = unit * 3.8 * bulk;
    const dark = shade(style.skinShadow, 0.82);

    limbPath(ctx, P.hipR, P.kneeR, thigh, calf * 1.05);
    this.strokeFill(ctx, dark, outline, line);
    limbPath(ctx, P.kneeR, P.footR, calf, unit * 2.9 * bulk);
    this.strokeFill(ctx, dark, outline, line);
    this.drawBoot(ctx, P.footR, style, unit, bulk, outline, line, 0.82);
  }

  private drawLeadLeg(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
  ): void {
    const thigh = unit * 5.8 * bulk;
    const calf = unit * 4 * bulk;

    limbPath(ctx, P.hipL, P.kneeL, thigh, calf * 1.05);
    this.strokeFill(ctx, style.skin, outline, line);
    limbPath(ctx, P.kneeL, P.footL, calf, unit * 3 * bulk);
    this.strokeFill(ctx, style.skin, outline, line);
    this.drawBoot(ctx, P.footL, style, unit, bulk, outline, line, 1);
  }

  private drawBoot(
    ctx: CanvasRenderingContext2D,
    foot: Pt,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
    tone: number,
  ): void {
    const w = unit * 7.2 * bulk;
    const h = unit * 5;
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y - h * 0.15, w * 0.72, h * 0.62, 0, 0, Math.PI * 2);
    this.strokeFill(ctx, shade(style.boots, tone), outline * 0.85, line);
    // Lace flash so the boot is not a featureless blob.
    ctx.beginPath();
    ctx.moveTo(foot.x - w * 0.3, foot.y - h * 0.5);
    ctx.lineTo(foot.x + w * 0.3, foot.y - h * 0.5);
    ctx.lineWidth = Math.max(1, unit * 0.9);
    ctx.strokeStyle = withAlpha(style.accent, 0.75 * tone);
    ctx.stroke();
  }

  private drawRearArm(
    ctx: CanvasRenderingContext2D,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
    dark: string,
  ): void {
    const upper = unit * 4.6 * bulk;
    const fore = unit * 3.4 * bulk;
    limbPath(ctx, P.shoulderR, P.elbowR, upper, fore * 1.06);
    this.strokeFill(ctx, shade(dark, 0.92), outline, line);
    limbPath(ctx, P.elbowR, P.handR, fore, unit * 2.9 * bulk);
    this.strokeFill(ctx, shade(dark, 0.92), outline, line);
  }

  private drawLeadArm(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
    lit: string,
  ): void {
    const upper = unit * 4.8 * bulk;
    const fore = unit * 3.6 * bulk;
    limbPath(ctx, P.shoulderL, P.elbowL, upper, fore * 1.06);
    this.strokeFill(ctx, style.skin, outline, line);

    const f = style.features ?? {};
    if (f.tattoo === 'sleeve') {
      ctx.save();
      limbPath(ctx, P.shoulderL, P.elbowL, upper * 0.98, fore * 1.02);
      ctx.clip();
      ctx.strokeStyle = withAlpha(style.skinShadow, 0.85);
      ctx.lineWidth = Math.max(1, unit * 1.1);
      for (let i = 1; i <= 3; i += 1) {
        const t = i / 4;
        const x = P.shoulderL.x + (P.elbowL.x - P.shoulderL.x) * t;
        const y = P.shoulderL.y + (P.elbowL.y - P.shoulderL.y) * t;
        ctx.beginPath();
        ctx.arc(x, y, upper * 0.92, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    limbPath(ctx, P.elbowL, P.handL, fore, unit * 3 * bulk);
    this.strokeFill(ctx, lit, outline, line);
  }

  private drawTorso(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
    lit: string,
    dark: string,
    facing: number,
  ): void {
    const hipMid = midPoint(P.hipL, P.hipR, SCRATCH1);
    const shoulderMid = midPoint(P.shoulderL, P.shoulderR, SCRATCH2);
    const halfShoulder = unit * 10.5 * bulk;
    const halfWaist = unit * 7.6 * bulk;
    const halfHip = unit * 8.4 * bulk;

    const nx = facing;

    ctx.beginPath();
    ctx.moveTo(shoulderMid.x - halfShoulder * nx, shoulderMid.y);
    ctx.quadraticCurveTo(
      P.chest.x - halfShoulder * 1.02 * nx, P.chest.y,
      hipMid.x - halfHip * nx, hipMid.y,
    );
    ctx.lineTo(hipMid.x + halfHip * nx, hipMid.y);
    ctx.quadraticCurveTo(
      P.chest.x + halfWaist * 1.16 * nx, P.chest.y,
      shoulderMid.x + halfShoulder * nx, shoulderMid.y,
    );
    ctx.quadraticCurveTo(
      shoulderMid.x, shoulderMid.y - unit * 4,
      shoulderMid.x - halfShoulder * nx, shoulderMid.y,
    );
    ctx.closePath();

    const grad = ctx.createLinearGradient(
      shoulderMid.x - halfShoulder * nx, shoulderMid.y,
      shoulderMid.x + halfShoulder * nx, hipMid.y,
    );
    grad.addColorStop(0, dark);
    grad.addColorStop(0.55, style.skin);
    grad.addColorStop(1, lit);
    this.strokeFill(ctx, grad, outline, line);

    const f = style.features ?? {};
    if (f.tattoo === 'chest') {
      ctx.save();
      ctx.globalAlpha *= 0.55;
      ctx.strokeStyle = style.skinShadow;
      ctx.lineWidth = Math.max(1, unit * 1.2);
      ctx.beginPath();
      ctx.moveTo(P.chest.x - unit * 3, P.chest.y - unit * 1.5);
      ctx.lineTo(P.chest.x + unit * 3 * nx, P.chest.y + unit * 2);
      ctx.lineTo(P.chest.x - unit * 1 * nx, P.chest.y + unit * 4);
      ctx.stroke();
      ctx.restore();
    }

    // --- trunks -------------------------------------------------------------
    const trunkTop = hipMid.y - unit * 4.5;
    const kneeMidY = (P.kneeL.y + P.kneeR.y) * 0.5;
    const trunkBottom = hipMid.y + (kneeMidY - hipMid.y) * 0.55;
    ctx.beginPath();
    ctx.moveTo(hipMid.x - halfHip * 1.06 * nx, trunkTop);
    ctx.lineTo(hipMid.x + halfHip * 1.06 * nx, trunkTop);
    ctx.quadraticCurveTo(
      hipMid.x + halfHip * 1.16 * nx, (trunkTop + trunkBottom) * 0.5,
      hipMid.x + halfHip * 0.98 * nx, trunkBottom,
    );
    ctx.lineTo(hipMid.x - halfHip * 0.98 * nx, trunkBottom);
    ctx.quadraticCurveTo(
      hipMid.x - halfHip * 1.16 * nx, (trunkTop + trunkBottom) * 0.5,
      hipMid.x - halfHip * 1.06 * nx, trunkTop,
    );
    ctx.closePath();
    const tg = ctx.createLinearGradient(hipMid.x - halfHip * nx, trunkTop, hipMid.x + halfHip * nx, trunkBottom);
    tg.addColorStop(0, shade(style.trunks, 0.72));
    tg.addColorStop(1, shade(style.trunks, 1.12));
    this.strokeFill(ctx, tg, outline, line);

    // Waistband + side stripe: cheap, but it is what makes them read as kit.
    ctx.beginPath();
    ctx.moveTo(hipMid.x - halfHip * 1.06 * nx, trunkTop + unit * 1.4);
    ctx.lineTo(hipMid.x + halfHip * 1.06 * nx, trunkTop + unit * 1.4);
    ctx.lineWidth = Math.max(1.5, unit * 2.4);
    ctx.strokeStyle = style.trunksTrim;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(hipMid.x + halfHip * 0.7 * nx, trunkTop + unit * 2.6);
    ctx.lineTo(hipMid.x + halfHip * 0.6 * nx, trunkBottom - unit * 0.6);
    ctx.lineWidth = Math.max(1, unit * 1.5);
    ctx.strokeStyle = style.accent;
    ctx.stroke();
  }

  private drawHead(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
    lit: string,
    facing: number,
  ): void {
    const h = P.head;
    const r = unit * 7.6 * (0.94 + bulk * 0.06);
    const nx = facing;
    const f = style.features ?? {};

    // Neck first so it tucks behind the jaw.
    limbPath(ctx, P.neck, h, unit * 3.6 * bulk, unit * 3.2 * bulk);
    this.strokeFill(ctx, shade(style.skinShadow, 0.95), outline, line);

    // Egg-shaped skull with a jaw pushed towards the facing side.
    ctx.beginPath();
    ctx.ellipse(h.x, h.y - r * 0.08, r * 0.86, r, 0, 0, Math.PI * 2);
    const hg = ctx.createLinearGradient(h.x - r * nx, h.y - r, h.x + r * nx, h.y + r);
    hg.addColorStop(0, style.skinShadow);
    hg.addColorStop(0.6, style.skin);
    hg.addColorStop(1, lit);
    this.strokeFill(ctx, hg, outline, line);

    ctx.beginPath();
    ctx.moveTo(h.x - r * 0.6 * nx, h.y + r * 0.3);
    ctx.quadraticCurveTo(h.x + r * 0.5 * nx, h.y + r * 1.05, h.x + r * 0.72 * nx, h.y + r * 0.1);
    ctx.quadraticCurveTo(h.x + r * 0.6 * nx, h.y - r * 0.2, h.x - r * 0.6 * nx, h.y + r * 0.3);
    this.strokeFill(ctx, style.skin, outline * 0.7, line);

    // --- face ----------------------------------------------------------------
    if (!f.mask) {
      ctx.strokeStyle = shade(style.skinShadow, 0.4);
      ctx.lineWidth = Math.max(1, unit * 1.1);
      ctx.beginPath();
      ctx.moveTo(h.x + r * 0.12 * nx, h.y - r * 0.3);
      ctx.lineTo(h.x + r * 0.66 * nx, h.y - r * 0.24);
      ctx.stroke();

      ctx.fillStyle = '#12131a';
      ctx.beginPath();
      ctx.ellipse(h.x + r * 0.42 * nx, h.y - r * 0.02, r * 0.13, r * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(h.x - r * 0.05 * nx, h.y - r * 0.04, r * 0.11, r * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = shade(style.skinShadow, 0.45);
      ctx.lineWidth = Math.max(1, unit * 0.9);
      ctx.beginPath();
      ctx.moveTo(h.x + r * 0.2 * nx, h.y + r * 0.48);
      ctx.lineTo(h.x + r * 0.56 * nx, h.y + r * 0.44);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#0d0e15';
      ctx.beginPath();
      ctx.roundRect?.(h.x - r * 0.7, h.y - r * 0.28, r * 1.5, r * 0.42, r * 0.16);
      if (!ctx.roundRect) ctx.rect(h.x - r * 0.7, h.y - r * 0.28, r * 1.5, r * 0.42);
      ctx.fill();
    }

    if (f.beard) {
      ctx.save();
      ctx.globalAlpha *= 0.9;
      ctx.fillStyle = shade(style.hair, 0.92);
      ctx.beginPath();
      ctx.ellipse(h.x + r * 0.24 * nx, h.y + r * 0.6, r * 0.58, r * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this.drawHair(ctx, style, h, r, nx, outline, line);

    if (f.headgear) {
      ctx.beginPath();
      ctx.ellipse(h.x, h.y - r * 0.1, r * 1.1, r * 1.16, 0, 0, Math.PI * 2);
      ctx.lineWidth = outline * 1.9;
      ctx.strokeStyle = style.accent;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(h.x - r * 0.78 * nx, h.y + r * 0.16, r * 0.3, r * 0.46, 0, 0, Math.PI * 2);
      this.strokeFill(ctx, shade(style.accent, 0.8), outline * 0.7, line);
    }
  }

  private drawHair(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    h: Pt,
    r: number,
    nx: number,
    outline: number,
    line: string,
  ): void {
    const kind = style.features?.hairStyle ?? 'short';
    if (kind === 'bald') return;
    ctx.fillStyle = style.hair;
    ctx.strokeStyle = line;
    ctx.lineWidth = outline * 0.7;

    switch (kind) {
      case 'afro':
        ctx.beginPath();
        ctx.arc(h.x - r * 0.1 * nx, h.y - r * 0.62, r * 0.92, Math.PI, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(h.x - r * 0.72 * nx, h.y - r * 0.3, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(h.x + r * 0.56 * nx, h.y - r * 0.34, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'mohawk':
        ctx.beginPath();
        ctx.moveTo(h.x - r * 0.62 * nx, h.y - r * 0.66);
        for (let i = 0; i < 4; i += 1) {
          const t = i / 3;
          const bx = h.x + (t - 0.5) * r * 1.2 * nx;
          ctx.lineTo(bx, h.y - r * (1.22 + Math.sin(t * Math.PI) * 0.42));
          ctx.lineTo(bx + r * 0.18 * nx, h.y - r * 0.72);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 'topknot':
        ctx.beginPath();
        ctx.ellipse(h.x, h.y - r * 0.66, r * 0.86, r * 0.4, 0, Math.PI, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(h.x - r * 0.22 * nx, h.y - r * 1.14, r * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      case 'buzz':
        ctx.beginPath();
        ctx.ellipse(h.x, h.y - r * 0.24, r * 0.85, r * 0.86, 0, Math.PI * 1.06, Math.PI * 1.94);
        ctx.fill();
        break;
      default:
        ctx.beginPath();
        ctx.moveTo(h.x - r * 0.86 * nx, h.y - r * 0.24);
        ctx.quadraticCurveTo(h.x - r * 0.5 * nx, h.y - r * 1.18, h.x + r * 0.6 * nx, h.y - r * 0.86);
        ctx.quadraticCurveTo(h.x + r * 0.86 * nx, h.y - r * 0.64, h.x + r * 0.74 * nx, h.y - r * 0.36);
        ctx.quadraticCurveTo(h.x + r * 0.2 * nx, h.y - r * 0.74, h.x - r * 0.86 * nx, h.y - r * 0.24);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
    }
  }

  private drawGloves(
    ctx: CanvasRenderingContext2D,
    rs: RenderState,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
  ): void {
    const line = shade(style.glove, 0.35);
    // The extended glove reads as the business end, so it gets a size bump.
    const extL = clamp01((P.handL.x - P.shoulderL.x) * rs.facing / (unit * 26));
    const extR = clamp01((P.handR.x - P.shoulderR.x) * rs.facing / (unit * 30));

    this.drawGlove(ctx, P.handR, P.elbowR, style, unit * (1 + extR * 0.16), bulk, outline, line, 0.86);
    this.drawGlove(ctx, P.handL, P.elbowL, style, unit * (1 + extL * 0.16), bulk, outline, line, 1);
  }

  private drawGlove(
    ctx: CanvasRenderingContext2D,
    hand: Pt,
    elbow: Pt,
    style: FighterStyle,
    unit: number,
    bulk: number,
    outline: number,
    line: string,
    tone: number,
  ): void {
    const r = unit * 6.4 * (0.92 + bulk * 0.1);
    const dx = hand.x - elbow.x;
    const dy = hand.y - elbow.y;
    const len = Math.max(0.001, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;

    // Cuff sits back along the forearm.
    const cuff = SCRATCH3;
    cuff.x = hand.x - ux * r * 0.95;
    cuff.y = hand.y - uy * r * 0.95;

    limbPath(ctx, cuff, hand, r * 0.78, r);
    const g = ctx.createLinearGradient(hand.x - r, hand.y - r, hand.x + r, hand.y + r);
    g.addColorStop(0, shade(style.glove, 1.1 * tone));
    g.addColorStop(1, shade(style.glove, 0.62 * tone));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = outline;
    ctx.strokeStyle = line;
    ctx.stroke();

    // Cuff band.
    ctx.beginPath();
    ctx.moveTo(cuff.x - uy * r * 0.74, cuff.y + ux * r * 0.74);
    ctx.lineTo(cuff.x + uy * r * 0.74, cuff.y - ux * r * 0.74);
    ctx.lineWidth = Math.max(1.5, unit * 2.2);
    ctx.strokeStyle = shade(style.gloveTrim, tone);
    ctx.stroke();

    // Seam + highlight.
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, r * 0.62, Math.PI * 0.15, Math.PI * 0.95);
    ctx.lineWidth = Math.max(1, unit * 1.05);
    ctx.strokeStyle = shade(style.glove, 0.5 * tone);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(hand.x - r * 0.28, hand.y - r * 0.3, r * 0.42, Math.PI * 1.05, Math.PI * 1.75);
    ctx.lineWidth = Math.max(1, unit * 1.5);
    ctx.strokeStyle = withAlpha('#ffffff', 0.5 * tone);
    ctx.stroke();
  }

  private drawRimLight(ctx: CanvasRenderingContext2D, rs: RenderState, unit: number, facing: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= 0.45;
    ctx.lineWidth = Math.max(1, unit * 1.5);
    ctx.strokeStyle = rs.rage > 0.35 ? 'rgba(255,150,60,0.9)' : 'rgba(190,220,255,0.75)';
    ctx.lineCap = 'round';

    const off = unit * 1.2 * facing;
    ctx.beginPath();
    ctx.moveTo(P.shoulderL.x + off, P.shoulderL.y);
    ctx.quadraticCurveTo(P.chest.x + unit * 9 * facing, P.chest.y, P.hipL.x + off, P.hipL.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(P.head.x, P.head.y - unit * 0.6, unit * 7.6, -Math.PI * 0.42 * facing, Math.PI * 0.22 * facing, facing < 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(P.shoulderL.x + off, P.shoulderL.y);
    ctx.lineTo(P.elbowL.x + off, P.elbowL.y);
    ctx.lineTo(P.handL.x + off, P.handL.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawEmbers(ctx: CanvasRenderingContext2D, rs: RenderState, unit: number, timeMs: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const n = 6;
    for (let i = 0; i < n; i += 1) {
      const seed = i * 2.399;
      const t = ((timeMs * 0.0006 + seed) % 1);
      const x = rs.worldX + Math.sin(seed * 4.7 + timeMs * 0.001) * unit * 16;
      const y = rs.worldY - t * unit * 90;
      const a = (1 - t) * 0.55 * rs.rage;
      ctx.globalAlpha = a;
      ctx.fillStyle = i % 2 ? '#ffb020' : '#ff6a00';
      ctx.beginPath();
      ctx.arc(x, y, unit * (0.9 + (1 - t) * 1.1), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Impact flash: the silhouette re-drawn hot, not a white box over the sprite. */
  private drawFlash(ctx: CanvasRenderingContext2D, rs: RenderState, unit: number, bulk: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(rs.flash) * 0.7;
    ctx.fillStyle = '#ffffff';

    const parts: [Pt, Pt, number, number][] = [
      [P.hipR, P.kneeR, unit * 5.4 * bulk, unit * 4 * bulk],
      [P.kneeR, P.footR, unit * 3.8 * bulk, unit * 2.9 * bulk],
      [P.hipL, P.kneeL, unit * 5.8 * bulk, unit * 4.2 * bulk],
      [P.kneeL, P.footL, unit * 4 * bulk, unit * 3 * bulk],
      [P.shoulderR, P.elbowR, unit * 4.6 * bulk, unit * 3.6 * bulk],
      [P.elbowR, P.handR, unit * 3.4 * bulk, unit * 3 * bulk],
      [P.shoulderL, P.elbowL, unit * 4.8 * bulk, unit * 3.8 * bulk],
      [P.elbowL, P.handL, unit * 3.6 * bulk, unit * 3.1 * bulk],
      [P.pelvis, P.chest, unit * 8.4 * bulk, unit * 10 * bulk],
      [P.chest, P.neck, unit * 10 * bulk, unit * 4 * bulk],
    ];
    for (const [a, b, ra, rb] of parts) {
      limbPath(ctx, a, b, ra, rb);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(P.head.x, P.head.y, unit * 7.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------ portrait

  drawPortrait(
    ctx: CanvasRenderingContext2D,
    style: FighterStyle,
    box: { x: number; y: number; w: number; h: number },
    timeMs: number,
  ): void {
    const { x, y, w, h } = box;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const bg = ctx.createRadialGradient(x + w * 0.5, y + h * 0.42, w * 0.05, x + w * 0.5, y + h * 0.5, w * 0.78);
    bg.addColorStop(0, withAlpha(style.accent, 0.28));
    bg.addColorStop(0.6, 'rgba(10,12,21,0.9)');
    bg.addColorStop(1, 'rgba(6,7,13,1)');
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);

    const unit = h / 46;
    const bob = Math.sin(timeMs * 0.0022) * unit * 0.7;
    const cx = x + w * 0.5;
    const cy = y + h * 0.62 + bob;
    const bulk = style.features?.bulk ?? 1;
    const outline = Math.max(1.3, unit * 2);
    const line = shade(style.skinShadow, 0.42);
    const lit = shade(style.skin, 1.16);

    // Shoulders.
    ctx.beginPath();
    ctx.moveTo(cx - unit * 15 * bulk, y + h);
    ctx.quadraticCurveTo(cx - unit * 13 * bulk, cy + unit * 9, cx - unit * 6, cy + unit * 6);
    ctx.lineTo(cx + unit * 6, cy + unit * 6);
    ctx.quadraticCurveTo(cx + unit * 13 * bulk, cy + unit * 9, cx + unit * 15 * bulk, y + h);
    ctx.closePath();
    const sg = ctx.createLinearGradient(cx - unit * 15, cy, cx + unit * 15, y + h);
    sg.addColorStop(0, style.skinShadow);
    sg.addColorStop(1, style.skin);
    this.strokeFill(ctx, sg, outline, line);

    // Head reuses the in-ring helpers so portraits and fighters always match.
    P.head.x = cx;
    P.head.y = cy - unit * 2;
    P.neck.x = cx;
    P.neck.y = cy + unit * 7;
    const r = unit * 8.4;
    limbPath(ctx, P.neck, P.head, unit * 3.8 * bulk, unit * 3.4 * bulk);
    this.strokeFill(ctx, shade(style.skinShadow, 0.95), outline, line);

    ctx.beginPath();
    ctx.ellipse(P.head.x, P.head.y - r * 0.08, r * 0.86, r, 0, 0, Math.PI * 2);
    const hg = ctx.createLinearGradient(P.head.x - r, P.head.y - r, P.head.x + r, P.head.y + r);
    hg.addColorStop(0, style.skinShadow);
    hg.addColorStop(0.6, style.skin);
    hg.addColorStop(1, lit);
    this.strokeFill(ctx, hg, outline, line);

    ctx.fillStyle = '#12131a';
    ctx.beginPath();
    ctx.ellipse(P.head.x - r * 0.32, P.head.y - r * 0.06, r * 0.12, r * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(P.head.x + r * 0.32, P.head.y - r * 0.06, r * 0.12, r * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(style.skinShadow, 0.45);
    ctx.lineWidth = Math.max(1, unit * 0.9);
    ctx.beginPath();
    ctx.moveTo(P.head.x - r * 0.24, P.head.y + r * 0.5);
    ctx.lineTo(P.head.x + r * 0.24, P.head.y + r * 0.5);
    ctx.stroke();

    this.drawHair(ctx, style, P.head, r, 1, outline, line);

    ctx.restore();
  }
}

export const proceduralSkin = new ProceduralSkin();
