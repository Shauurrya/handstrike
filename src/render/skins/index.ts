import type { FighterSkin } from '@/types/fighter';
import { proceduralSkin } from '../ProceduralSkin';

/**
 * Skin registry.
 *
 * Combat code only ever asks for a skin by id, so a sprite-sheet or hand-drawn
 * skin can be registered here later and take over a fighter's look without a
 * single change to the game systems. That is the whole point of the indirection.
 */

const registry = new Map<string, FighterSkin>();

export function registerSkin(skin: FighterSkin): void {
  registry.set(skin.id, skin);
}

export function getSkin(id: string): FighterSkin {
  return registry.get(id) ?? proceduralSkin;
}

export { proceduralSkin } from '../ProceduralSkin';
