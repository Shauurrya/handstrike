import type { Box, Region } from '@/types/core';
import type { AttackDef } from '@/types/combat';
import type { Hurtbox } from '@/types/fighter';
import type { Fighter } from '@/entities/Fighter';
import { overlapArea } from '@/utils/math';

/**
 * Game-side hit detection. A punch is never "detected therefore -10 HP": the
 * attacker's glove carries a hitbox that has to physically overlap one of the
 * defender's hurtboxes, and *which* box it overlaps decides the reaction.
 *
 * Hitboxes are anchored to the animated glove rather than to the fighter's
 * root, so a jab only reaches as far as the jab animation actually extends.
 */

const scratchGloves = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

/** The live hitbox for a fighter's current attack, in world space. */
export function buildAttackHitbox(fighter: Fighter, attack: AttackDef, out: Box): Box {
  fighter.gloves(scratchGloves);
  const glove = attack.hand === 'left' ? scratchGloves.left : scratchGloves.right;
  const unit = fighter.height / 100;

  // Generous enough that a well-timed punch never feels stolen, tight enough
  // that a whiff reads as a whiff.
  const w = unit * 26;
  const h = unit * 22;
  out.x = glove.x - w * 0.5;
  out.y = glove.y - h * 0.5;
  out.w = w;
  out.h = h;
  return out;
}

export interface HitTest {
  region: Region;
  x: number;
  y: number;
}

/**
 * Finds which hurtbox an attack connects with.
 * Ties break towards the attack's intended target so an uppercut aimed at the
 * head does not get downgraded to a body shot by a pixel of overlap.
 */
export function findHit(box: Box, hurtboxes: Hurtbox[], preferred: Region): HitTest | null {
  let best: Hurtbox | null = null;
  let bestScore = 0;

  for (const hb of hurtboxes) {
    const area = overlapArea(box.x, box.y, box.w, box.h, hb.x, hb.y, hb.w, hb.h);
    if (area <= 0) continue;
    // Legs are a last resort; a punch that only clips the legs still counts as
    // a body shot in arcade terms, but never outranks a real connection.
    const weight = hb.region === preferred ? 1.6 : hb.region === 'legs' ? 0.4 : 1;
    const score = area * weight;
    if (score > bestScore) {
      bestScore = score;
      best = hb;
    }
  }

  if (!best) return null;
  return {
    region: best.region === 'legs' ? 'body' : best.region,
    x: Math.max(box.x, best.x) + Math.min(box.x + box.w, best.x + best.w) - Math.max(box.x, best.x) * 0.5,
    y: Math.max(box.y, best.y) + (Math.min(box.y + box.h, best.y + best.h) - Math.max(box.y, best.y)) * 0.5,
  };
}

/** Centre-to-centre horizontal distance between two fighters. */
export function gapBetween(a: Fighter, b: Fighter): number {
  return Math.abs(a.x - b.x);
}

/** Whether an attack is even close enough to be worth testing. */
export function inRange(attacker: Fighter, defender: Fighter, attack: AttackDef): boolean {
  return gapBetween(attacker, defender) <= attack.range;
}

export const makeBox = (): Box => ({ x: 0, y: 0, w: 0, h: 0 });
