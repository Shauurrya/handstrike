# Assets — and how to drop in your own fighter

Nothing in `src/game/`, `src/entities/` or `src/data/` (except the cosmetic palette) knows what a fighter looks like. Art is reached only through the **skin registry**, so replacing it is additive: you add a file and register it, and combat, AI, hitboxes and animation carry on unchanged.

```
assets/
  fighters/
    player/      your character's sprite sheet / frames go here
    enemies/     per-opponent art
  animations/
    player/      per-state frame data (JSON) for the player
    enemies/
  arena/         optional backdrops or ring overlays
  audio/         optional recorded sfx (the game synthesises its own by default)
  effects/       optional particle textures
```

> Anything the browser must fetch at runtime has to live under `public/` (e.g. `public/assets/fighters/player/...`). Keep source art here; copy or symlink what ships into `public/`.

---

## Level 1 — recolour only (no code)

If the procedural fighter's shapes are fine and you just want your character's colours and features, edit `src/data/fighters.ts`. A `FighterStyle` controls skin tone, trunks, gloves, boots, accent, hair, and `features` (`hairStyle`, `beard`, `headgear`, `mask`, `tattoo`, plus `bulk` / `height` / `reach` multipliers that change the silhouette and punching range).

## Level 2 — one static image

If your character is a single image, **do not** stretch and rotate it to fake every animation — it reads as a cutout. Use it for the portrait and menu identity while the rig keeps handling motion:

```ts
// src/render/skins/PortraitSkin.ts
import { ProceduralSkin } from '../ProceduralSkin';

class PortraitSkin extends ProceduralSkin {
  readonly id = 'player';
  private readonly img = Object.assign(new Image(), { src: '/assets/fighters/player/bust.png' });

  drawPortrait(ctx, _style, box) {
    if (this.img.complete) ctx.drawImage(this.img, box.x, box.y, box.w, box.h);
  }
}
```

Then register it (see below).

## Level 3 — a full sprite-sheet skin

Implement the `FighterSkin` interface from `src/types/fighter.ts`:

```ts
export interface FighterSkin {
  readonly id: string;
  draw(ctx, rs: RenderState, style: FighterStyle, timeMs: number): void;
  drawPortrait(ctx, style, box, timeMs: number): void;
}
```

`draw` receives a fully resolved `RenderState` every frame:

| Field | Meaning |
| --- | --- |
| `state` | the current `AnimState` (`JAB_L`, `GUARD`, `KNOCKDOWN`, …) |
| `phase` | progress through that clip, `0..1` — index your frame with this |
| `facing` | `1` or `-1` |
| `worldX`, `worldY` | the fighter's feet, in world pixels |
| `height` | on-screen height in pixels for a 100-unit rig |
| `pose` | the posed skeleton, if you want to pin effects to joints |
| `flash`, `rage`, `guarding`, `downed`, `alpha` | presentation state |

A sprite skin only needs `state` and `phase`:

```ts
const frames = SHEET[rs.state];                       // frames for this state
const frame  = frames[Math.min(frames.length - 1, Math.floor(rs.phase * frames.length))];
ctx.save();
ctx.translate(rs.worldX, rs.worldY);
ctx.scale(rs.facing, 1);                              // mirror to face the opponent
ctx.globalAlpha = rs.alpha;
ctx.drawImage(sheet, frame.sx, frame.sy, frame.sw, frame.sh,
              -rs.height * 0.5, -rs.height, rs.height, rs.height);
ctx.restore();
```

Register it once at startup — for example at the top of `src/App.tsx`:

```ts
import { registerSkin } from '@/render/skins';
import { spriteSkin } from '@/render/skins/SpriteSkin';

registerSkin(spriteSkin);   // id 'player' now overrides the procedural skin
```

`getSkin(id)` returns your skin for that id and falls back to the procedural one for every other fighter, so you can convert one character at a time.

### Matching the timing

Animation timing lives in `src/data/animations.ts`, separate from the art. Each clip has a `duration`, a `priority`, an optional `blendIn`, and — for attacks — an `impactAt` marker (`0..1`) that is when the hitbox goes live. If your sprite's punch connects on a different frame, change `impactAt` and the gameplay follows the art. You do not need to touch `CombatSystem`.

The full state list a fighter can be asked to draw:

```
IDLE STANCE WALK_FWD WALK_BACK
JAB_L CROSS_R HOOK_L HOOK_R UPPERCUT_L UPPERCUT_R
GUARD BLOCK_IMPACT DODGE_LEFT DODGE_RIGHT DUCK
HIT_HEAD HIT_BODY STAGGER KNOCKDOWN GET_UP
RAGE VICTORY DEFEAT
```

If your sheet is missing a state, map it to the nearest one you have — the engine will never ask for a state that is not in this list.

---

## Audio

Every sound is synthesised in `src/audio/AudioEngine.ts` — no files, nothing copyrighted. To use recorded audio instead, load buffers from `public/assets/audio/` and play them inside `AudioEngine.play()`; the rest of the game only ever calls `audio.play(name)`.
