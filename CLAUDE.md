# CLAUDE.md

Context for coding agents working on this repo. `README.md` covers what the app does and how to run it. This file covers how the code is put together, what is fragile, and where it is headed.

## Status

- A working toy, verified in headless Chrome and by the owner on a real MacBook webcam.
- It will be absorbed into a larger project. Keep modules self-contained so they lift out cleanly (see [Absorbing this into another project](#absorbing-this-into-another-project)).
- Stack: Vite 6, strict TypeScript, no framework, `@mediapipe/tasks-vision` 1.2.2. The only runtime dependency is MediaPipe.

## Commands

- `npm run dev`: dev server. `npm run build`: typecheck and build a static site into `dist/`.
- `npm run typecheck`: run it after every change.
- `npm run smoke`: the headless end-to-end check. Run it before claiming a change works. It needs `npx playwright install chromium` once, or `CHROME_PATH` pointed at a Chrome binary.
- `scripts/copy-wasm.mjs` copies the MediaPipe wasm into `public/wasm`, which is gitignored. Every npm script above runs it first.

## Architecture

| File | Role |
|---|---|
| `src/main.ts` | UI wiring, settings (read from DOM inputs every frame, persisted to `localStorage`), photo loading, camera toggle, `requestAnimationFrame` loop, `window.eyesTest` hook |
| `src/vision.ts` | `createLandmarker()` (GPU, falling back to CPU) and the landmark index tables (eyelids, irises) |
| `src/portrait.ts` | One-time photo analysis: tiled face detection, iris removal, iris disc extraction, pupil dilation pre-renders. The bulk of the image processing |
| `src/inpaint.ts` | `pushPullFill`: pyramid fill, used as a fallback for the sclera |
| `src/tracker.ts` | `ViewerTracker`: webcam plus VIDEO-mode landmarker, returns the closest viewer |
| `src/gaze.ts` | `FaceBehavior`: everything that is time-based (gaze filter, saccades, idle wandering, blinks, head lag, pupils, surprise, stare-and-glance) |
| `src/renderer.ts` | `PortraitRenderer`: per-frame Canvas 2D composite of each eye, then hands off to the warp |
| `src/warp.ts` | `FaceWarp`: WebGL2 full-screen pass that displaces each face by a Gaussian bump (the head turn). Returns null without WebGL2 |
| `src/geometry.ts` | `Pt`, `traceCurve`, `clamp`, `shift` |

Data flow: photo → `analyzePortrait()` → `Portrait { clean, original, faces[] }` (immutable after this). Each frame: `tracker.poll()` → `Viewer | null | undefined` → `FaceBehavior.update()` per face → `FaceState[]` → `renderer.draw()` → `warp.render()`.

### Key types

- `Portrait`: `width`, `height`, `original` canvas, `clean` canvas (irises painted out), `faces`, `warnings`.
- `Eye`: `upper`/`lower` lid curves (image pixels, left to right), `iris` center, `irisR`, `opening`, `crop` rect, `mask` (eye opening, sized to `crop`), `discs[]` (one per `DILATIONS` level) and `discCenter`.
- `Viewer`: raw, unmirrored camera coordinates (0..1). `x`, `y` are the eye midpoint; `size` is the inter-iris distance as a fraction of frame width (larger means closer); `blink` is per side.
- `FaceState`: `gaze` and `head` in radians (+yaw looks toward image right, +pitch looks down), `closure` per eye (0 open, 1 shut), `dilation` (1 means the photo's own pupil size).
- `poll()` returns `undefined` when there is no new camera frame, which means "keep the last viewer". It returns `null` when nobody is in view. Don't collapse the two.

## Conventions

- Image coordinates throughout, in pixels of the working image. The working image is the upload capped at 2048px on its longest side.
- Eyes are sorted by image x (image-left first), not by anatomical left or right. `vision.ts` names them A and B only for landmark tables.
- Tunables are named constants at the top of each file, each with a one-line comment giving its meaning and units. Keep it that way: no magic numbers inline.
- Comments explain why, not what. Match the existing density.
- No new runtime dependencies without a strong reason. The bundle is small and works offline.

## Invariants and gotchas

- **Read the cleaned crop from the `clean` canvas**, not from the original pixels. With several faces, building an eye from the original pixels overwrites a neighbouring face's repainted iris.
- **The sclera fill must only sample pixels that look like eye white.** MediaPipe's lid contours run a pixel or two loose, so naive fills pull in skin and lashes. `scleraLike()` filters by brightness (at least 0.7 × reference) and warmth (red minus blue no more than reference + 25). Loosening it brings back skin-coloured eye whites.
- **Hidden iris is rebuilt by rotation**, skipping catchlights. Mirroring or a pyramid fill produced grey, washed-out discs; don't go back to them.
- **The warp canvas needs `preserveDrawingBuffer: true`**, or `toDataURL` (used by tests and screenshots) returns blank.
- **`[hidden] { display: none !important }` in `style.css` is load-bearing.** Elements styled with `display: grid/flex` otherwise ignore `hidden`.
- **Mirroring:** the webcam is not mirrored in the data. Gaze yaw is `(0.5 − viewer.x) × FOV`, which is correct for a viewer facing the screen. The debug picture-in-picture is mirrored with CSS only.
- **The camera auto-starts** after a photo loads (`loadPortrait` → `toggleCamera`). The status line keeps the face-count message rather than overwriting it with "Starting camera…".
- Faces with iris radius below 2.5px are skipped. At most 12 faces (the warp shader uniform size).
- Two landmarker instances exist: IMAGE mode with `numFaces` 10 for photos, VIDEO mode with `numFaces` 4 and blendshapes for the webcam. MediaPipe can't switch running mode cheaply, so keep them separate.

## Tuning reference

| Constant | File | Value | Effect |
|---|---|---|---|
| `H_FOV` / `V_FOV` | gaze.ts | 62° / 48° | Assumed webcam field of view |
| `EYE_TAU` | gaze.ts | 45ms | Saccade settle time |
| `HEAD_TAU` | gaze.ts | 0.4s | Head lag behind the eyes |
| `PUPIL_TAU` | gaze.ts | 0.5s | Pupil response |
| `IDLE_AFTER_MS` | gaze.ts | 1500 | Wait before wandering, and the absence needed for "surprise" |
| Stare limit | gaze.ts | random 5–10s | Steady eye contact before glancing away for 0.8–1.6s |
| Dilation target | gaze.ts | 1 + 0.6 × closeness + surprise | Closeness is `clamp((size − 0.06) / 0.12)`; surprise is 0.35, decaying over 1.2s |
| `EYEBALL_RATIO` | renderer.ts | 2.0 | Eyeball radius ÷ iris radius; sets how far the iris travels |
| `HEAD_SHIFT_X/Y` | renderer.ts | 0.1 / 0.07 | Head-turn displacement per radian, as a fraction of face width |
| `HEAD_SIGMA_X/Y` | renderer.ts | 0.3 / 0.42 | Size of the region the head turn moves, as a fraction of face width |
| `HOLE_R` / `HOLE_FADE_R` | portrait.ts | 1.15 / 1.35 × irisR | Iris paint-out radius and its feather |
| `DISC_R` | portrait.ts | 1.08 × irisR | Iris disc radius |
| `DILATIONS` | portrait.ts | 1 to 1.96, step 0.12 | Pre-rendered pupil scales; the renderer crossfades between neighbours |

## Testing

- `tests/smoke.mjs` is the only automated test. It starts Vite on a random port, so it doesn't need a running dev server.
- `window.eyesTest.setViewer(v)` overrides the webcam: pass a `Viewer`, `null` (nobody in view) or `undefined` (back to the real camera).
- `window.eyesTest.layers()` returns data URLs for the clean image followed by each eye's largest disc. Its length is 1 + 2 × faces.
- Turn off `autoBlink`, `reactions` and `mirrorBlink` for deterministic frames, as the smoke test does.
- Judge visual changes by looking at the screenshots. Pixel inequality only proves something moved, not that it looks right. Useful test photos: a front-facing headshot, a squinting or smiling one, and a group shot with small faces.
- Fake webcam: Chrome flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-video-capture=clip.y4m`.

## Known limitations

- Squinting eyes: the revealed eye white looks flat and bright.
- The photo's gaze is taken as straight ahead. A subject glancing sideways stays offset.
- Blink mirroring maps MediaPipe's `eyeBlinkLeft`/`Right` to screen sides without a real-camera check that left and right are the right way round.
- Pupil dilation is subtle on small or dark irises.
- With several people in front of the camera, every face follows the closest one.
- The head turn is a 2D warp. Past about 0.8 on the slider it reads as rubbery, especially on faces already turned away from the camera.

## Roadmap ideas, not started

- **Remember the last photo** across refreshes (IndexedDB).
- **Per-face targets**: when several viewers are present, faces split their attention between them.
- **Static hosting**: `npm run build` output works on any static host over HTTPS. Vite's `base` may need setting for a subpath.
- **LivePortrait pose grid** (the realism upgrade): render about 40–60 gaze and head poses once per photo, server-side or offline, then blend between them live, as the Mona Lisa Effect did.
  - It would bring real head turns and eyelid movement.
  - Its standard pipeline uses InsightFace, which is licensed for non-commercial use only. Check before any commercial use.
  - No live in-browser LivePortrait exists today. The ONNX port (`slperez/LP-Distilled0.1-ONNX`) is an experimental 256px proof of concept.

## Absorbing this into another project

- The reusable core is `vision.ts`, `portrait.ts`, `inpaint.ts`, `geometry.ts`, `renderer.ts`, `warp.ts`, `gaze.ts` and `tracker.ts`. None of them touch the DOM beyond canvases and the `<video>` they're given.
- `main.ts`, `index.html` and `style.css` are this app's shell. Replace them with the host app's UI and drive the same loop: `analyzePortrait` once, then `update` and `draw` every frame.
- Asset paths come from `import.meta.env.BASE_URL` in `vision.ts`. The host must serve `wasm/` (copied from `@mediapipe/tasks-vision/wasm`) and `models/face_landmarker.task` under that base, or `createLandmarker` must be pointed elsewhere.
- Camera access needs a secure context (HTTPS or localhost).
