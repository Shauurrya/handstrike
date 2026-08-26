import type { FighterStyle } from '@/types/fighter';

/**
 * Visual identities for the procedural skin.
 *
 * Silhouette does the heavy lifting: at 330px tall on a dark mat, a player can
 * only read bulk, height, reach and headshape — so no two fighters share a
 * combination of those. Colour is the secondary cue and every palette is kept
 * clear of the HUD tokens (`PALETTE.player` teal, `PALETTE.enemy` crimson) so a
 * fighter's trunks can never be mistaken for a health bar bleeding through.
 */

export const PLAYER_STYLE_ID = 'player';

/** Kept as a standalone const so `getStyle` always has a real object to return. */
const PLAYER_STYLE: FighterStyle = {
  id: PLAYER_STYLE_ID,
  name: 'KAI RENNER',
  tagline: 'Clean hands, cold head.',
  skin: '#c98a5f',
  skinShadow: '#8d5a39',
  trunks: '#0e1a26',
  trunksTrim: '#2ee0c4',
  glove: '#eef3ff',
  gloveTrim: '#2ee0c4',
  boots: '#101a25',
  accent: '#31e6c8',
  hair: '#171820',
  features: {
    hairStyle: 'short',
    tattoo: 'none',
    bulk: 1,
    height: 1,
    reach: 1,
  },
};

export const FIGHTER_STYLES: Record<string, FighterStyle> = {
  [PLAYER_STYLE_ID]: PLAYER_STYLE,

  // Widest, shortest silhouette in the game — a fireplug with no neck.
  brawler: {
    id: 'brawler',
    name: 'BOILER RUIZ',
    tagline: 'Walks through fire to give you some.',
    skin: '#e0ab84',
    skinShadow: '#a2714f',
    trunks: '#2b1408',
    trunksTrim: '#e0872c',
    glove: '#c85a1c',
    gloveTrim: '#f5c26b',
    boots: '#1d0e05',
    accent: '#e8952f',
    hair: '#3b2a1c',
    features: {
      hairStyle: 'bald',
      beard: true,
      tattoo: 'chest',
      bulk: 1.35,
      height: 0.96,
      reach: 0.94,
    },
  },

  // Smallest frame, lightest colours — reads as quick before he moves.
  speedster: {
    id: 'speedster',
    name: 'JETTA KANE',
    tagline: 'Hits you three times, then waves.',
    skin: '#b07a4f',
    skinShadow: '#79502f',
    trunks: '#141a09',
    trunksTrim: '#c9ff3d',
    glove: '#9ee01f',
    gloveTrim: '#f0ffd0',
    boots: '#10160a',
    accent: '#c9ff3d',
    hair: '#c9ff3d',
    features: {
      hairStyle: 'mohawk',
      tattoo: 'sleeve',
      bulk: 0.85,
      height: 0.94,
      reach: 0.97,
    },
  },

  // Headgear plus heavy shoulders: a squared-off block of a man.
  defender: {
    id: 'defender',
    name: 'ATLAS BRUNE',
    tagline: 'Bring a key or go home.',
    skin: '#6d4a32',
    skinShadow: '#42291a',
    trunks: '#101f2d',
    trunksTrim: '#5f96c9',
    glove: '#2d4a67',
    gloveTrim: '#8fbde8',
    boots: '#0b1620',
    accent: '#6fa8dc',
    hair: '#1a1a1e',
    features: {
      hairStyle: 'buzz',
      headgear: true,
      tattoo: 'none',
      bulk: 1.24,
      height: 1.02,
      reach: 1,
    },
  },

  // Tall, narrow, masked — the longest reach and the least readable face.
  counterpuncher: {
    id: 'counterpuncher',
    name: 'SILAS VEYNE',
    tagline: 'Throws once. Waits for you to donate the opening.',
    skin: '#4f3524',
    skinShadow: '#2b1c11',
    trunks: '#170f2b',
    trunksTrim: '#8b6cff',
    glove: '#3a2570',
    gloveTrim: '#b9a6ff',
    boots: '#120c22',
    accent: '#8b6cff',
    hair: '#0f0d16',
    features: {
      hairStyle: 'topknot',
      mask: true,
      tattoo: 'none',
      bulk: 0.92,
      height: 1.06,
      reach: 1.12,
    },
  },

  // Tallest and gold-trimmed. Big without being bloated — the finished article.
  champion: {
    id: 'champion',
    name: 'VALE AUGUST',
    tagline: 'The belt is not on loan.',
    skin: '#8d5b34',
    skinShadow: '#573520',
    trunks: '#1b1509',
    trunksTrim: '#f4d06a',
    glove: '#e0b747',
    gloveTrim: '#fff3c4',
    boots: '#14100a',
    accent: '#f2c14e',
    hair: '#241a12',
    features: {
      hairStyle: 'afro',
      beard: true,
      tattoo: 'sleeve',
      bulk: 1.12,
      height: 1.08,
      reach: 1.08,
    },
  },
};

/** Cosmetics must never break a fight, so an unknown id quietly becomes the hero. */
export function getStyle(id: string): FighterStyle {
  const found = FIGHTER_STYLES[id] as FighterStyle | undefined;
  return found ?? PLAYER_STYLE;
}
