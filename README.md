# CV-Controlled Endless Runner

A webcam pose-estimation controlled 2D endless runner built with Phaser 3 and MediaPipe.

## Playing the runner

1. Start the app and camera, complete calibration, and hold a neutral standing
   pose. Gameplay waits until the CV controller is ready.
2. Physically **jump** over red ground hurdles. Physically **duck and hold** to
   pass below purple overhead barriers. The HUD previews the next movement.
3. A hit freezes the run and shows the final score. Click **Restart run**, click
   the canvas **Restart** prompt, or press **Space** after game over. Choose
   **Recalibrate / Restart** if your position or camera has changed.
4. Return to neutral to begin the next run. Camera tracking loss pauses physics,
   scrolling and score until valid neutral input returns.

The score is distance travelled divided by 10, rounded down. Best score persists
under `cv-runner.highScore.v1` in localStorage; denied or malformed storage does
not prevent play. Scroll speed ramps from 220 to 360 px/s as score increases.
Restart and tracking recovery provide 1.5 seconds of invulnerability, indicated
by a flashing player. Gameplay has no external art assets or asset-load delay.

Gameplay configuration lives in the exported `RUNNER` constants in
`src/game/GameScene.js`:

| Parameter | Value |
| --- | --- |
| Standing / airborne body | 30 × 60 px |
| Duck body | 30 × 28 px, feet anchored; 90 ms standing restoration |
| Jump velocity / world gravity | -600 px/s / 1400 px/s² |
| Low hurdles | 35–45 px high, 34–44 px wide |
| High barriers | 32 px high, lower edge 36 px above the ground |
| Obstacle pool | 8 reusable Arcade Physics rectangles |
| Recovery spacing | At least 2.2 seconds between clearing one obstacle and reaching the next, sized using maximum speed and player width |

`GameScene.jump()` and `duck(isDucking)` return whether the command was accepted.
`restartGame({ recalibrate: false })` resets the same scene and its pool, emits
`runner:restartRequested`, and waits for fresh neutral input. The main module
resets classifier history on this event. `setControllerStatus(valid, neutral,
reason)` handles waiting/pause/resume; `gameOver()` freezes physics and spawning.
Space only restarts after game over; jumping and ducking remain CV-controlled.

## Setup Instructions

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start development server:
   ```bash
   npm run dev
   ```

## Webcam and calibration

Open the local URL printed by Vite (normally `http://localhost:3000`). Click
**Start camera** and allow access. Stand upright facing the fixed camera, with
shoulders, hips, knees, ankles, heels and toes in frame. Hold still through the
3-second countdown in the State field. Movement, bent knees, low confidence,
offscreen landmarks or a gap in fresh results restart calibration. At least 30
valid observations are required. Click **Recalibrate** after moving the camera,
changing your distance or switching players. **Stop camera** releases capture.

The saved baseline contains `baselineHipY`, `baselineFootY`, `torsoHeight` and
`shoulderWidth`. These are averages of filtered normalized image coordinates;
distances are 2D Euclidean image distances, not meters or world-space measures.
Stillness checks use raw landmarks, anchored to the start of the hold, with a
maximum displacement of 10% of torso height. Straight-leg checks require knee
angles of at least 160 degrees. These thresholds can be adjusted in code and
need validation against real users and camera setups, not a guarantee of pose
or posture accuracy.

`PoseTracker` exposes `init()`, `recalibrate()`, `stop()`, `baseline`, and
`isRunning`, plus constructor callbacks:

```js
new PoseTracker(video, canvas, {
  onCalibrationComplete(baselineData) { /* baseline saved */ },
  onStatusChange(statusText) { /* display status */ },
  onPoseUpdate(landmarks, baseline, frame) {
    if (!landmarks) {
      // Invalidate action/velocity history. Missing input is NOT a body state.
      return;
    }
    // Required landmarks are visible (>= 0.65) and filtered with a light EMA.
    // Non-required invisible landmarks may be null; preserve landmark indices.
    // frame contains timestamp (capture ms), aspectRatio and worldLandmarks.
  }
});
```

`main.js` relays these callbacks as Phaser `game.events` events `pose:calibrated`
and `pose:update`, and stores `poseBaseline`, `poseLandmarks`, and
`poseTrackingValid` in the game registry. It now feeds `GestureClassifier` and
relays `gesture:action` and `gesture:metrics`. The scene jumps once on `JUMP`,
ducks on `DUCK_START`, and returns upright on `DUCK_END`. The duck collision
body changes height with the visual rectangle and keeps its feet anchored.

## Gesture classification and metrics

`GestureClassifier.update(landmarks, baseline, timestampMs, frame)` consumes
monotonic capture timestamps. Constructor callbacks are `onActionTrigger(action)`
and `onMetricsUpdate(metrics)`. `reset(baseline)` starts fresh calibration history;
`invalidate(reason)` discards incomplete measurements and requires recovery.

| State | Trigger / behavior |
| --- | --- |
| NEUTRAL | Arm after 120 ms of stable, grounded standing. A jump needs all four heel/toe markers raised over 0.08 torso heights plus hip upward velocity over 0.6 torso heights/s for 35 ms. Duck needs hip drop over 0.15 torso heights, average knee flexion over 40°, both feet grounded, sustained for 120 ms. |
| JUMPING | Ignore further action triggers. Contact by either heel/toe can establish landing after at least 100 ms of flight; require 30 ms of sustained contact and no substantial upward hip velocity. Save first-contact time, flight estimate and peak hip rise. |
| LANDING_COOLDOWN | Block actions for at least 250 ms after confirmed landing AND until stable neutral returns. A prolonged landing knee bend cannot become a duck. |
| DUCKING | Hold duck until hips return within 0.05 torso heights of baseline for 80 ms. Count a bottom pause only near the deepest observed position with near-zero vertical velocity. |

Thresholds can be overridden via the constructor's `thresholds` object. See
`DEFAULTS` in the classifier for all values. Distances use calibrated torso height;
velocity uses torso heights per second, with time-aware smoothing. Ground-contact
tolerance is 0.06 torso heights around the calibrated average foot Y.

Missing/low-confidence required landmarks, invalid geometry, frame gaps over
200 ms or flights longer than 2 s discard incomplete measurements. Tracking loss
during a duck emits one `DUCK_END` to release the player safely; this is a
cancellation, not a successful repetition. Reacquiring a crouched/airborne person
cannot trigger a new action until they stand neutrally again. Active ducks remain
exclusive: leaving the ground during a duck cancels it; return to standing before
the next jump. This conservative rule can miss jumps with a long, deep preparatory
crouch. No update emits simultaneous jump and duck actions.

| Payload field | Meaning / units |
| --- | --- |
| flightTime | Last completed flight, seconds; null until landing. |
| jumpHeight | `9.81 * flightTime² / 8`, meters; estimated, not a direct height measurement. |
| verticalDisplacement | Peak image hip rise above calibration, fraction of image height (not meters). |
| kneeFlexion / hipFlexion | Bilateral average in degrees; straight neutral = 0°. |
| torsoLean | 2D torso inclination from image up, degrees; assumes a level camera. |
| stanceWidthRatio | Image-plane ankle distance divided by calibrated image shoulder width. |
| squatDepth | Requested angle-band classification, or Standing/Transition. |
| pauseDuration | Time at the deepest stable duck position, seconds; pauses at shallower positions are discarded when moving appreciably deeper. |
| valid / reason | Whether current pose geometry is usable and, if not, why. Invalid observations clear displayed measurements. |
| state / armed / angleSource | FSM state, readiness after recovery, and world-3d or image-3d-estimate. |

Joint angles prefer filtered MediaPipe world landmarks. When world landmarks are
absent, normalized image XYZ is converted to a common scale using image aspect
ratio and marked `image-3d-estimate`. Provided world landmarks with low visibility
are rejected instead of silently replaced. Hip-relative world positions cannot
measure global jump translation; all ground/hip movement uses image coordinates.
The three-point hip angle is an unsigned thigh-to-torso proxy and does not isolate
sagittal flexion, extension or abduction. Single-camera occlusion/orientation and
model depth error affect joint-angle accuracy.

The requested squat labels use these inclusive bands: quarter (hip/knee 40–60°),
half (70–90°), parallel (hip 90–100°, knee 90–110°, or hips within 0.02 image height
of knee level while both flexions are at least 40°), deep/full (hip 110–130°, knee
120–150°). Deep takes priority over parallel, then half, then quarter. Gaps and
conflicting ranges stay Transition. These are task-specific heuristics, not a
universal physiotherapy grading protocol.

Flight timing is estimated from landmark thresholds at camera frame resolution.
Using the first qualifying takeoff/contact frames removes debounce duration from
the reported flight, but EMA lag, camera sampling and contact thresholds still
introduce error. The ballistic formula also assumes the same center-of-mass height
at takeoff and landing; changes in posture can bias it. Physical reference testing
is necessary before making accuracy claims.

Coordinate and measurement references:
- [MediaPipe Pose output coordinate definitions](https://chuoling.github.io/mediapipe/solutions/pose.html#output)
- [Error in jump height estimation using the flight time method](https://pmc.ncbi.nlm.nih.gov/articles/PMC11368081/)

## Runtime and checks

- Use HTTPS or localhost. Camera permission and WASM/WebGL support are required.
- MediaPipe inference runs in the browser. Version-pinned model/WASM assets are
  downloaded from jsDelivr; webcam frames are not uploaded. The initial load
  therefore requires network access. For self-hosted assets, provide
  `assetBaseUrl` pointing to files from the pinned `@mediapipe/pose` package.
- `camera_utils` is pinned to its published `0.3.1675466862` version. Its metadata
  scheduling hook is replaced by a cancellable, sequential frame loop because
  the package's built-in loop does not cancel its RAF chain on stop.
- `npm test` covers analytic geometry, requested depth bands, synthetic jump/duck
  sequences sampled at 30/60 FPS, landing recovery, tracking loss, calibration,
  filtering, rendering calls, mocked camera lifecycle and game/DOM integration.
- `npm run build` verifies the Vite production bundle.
- Physical-webcam performance, real-person calibration reliability and MediaPipe
  WASM/WebGL inference still need testing on the target machine. No FPS or
  real-world accuracy result is claimed by these automated tests.

### Optional real-browser gameplay checks

The browser suite exercises actual Phaser collision bodies, hurdle jumping,
barrier ducking, restoration, invulnerability timing, tracking pauses, score
persistence, keyboard/pointer/DOM restart controls and scene cleanup. It also
simulates five minutes of gameplay and 40 restarts to check pool/listener counts.
It uses synthetic controller readiness and scripted movement, not a real webcam.

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

The suite starts its own Vite server on port 3099 and writes screenshots to a
temporary directory. `PLAYWRIGHT_MODULE`, `RUNNER_CHROMIUM_EXECUTABLE`, and
`RUNNER_SCREENSHOT_DIR` can override the tooling/browser/output paths for CI.
The gameplay suite passed on Chromium 153 with no browser JavaScript errors;
85 unit/integration tests and the production build also passed.
