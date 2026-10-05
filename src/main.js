import './style.css';
import Phaser from 'phaser';
import { GameScene } from './game/GameScene.js';
import { PoseTracker } from './vision/PoseTracker.js';
import { GestureClassifier } from './vision/GestureClassifier.js';
import { PerformanceMonitor } from './analytics/PerformanceMonitor.js';
import { ActionRecorder } from './analytics/ActionRecorder.js';
import { createActionAnalytics } from './ui/ActionAnalytics.js';
import { createSessionReport, downloadSessionReport } from './analytics/SessionReport.js';

const config = {
  type: Phaser.AUTO,
  width: 640,
  height: 480,
  parent: 'game-container',
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 1400 }, debug: false }
  },
  scene: [GameScene]
};

const game = new Phaser.Game(config);
window.game = game;
game.registry.set('controlMode', 'camera');

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
calibrateButton.textContent = 'Recalibrate / Restart';
calibrateButton.disabled = true;
const restartButton = document.createElement('button');
restartButton.type = 'button';
restartButton.textContent = 'Restart run';
const modeButton = document.createElement('button');
modeButton.type = 'button';
modeButton.textContent = 'Keyboard test mode';
modeButton.setAttribute('aria-pressed', 'false');
for (const button of [startButton, calibrateButton, restartButton, modeButton]) {
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
  ['pause-duration', 'Bottom Pause', ' s'], ['hips-at-knee-level', 'Hips at Knee Level (image)', '']
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
const hipsAtKneeLevel = document.getElementById('hips-at-knee-level');
const performanceMonitor = new PerformanceMonitor();
const actionRecorder = new ActionRecorder();
const actionAnalytics = createActionAnalytics(panel, actionRecorder);
window.actionRecorder = actionRecorder;
window.performanceMonitor = performanceMonitor;
const performanceHUD = document.createElement('section');
performanceHUD.id = 'performance-hud';
performanceHUD.setAttribute('aria-label', 'Live pipeline performance');
const performanceTitle = document.createElement('h4');
performanceTitle.textContent = 'Live performance';
performanceHUD.append(performanceTitle);
const performanceFields = {};
for (const [id, label] of [
  ['camera-fps', 'Processing FPS'], ['inference-latency', 'Inference (rolling avg)'],
  ['action-latency', 'Last accepted action']
]) {
  const row = document.createElement('p');
  const value = document.createElement('span');
  value.id = id;
  value.textContent = '—';
  row.append(`${label}: `, value);
  performanceHUD.append(row);
  performanceFields[id] = value;
}
const timingNote = document.createElement('small');
timingNote.id = 'timing-source';
performanceHUD.append(timingNote);
const logPerformanceButton = document.createElement('button');
logPerformanceButton.type = 'button';
logPerformanceButton.textContent = 'Log performance summary';
const resetPerformanceButton = document.createElement('button');
resetPerformanceButton.type = 'button';
resetPerformanceButton.textContent = 'Reset sample';
performanceHUD.append(logPerformanceButton, resetPerformanceButton);
const hardwareNotes = document.createElement('input');
hardwareNotes.id = 'hardware-notes';
hardwareNotes.type = 'text';
hardwareNotes.maxLength = 1000;
hardwareNotes.placeholder = 'CPU / GPU / RAM / OS / webcam / participant code';
hardwareNotes.setAttribute('aria-label', 'Hardware and test session notes');
const exportButton = document.createElement('button');
exportButton.type = 'button';
exportButton.textContent = 'Export session JSON';
const exportSession = () => downloadSessionReport(createSessionReport(performanceMonitor, actionRecorder, hardwareNotes.value ?? ''));
exportButton.addEventListener('click', exportSession);
performanceHUD.append(hardwareNotes, exportButton);
panel.append(performanceHUD);

function renderPerformance() {
  const metrics = performanceMonitor.getLiveMetrics();
  performanceFields['camera-fps'].textContent = metrics.cameraFps.toFixed(1);
  performanceFields['inference-latency'].textContent = metrics.inferenceMs === null ? '—' : `${metrics.inferenceMs.toFixed(1)} ms`;
  performanceFields['action-latency'].textContent = metrics.actionLatencyMs === null ? '—'
    : `${metrics.actionLatencyMs.toFixed(1)} ms (${metrics.lastAction})`;
  timingNote.textContent = !metrics.active ? 'Camera stopped / paused.'
    : metrics.captureSource === 'camera-capture' ? 'Camera capture → game state. Last action only.'
      : 'Browser frame → game state estimate; sensor delay unavailable.';
}
const logPerformance = () => performanceMonitor.logSummary(hardwareNotes.value ?? '');
const resetPerformance = () => { performanceMonitor.reset(); renderPerformance(); };
logPerformanceButton.addEventListener('click', logPerformance);
resetPerformanceButton.addEventListener('click', resetPerformance);
// Throttle HUD work; the profiler timestamps every processed frame independently.
const performanceTimer = setInterval(renderPerformance, 250);
renderPerformance();
let activeFrame = null;
let streamActive = false;
let visionStatus = state.textContent;
let keyboardMode = false;
let changingMode = false;
const KEYBOARD_STATUS = 'KEYBOARD TEST — Space: jump • hold Down: duck • R: restart • pose metrics unavailable';
const classifier = new GestureClassifier({
  onActionTrigger(action, context = {}) {
    if (keyboardMode) return;
    const scene = game.scene.getScene('GameScene');
    // Do not queue physical actions until Phaser has created its player body.
    if (!scene?.player?.body) return;
    let accepted = false;
    if (action === 'JUMP') accepted = scene.jump();
    else if (action === 'DUCK_START') accepted = scene.duck(true);
    else if (action === 'DUCK_END') accepted = scene.duck(false);
    // Phaser commands mutate body/state synchronously. Exclude rejected commands,
    // reset/recovery releases, and calls without a matched camera inference frame.
    if (accepted === true && context.source === 'pose' && activeFrame) {
      performanceMonitor.recordAction(action, activeFrame, performance.now());
    }
    game.events.emit('gesture:action', action);
  },
  onMetricsUpdate(metrics) {
    if (keyboardMode && metrics.valid) return;
    actionRecorder.update(metrics);
    actionAnalytics.render(metrics);
    state.textContent = keyboardMode ? KEYBOARD_STATUS : metrics.valid
      ? `${metrics.state}${metrics.state === 'NEUTRAL' && !metrics.armed ? ' — stand still to rearm' : ''}`
      : visionStatus === 'Tracking — calibrated' ? metrics.reason ?? 'Waiting for valid pose' : visionStatus;
    for (const { element, key, digits } of metricFields) {
      if (element) element.textContent = metrics.valid && Number.isFinite(metrics[key]) ? metrics[key].toFixed(digits) : '—';
    }
    if (squatDepth) squatDepth.textContent = metrics.valid ? metrics.depthCategory ?? '—' : '—';
    if (hipsAtKneeLevel) hipsAtKneeLevel.textContent = metrics.valid && typeof metrics.isHipsAtKneeLevel === 'boolean'
      ? metrics.isHipsAtKneeLevel ? 'Yes' : 'No' : '—';
    game.registry.set('gestureMetrics', metrics);
    game.registry.set('gestureState', metrics.state);
    game.registry.set('poseTrackingValid', metrics.valid);
    const scene = game.scene.getScene('GameScene');
    // Actions are edges; ducking is held state. Keep intent synchronized even if
    // DUCK_START was rejected while the virtual player was still in the air.
    if (!keyboardMode) {
      if (scene) scene.desiredDuckState = metrics.valid && metrics.state === 'DUCKING';
      scene?.setControllerStatus?.(
        metrics.valid, metrics.state === 'NEUTRAL' && metrics.armed, metrics.reason
      );
    }
    game.events.emit('gesture:metrics', metrics);
  }
});
window.gestureClassifier = classifier;

let starting = false;
let disposed = false;
const tracker = new PoseTracker(video, canvas, {
  assetBaseUrl: '/pose', // Prepared from the pinned npm package; works offline after install.
  onFrameMetrics(frame) { if (!keyboardMode) performanceMonitor.recordInference(frame); },
  onStreamStateChange({ active, settings }) {
    streamActive = active && !keyboardMode;
    if (settings) performanceMonitor.setCameraSettings(settings);
    performanceMonitor.setActive(streamActive && !document.hidden);
    renderPerformance();
  },
  onStatusChange(statusText) {
    visionStatus = statusText;
    if (!keyboardMode && (statusText !== 'Tracking — calibrated' || !classifier.metrics?.valid)) state.textContent = statusText;
    updateControls();
  },
  onCalibrationComplete(baselineData, neutralSamples = []) {
    if (keyboardMode) return;
    classifier.completeCalibration(baselineData, neutralSamples);
    game.registry.set('poseBaseline', baselineData);
    game.events.emit('pose:calibrated', baselineData);
  },
  onPoseUpdate(landmarks, baseline, frame = {}) {
    if (keyboardMode) return;
    // Invalid input cancels incomplete measurements and releases active duck.
    game.registry.set('poseLandmarks', landmarks);
    game.registry.set('poseBaseline', baseline);
    game.registry.set('poseTrackingValid', landmarks !== null && baseline !== null);
    game.events.emit('pose:update', landmarks, baseline);
    if (!landmarks) {
      if (!baseline) classifier.reset();
      else classifier.invalidate();
    } else {
      activeFrame = frame;
      try { classifier.update(landmarks, baseline, frame.timestamp ?? performance.now(), frame); }
      finally { activeFrame = null; }
    }
  }
});
window.poseTracker = tracker;
game.registry.set('poseTrackingValid', false);
game.registry.set('poseLandmarks', null);
game.registry.set('poseBaseline', null);

function updateControls() {
  startButton.disabled = disposed || keyboardMode || changingMode;
  startButton.textContent = starting ? 'Cancel camera startup' : tracker.isRunning ? 'Stop camera' : 'Start camera';
  calibrateButton.disabled = starting || !tracker.isRunning || keyboardMode || changingMode;
  modeButton.disabled = disposed || starting || changingMode;
  modeButton.textContent = keyboardMode ? 'Use camera controls' : 'Keyboard test mode';
  modeButton.setAttribute('aria-pressed', String(keyboardMode));
}

async function startCamera() {
  if (disposed || keyboardMode || changingMode) return;
  if (starting) { await tracker.stop(); return; }
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

async function toggleKeyboardMode() {
  if (disposed || starting || changingMode) return;
  changingMode = true;
  keyboardMode = !keyboardMode;
  updateControls();
  try {
    // Stop capture before starting the test run. Mode guards reject late pose
    // callbacks, so keyboard actions cannot populate movement/latency reports.
    streamActive = false;
    game.scene.getScene('GameScene')?.setControllerStatus?.(false, false, 'Switching controls…');
    performanceMonitor.setActive(false);
    performanceMonitor.reset();
    actionRecorder.reset();
    classifier.reset();
    for (const key of ['poseLandmarks', 'poseBaseline']) game.registry.set(key, null);
    game.registry.set('poseTrackingValid', false);
    if (keyboardMode) await tracker.stop();
    if (disposed) return;
    game.registry.set('controlMode', keyboardMode ? 'keyboard' : 'camera');
    visionStatus = keyboardMode ? KEYBOARD_STATUS : 'Click Start camera, then stand fully in view.';
    state.textContent = visionStatus;
    game.scene.getScene('GameScene')?.restartGame();
    renderPerformance();
    modeButton.blur?.(); // Space now controls the game, not the focused toggle.
  } finally {
    changingMode = false;
    updateControls();
  }
}

function recalibrate() {
  game.registry.set('poseBaseline', null);
  game.registry.set('poseLandmarks', null);
  game.registry.set('poseTrackingValid', false);
  tracker.recalibrate();
}

function onRunnerRestart({ recalibrate: needsCalibration }) {
  // Invalidate gesture history; restarting must never replay a previous action.
  if (keyboardMode) { classifier.reset(); return; }
  classifier.reset(needsCalibration ? null : tracker.baseline);
  if (needsCalibration) recalibrate();
}
function restartRun() { game.scene.getScene('GameScene')?.restartGame(); }
function recalibrateRun() { game.scene.getScene('GameScene')?.restartGame({ recalibrate: true }); }
game.events.on('runner:restartRequested', onRunnerRestart);

startButton.addEventListener('click', startCamera);
calibrateButton.addEventListener('click', recalibrateRun);
restartButton.addEventListener('click', restartRun);
modeButton.addEventListener('click', toggleKeyboardMode);
const onPageHide = () => {
  game.scene.getScene('GameScene')?.saveHighScore();
  void tracker.stop();
};
window.addEventListener('pagehide', onPageHide);
const onVisibilityChange = () => {
  if (keyboardMode && document.hidden) game.scene.getScene('GameScene')?._onBlur?.();
  performanceMonitor.setActive(streamActive && !document.hidden);
  renderPerformance();
};
document.addEventListener('visibilitychange', onVisibilityChange);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    startButton.removeEventListener('click', startCamera);
    calibrateButton.removeEventListener('click', recalibrateRun);
    restartButton.removeEventListener('click', restartRun);
    modeButton.removeEventListener('click', toggleKeyboardMode);
    game.events.off('runner:restartRequested', onRunnerRestart);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    clearInterval(performanceTimer);
    logPerformanceButton.removeEventListener('click', logPerformance);
    resetPerformanceButton.removeEventListener('click', resetPerformance);
    exportButton.removeEventListener('click', exportSession);
    actionAnalytics.destroy();
    void tracker.stop();
    classifier.reset();
    for (const row of addedMetricRows) row.remove();
    controls.remove();
    performanceHUD.remove();
    game.destroy(true);
    if (window.game === game) delete window.game;
    if (window.poseTracker === tracker) delete window.poseTracker;
    if (window.gestureClassifier === classifier) delete window.gestureClassifier;
    if (window.performanceMonitor === performanceMonitor) delete window.performanceMonitor;
    if (window.actionRecorder === actionRecorder) delete window.actionRecorder;
  });
}
