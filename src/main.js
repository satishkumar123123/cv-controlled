import './style.css';
import Phaser from 'phaser';
import { GameScene } from './game/GameScene.js';
import { PoseTracker } from './vision/PoseTracker.js';

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

let starting = false;
let disposed = false;
const tracker = new PoseTracker(video, canvas, {
  onStatusChange(statusText) {
    state.textContent = statusText;
    updateControls();
  },
  onCalibrationComplete(baselineData) {
    game.registry.set('poseBaseline', baselineData);
    game.events.emit('pose:calibrated', baselineData);
  },
  onPoseUpdate(landmarks, baseline) {
    // Null input means tracking loss/recalibration/stop, never a game action.
    // A future movement detector must reset its velocity/action history here.
    game.registry.set('poseLandmarks', landmarks);
    game.registry.set('poseBaseline', baseline);
    game.registry.set('poseTrackingValid', landmarks !== null && baseline !== null);
    game.events.emit('pose:update', landmarks, baseline);
    // Jump/duck classification belongs in a separate detector. Calibration and
    // landmark loss must never call GameScene.jump() or GameScene.duck().
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
    controls.remove();
    game.destroy(true);
    if (window.game === game) delete window.game;
    if (window.poseTracker === tracker) delete window.poseTracker;
  });
}
