# CV-Controlled Endless Runner

A webcam pose-estimation controlled 2D endless runner built with Phaser 3 and MediaPipe.

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
  onPoseUpdate(landmarks, baseline) {
    if (!landmarks) {
      // Invalidate action/velocity history. Missing input is NOT a body state.
      return;
    }
    // Required landmarks are visible (>= 0.65) and filtered with a light EMA.
    // Non-required invisible landmarks may be null; preserve landmark indices.
  }
});
```

`main.js` relays these callbacks as Phaser `game.events` events `pose:calibrated`
and `pose:update`, and stores `poseBaseline`, `poseLandmarks`, and
`poseTrackingValid` in the game registry. Jump/duck classification is a separate
next step; calibration and tracking loss never invoke game actions.

## Runtime and checks

- Use HTTPS or localhost. Camera permission and WASM/WebGL support are required.
- MediaPipe inference runs in the browser. Version-pinned model/WASM assets are
  downloaded from jsDelivr; webcam frames are not uploaded. The initial load
  therefore requires network access. For self-hosted assets, provide
  `assetBaseUrl` pointing to files from the pinned `@mediapipe/pose` package.
- `camera_utils` is pinned to its published `0.3.1675466862` version. Its metadata
  scheduling hook is replaced by a cancellable, sequential frame loop because
  the package's built-in loop does not cancel its RAF chain on stop.
- `npm test` covers synthetic pose sequences, calibration, visibility loss,
  filtering, rendering calls, and mocked camera/runtime lifecycle errors.
- `npm run build` verifies the Vite production bundle.
- Physical-webcam performance, real-person calibration reliability and browser
  WASM/WebGL execution still need testing on the target machine. No FPS or
  real-world accuracy result is claimed by these automated tests.
