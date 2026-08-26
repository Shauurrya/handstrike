# HANDSTRIKE — Real-Time Webcam Boxing

An arcade boxing game controlled entirely by your webcam. You physically throw punches, guard, slip and duck in front of a normal laptop camera; your on-screen fighter throws them for you against an opponent driven by a real combat AI.

**All computer vision runs locally in your browser.** No frame is ever uploaded, recorded or stored. There is no backend and no database.

---

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (camera access needs `localhost` or HTTPS).

```bash
npm run build     # typecheck + production bundle into dist/
npm run preview   # serve the production bundle locally
npm run typecheck # types only
```

---

## Deploying to Vercel

The project is a pure static site and needs no configuration beyond what is committed.

1. Push the repo to GitHub.
2. Import it in Vercel. The framework preset auto-detects as **Vite**.
3. Deploy. `vercel.json` already sets the build command, output directory, SPA rewrites, long-lived cache headers for the model files, and `Permissions-Policy: camera=(self)`.

No environment variables are required. Vercel serves over HTTPS, which is all the camera API needs.

> `npm install` runs `scripts/prepare-assets.mjs`, which copies the MediaPipe WASM runtime out of `node_modules` and downloads the two `.task` models into `public/`. Both models are also committed, so the build works even with no network. If an asset is somehow missing at runtime, the vision layer falls back to the public CDN rather than failing.

---

## How it plays

| You do | The game reads |
| --- | --- |
| Snap your **left hand** out and back | Left jab / left hook |
| Snap your **right hand** out and back | Right cross / right hook |
| Fast **upward** hand drive | Uppercut |
| **Both hands beside your face** | Guard |
| Shift your **body left / right** | Dodge left / right |
| **Drop your body down** | Duck |
| **Both fists above your head** | Rage mode |

Three rules matter:

- Throw punches with **quick, visible hand movements**.
- **Do not punch toward the camera** — a 2D webcam cannot see that reliably, and the game never asks it to.
- Keep your hands in frame.

### Keyboard fallback

`A`/`D` move · `J` left jab · `K` right cross · `U` left hook · `I` right hook · `O` uppercut · `Space` guard · `Shift` dodge · `S` duck · `E` rage · `Esc` pause.

---

## The design constraint that shaped everything

A normal webcam gives you 2D landmarks and nothing trustworthy about depth. So the game is built only on what such a camera reads reliably:

- **Nothing uses raw pixels.** Every threshold is expressed in *palm widths* (hands) or *shoulder widths* (body). Hand velocity is divided by a slowly-adapting median palm size, so the identical punch produces the same reading whether you sit close to the lens or far from it. The self-test below proves it: the same gesture at half the apparent scale scores 59 vs 56 strike power.
- **A visible fist is not a punch.** Detection is a per-hand temporal state machine — a burst has to start with real acceleration, sustain speed, cover a minimum distance, and then decelerate before it is classified.
- **Classification degrades instead of refusing.** High confidence names the punch. Medium confidence still fires, as a generic straight for that hand. Only genuine noise is dropped, because a game that swallows your input feels broken.
- **Pose is an extra layer, never a dependency.** If the pose model is missing or your torso leaves the frame, guard and dodge fall back to hand positions; only ducking genuinely needs shoulders in view.
- **Apparent size, not depth.** The classifier does use the fist visibly *growing* in frame as a hint that a punch came forward. That is a 2D blob-size cue, not a depth estimate.

Calibration (about 10 seconds, always skippable) measures your own resting scale and your own natural punch speed, then derives every threshold from them.

---

## Architecture

```
src/
  types/        Shared contracts (core, vision, fighter, combat, ai)
  config/       gameConfig.ts — all balance and feel tuning in one file
  utils/        math, One Euro smoothing / hysteresis, localStorage wrapper
  vision/       CameraManager, HandTracker, PoseTracker, MotionAnalyzer,
                PunchDetector, GestureDetector, CalibrationSystem,
                VisionController (owns the detection loop), visionSelfTest
  game/         GameEngine, CombatSystem, HitboxSystem, ComboSystem,
                RoundSystem, RageSystem, AIController, PlayerProfiler,
                AnimationSystem, ParticleSystem, ScreenFx, TrainingMode,
                KeyboardInput
  entities/     Fighter — vitals, attack state machine, hurtboxes, rig
  render/       ArenaRenderer, ProceduralSkin, skins/ (swappable registry)
  data/         attacks, fighters, enemies, difficulty, career, animations
  components/   React screens and HUD overlays
  store/        appState — settings, career, training records, persistence
```

**Vision never blocks rendering.** The vision loop runs on `requestVideoFrameCallback` at ~30Hz and publishes an immutable frame; the game loop runs on `requestAnimationFrame` at 60fps and reads the latest frame. A slow inference frame cannot stall the fight. React is fed a throttled ~10Hz snapshot so the component tree is not re-rendered 30 times a second.

### The AI

The opponent is a finite state machine over `IDLE / OBSERVE / APPROACH / RETREAT / ATTACK / COMBO / BLOCK / DODGE / COUNTER / RECOVER / LOW_STAMINA / STAGGER / ENRAGED / KNOCKED_DOWN / GET_UP / DEFEATED`, with two ideas doing the heavy lifting:

- **Nothing is instant.** Every response goes through a reaction queue. If your punch lands before the scheduled reaction fires, the AI wears it. That single rule is what makes difficulty readable without touching damage numbers.
- **Everything is a read.** `PlayerProfiler` tracks your favourite hand, favourite punch, combo length, aggression, whiff rate and dodge preference. The controller spends those reads — guarding the side you throw from, blocking the punch you love, walking you down once you have burnt your stamina. Every adaptation is scaled by the model's confidence, so two data points never swing behaviour.

Difficulty changes reaction time, mistake rate, block/dodge/counter probability and adaptation speed — not hit points.

---

## Verifying the vision pipeline

Punch detection is the one system you cannot check by clicking around, so there is a synthetic harness that drives `MotionAnalyzer → PunchDetector → GestureDetector` with fabricated landmark streams. It needs no camera and no model.

With the dev server running, in the browser console:

```js
const { runVisionSelfTest } = await import('/src/vision/visionSelfTest.ts');
console.table(runVisionSelfTest().cases);
```

It asserts that straights, hooks and uppercuts classify correctly; that slow drifts and landmark jitter are ignored; that raising into a guard is never mistaken for a double uppercut; that guard, dodge and duck latch; that hand identity survives the hands crossing; and — the important one — that the same gesture fires at two very different distances from the lens.

---

## Swapping in your own fighter art

Fighters are drawn by a **skin**, and skins are looked up by id through a registry. Combat, animation and AI never touch artwork, so replacing the art changes nothing else. See [`assets/README.md`](assets/README.md) for the full guide.

---

## Storage

`localStorage` only, for settings, career progress, calibration and training bests. The game is fully playable with storage blocked — progression simply does not persist.

---

## Credits

All art, animation, audio and fighter designs are original and generated at runtime: the fighters are drawn procedurally from a skeletal rig, the arena is drawn to canvas, and every sound is synthesised with the Web Audio API. No copyrighted characters, sprites or music are used.
