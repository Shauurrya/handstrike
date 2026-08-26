/** Shared primitives used across vision, combat and rendering. */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

/** Which side of the *player's own body* something belongs to. */
export type Side = 'left' | 'right';

/** A fighter's facing direction along the X axis. 1 = facing right. */
export type Facing = 1 | -1;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Region = 'head' | 'body' | 'legs';
