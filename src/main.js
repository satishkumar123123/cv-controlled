import './style.css';
import Phaser from 'phaser';
import { GameScene } from './game/GameScene.js';
import { PoseTracker } from './vision/PoseTracker.js';
import { GestureClassifier } from './vision/GestureClassifier.js';

const config = {
  type: Phaser.AUTO,
  width: 640,
  height: 480,
  parent: 'game-container',
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 1200 }, debug: false }
  },
  scene: [GameScene]
};

const game = new Phaser.Game(config);
window.game = game;

const video = document.querySelector('#webcam');
const canvas = document.querySelector('#pose-canvas');
const state = document.querySelector('#state-val');
const panel = document.querySelector('#analytics-panel');
if (!video || !canvas || !state || !panel) {
  throw new Error('Missing webcam, pose-canvas, state-val or analytics-panel element.');
}

// Create controls here so the existing index.html remains compatible.
const controls = document.createElement('div');
controls.id = 'camera-controls';
controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
const startButton = document.createElement('button');
startButton.type = 'button';
startButton.textContent = 'Start camera';
const calibrateButton = document.createElement('button');
calibrateButton.type = 'button';
calibrateButton.textContent = 'Recalibrate';
calibrateButton.disabled = true;
for (const button of [startButton, calibrateButton]) {
  button.style.cssText = 'padding:8px 10px;border-radius:4px;cursor:pointer';
  controls.append(button);
}
panel.append(controls);
state.setAttribute('role', 'status');
state.setAttribute('aria-live', 'polite');
state.textContent = 'Click Start camera, then stand fully in view.';
// The canvas draws the camera image and skeleton together, mirrored by CSS.
video.style.visibility = 'hidden';

// Add the remaining metrics without requiring edits to the existing HTML.
const addedMetricRows = [];
for (const [id, label, unit] of [
  ['hip-angle', 'Hip Flexion', '°'], ['torso-lean', 'Torso Lean', '°'],
  ['stance-width', 'Stance / Shoulder Width', ''],
  ['vertical-displacement', 'Peak Hip Rise', ' frame height'],
  ['pause-duration', 'Bottom Pause', ' s']
]) {
  if (document.getElementById(id)) continue;
  const row = document.createElement('p');
  const value = document.createElement('span');
  value.id = id;
  value.textContent = '—';
  row.append(`${label}: `, value, unit);
  panel.insertBefore(row, controls);
  addedMetricRows.push(row);
}
const metricFields = [
  ['flight-time', 'flightTime', 3], ['jump-height', 'jumpHeight', 3],
  ['vertical-displacement', 'verticalDisplacement', 3], ['knee-angle', 'kneeFlexion', 1],
  ['hip-angle', 'hipFlexion', 1], ['torso-lean', 'torsoLean', 1],
  ['stance-width', 'stanceWidthRatio', 2], ['pause-duration', 'pauseDuration', 2]
].map(([id, key, digits]) => ({ element: document.getElementById(id), key, digits }));
const squatDepth = document.querySelector('#squat-depth');
let visionStatus = state.textContent;
const classifier = new GestureClassifier({
  onActionTrigger(action) {
    const scene = game.scene.getScene('GameScene');
    // Do not queue physical actions until Phaser has created its player body.
    if (!scene?.player?.body) return;
    if (action === 'JUMP') scene.jump();
    else if (action === 'DUCK_START') scene.duck(true);
    else if (action === 'DUCK_END') scene.duck(false);
    game.events.emit('gesture:action', action);
  },
  onMetricsUpdate(metrics) {
    state.textContent = metrics.valid
      ? `${metrics.state}${metrics.state === 'NEUTRAL' && !metrics.armed ? ' — stand still to rearm' : ''}`
      : visionStatus === 'Tracking — calibrated' ? metrics.reason ?? 'Waiting for valid pose' : visionStatus;
    for (const { element, key, digits } of metricFields) {
      if (element) element.textContent = metrics.valid && Number.isFinite(metrics[key]) ? metrics[key].toFixed(digits) : '—';
    }
    if (squatDepth) squatDepth.textContent = metrics.valid ? metrics.squatDepth ?? '—' : '—';
    game.registry.set('gestureMetrics', metrics);
    game.registry.set('gestureState', metrics.state);
    game.events.emit('gesture:metrics', metrics);
  }
});
window.gestureClassifier = classifier;

let starting = false;
let disposed = false;
const tracker = new PoseTracker(video, canvas, {
  onStatusChange(statusText) {
    visionStatus = statusText;
    if (statusText !== 'Tracking — calibrated' || !classifier.metrics?.valid) state.textContent = statusText;
    updateControls();
  },
  onCalibrationComplete(baselineData) {
    classifier.reset(baselineData);
    game.registry.set('poseBaseline', baselineData);
    game.events.emit('pose:calibrated', baselineData);
  },
  onPoseUpdate(landmarks, baseline, frame = {}) {
    // Invalid input cancels incomplete measurements and releases active duck.
    game.registry.set('poseLandmarks', landmarks);
    game.registry.set('poseBaseline', baseline);
    game.registry.set('poseTrackingValid', landmarks !== null && baseline !== null);
    game.events.emit('pose:update', landmarks, baseline);
    if (!landmarks) {
      if (!baseline) classifier.reset();
      else classifier.invalidate();
    } else {
      classifier.update(landmarks, baseline, frame.timestamp ?? performance.now(), frame);
    }
  }
});
window.poseTracker = tracker;
game.registry.set('poseTrackingValid', false);
game.registry.set('poseLandmarks', null);
game.registry.set('poseBaseline', null);

function updateControls() {
  startButton.disabled = starting;
  startButton.textContent = starting ? 'Please wait…' : tracker.isRunning ? 'Stop camera' : 'Start camera';
  calibrateButton.disabled = starting || !tracker.isRunning;
}

async function startCamera() {
  if (starting || disposed) return;
  starting = true;
  updateControls();
  try {
    if (tracker.isRunning) await tracker.stop();
    else await tracker.init();
  } catch (error) {
    // PoseTracker has already shown a permission/runtime error in #state-val.
    console.error('PoseTracker startup failed:', error);
  } finally {
    starting = false;
    if (!disposed) updateControls();
  }
}

function recalibrate() {
  game.registry.set('poseBaseline', null);
  game.registry.set('poseLandmarks', null);
  game.registry.set('poseTrackingValid', false);
  tracker.recalibrate();
}

startButton.addEventListener('click', startCamera);
calibrateButton.addEventListener('click', recalibrate);
const onPageHide = () => { void tracker.stop(); };
window.addEventListener('pagehide', onPageHide);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    startButton.removeEventListener('click', startCamera);
    calibrateButton.removeEventListener('click', recalibrate);
    window.removeEventListener('pagehide', onPageHide);
    void tracker.stop();
    classifier.reset();
    for (const row of addedMetricRows) row.remove();
    controls.remove();
    game.destroy(true);
    if (window.game === game) delete window.game;
    if (window.poseTracker === tracker) delete window.poseTracker;
    if (window.gestureClassifier === classifier) delete window.gestureClassifier;
  });
}
