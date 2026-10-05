import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const app = vi.hoisted(() => ({ tracker: null, game: null, scene: null }));
vi.mock('phaser', () => ({ default: {
  AUTO: 0, Scene: class {},
  Game: class {
    constructor() {
      this.registry = new Map();
      const listeners = new Map();
      this.events = {
        on: vi.fn((name, callback) => listeners.set(name, callback)),
        off: vi.fn((name) => listeners.delete(name)),
        emit: vi.fn((name, payload) => listeners.get(name)?.(payload))
      };
      this.scene = { getScene: vi.fn(() => app.scene) };
      this.destroy = vi.fn();
      app.game = this;
    }
  }
} }));
vi.mock('../src/vision/PoseTracker.js', () => ({ PoseTracker: class {
  constructor(video, canvas, callbacks) { this.callbacks = callbacks; this.baseline = null; app.tracker = this; }
  init() {}
  stop() {}
  recalibrate = vi.fn();
} }));

let elements, now;
function element(id = '') {
  const node = {
    id, textContent: '', style: {}, children: [],
    append(...children) { this.children.push(...children); },
    insertBefore(child) { this.children.push(child); },
    setAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn()
  };
  elements.push(node);
  return node;
}
const baseline = { baselineHipY: 0.45, baselineFootY: 0.87, torsoHeight: 0.25, shoulderWidth: 0.2 };
function points(lift = 0, duck = false) {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, z: 0, visibility: 1 }));
  for (const [left, right, y] of [[11, 12, 0.2], [23, 24, 0.45], [25, 26, 0.65], [27, 28, 0.85], [29, 30, 0.87], [31, 32, 0.87]]) {
    p[left] = { x: 0.4, y: y - lift, z: 0, visibility: 1 };
    p[right] = { x: 0.6, y: y - lift, z: 0, visibility: 1 };
  }
  if (duck) {
    for (const i of [11, 12, 23, 24]) p[i].y += 0.15;
    for (const i of [25, 26]) Object.assign(p[i], { y: 0.72, z: -0.13 });
  }
  return p;
}
function feed(time, p = points()) {
  const frame = { frameId: time + 1, capturedAt: time, timestamp: time, inferenceStartedAt: time + 2,
    inferenceEndedAt: time + 12, captureSource: 'frame-acquisition', aspectRatio: 1 };
  now = time + 12;
  app.tracker.callbacks.onFrameMetrics(frame);
  now = time + 16;
  app.tracker.callbacks.onPoseUpdate(p, baseline, frame);
}
const text = (id) => document.getElementById(id).textContent;

beforeEach(async () => {
  vi.useFakeTimers();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.resetModules();
  elements = [];
  for (const id of ['webcam', 'pose-canvas', 'state-val', 'analytics-panel', 'flight-time', 'jump-height', 'squat-depth', 'knee-angle']) element(id);
  vi.stubGlobal('document', {
    createElement: () => element(), hidden: false,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    querySelector: (selector) => elements.find((node) => node.id === selector.slice(1)),
    getElementById: (id) => elements.find((node) => node.id === id)
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  app.scene = { player: { body: {} }, jump: vi.fn(() => true), duck: vi.fn(() => true), setControllerStatus: vi.fn(), restartGame: vi.fn() };
  await import('../src/main.js');
  app.tracker.callbacks.onCalibrationComplete(baseline);
  app.tracker.baseline = baseline;
  app.tracker.callbacks.onStatusChange('Tracking — calibrated');
  app.tracker.callbacks.onStreamStateChange({ active: true, settings: { width: 640, height: 480, frameRate: 30 } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const buttonClick = (label) => elements.find((node) => node.textContent === label)
  .addEventListener.mock.calls.find(([event]) => event === 'click')[1];

it('stops capture for keyboard testing and rejects late pose/telemetry callbacks', async () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  app.tracker.isRunning = true;
  app.tracker.stop = vi.fn(async () => { app.tracker.isRunning = false; });
  await buttonClick('Keyboard test mode')();
  expect(app.tracker.stop).toHaveBeenCalledOnce();
  expect(app.game.registry.get('controlMode')).toBe('keyboard');
  expect(app.game.registry.get('poseTrackingValid')).toBe(false);
  expect(app.scene.restartGame).toHaveBeenCalledOnce();
  expect(elements.find((node) => node.textContent === 'Start camera').disabled).toBe(true);
  app.tracker.callbacks.onStreamStateChange({ active: true });
  app.tracker.callbacks.onCalibrationComplete(baseline);
  app.tracker.callbacks.onStatusChange('Tracking — calibrated');
  for (let t = 220; t <= 1000; t += 20) feed(t, points(0, true));
  expect(app.scene.duck).not.toHaveBeenCalled();
  expect(app.scene.jump).not.toHaveBeenCalled();
  expect(text('state-val')).toContain('KEYBOARD TEST');
  expect(text('knee-angle')).toBe('—');
  expect(text('ankle-bilateral')).toBe('— / —');
  expect(window.performanceMonitor.getSummary()).toMatchObject({ processedFrames: 0, acceptedActions: 0, averageInferenceMs: null, averageActionLatencyMs: null });
  expect(window.actionRecorder.getReport().completedActions).toEqual([]);
});

it('returns from keyboard testing with a disarmed camera controller and cleared calibration', async () => {
  await buttonClick('Keyboard test mode')();
  app.game.events.emit('runner:restartRequested', { recalibrate: true });
  expect(app.tracker.recalibrate).not.toHaveBeenCalled();
  await buttonClick('Use camera controls')();
  expect(app.game.registry.get('controlMode')).toBe('camera');
  expect(app.game.registry.get('poseBaseline')).toBeNull();
  expect(app.game.registry.get('poseTrackingValid')).toBe(false);
  expect(window.gestureClassifier.metrics).toMatchObject({ armed: false, valid: false });
  expect(app.scene.setControllerStatus).toHaveBeenLastCalledWith(false, false, expect.any(String));
  expect(elements.find((node) => node.textContent === 'Start camera').disabled).toBe(false);
  expect(text('state-val')).toContain('Start camera');
});

it('serializes keyboard mode changes while camera cleanup is pending', async () => {
  let finish;
  app.tracker.stop = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const click = buttonClick('Keyboard test mode');
  const pending = click();
  expect(elements.find((node) => node.textContent === 'Use camera controls').disabled).toBe(true);
  await click();
  expect(app.tracker.stop).toHaveBeenCalledOnce();
  expect(app.game.registry.get('controlMode')).toBe('camera');
  finish();
  await pending;
  expect(app.game.registry.get('controlMode')).toBe('keyboard');
  expect(app.scene.restartGame).toHaveBeenCalledOnce();
});

it('lets the user cancel pending camera startup and immediately retry', async () => {
  const button = elements.find((node) => node.textContent === 'Start camera');
  const click = button.addEventListener.mock.calls.find(([name]) => name === 'click')[1];
  let finish;
  app.tracker.init = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  app.tracker.stop = vi.fn(async () => { app.tracker.isRunning = false; finish(); });
  const pending = click();
  expect(button.textContent).toBe('Cancel camera startup');
  expect(button.disabled).toBe(false);
  await click();
  await pending;
  expect(app.tracker.init).toHaveBeenCalledOnce();
  expect(app.tracker.stop).toHaveBeenCalledOnce();
  expect(button.textContent).toBe('Start camera');
  app.tracker.init.mockResolvedValueOnce();
  await click();
  expect(app.tracker.init).toHaveBeenCalledTimes(2);
});

it('connects real classification to Phaser jump and all dashboard measurements', () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 720; t += 20) feed(t, points(0.14 * Math.sin(Math.PI * (t - 220) / 500)));
  for (let t = 740; t <= 800; t += 20) feed(t);
  expect(app.scene.jump).toHaveBeenCalledOnce();
  expect(app.scene.duck).not.toHaveBeenCalled();
  expect(text('state-val')).toBe('LANDING_COOLDOWN');
  expect(Number(text('flight-time'))).toBeGreaterThan(0.4);
  expect(Number(text('jump-height'))).toBeGreaterThan(0);
  expect(Number(text('vertical-displacement'))).toBeCloseTo(0.14, 2);
  expect(text('knee-angle')).toBe('0.0');
  expect(text('hip-angle')).toBe('0.0');
  expect(text('torso-lean')).toBe('0.0');
  expect(text('stance-width')).toBe('1.00');
  expect(app.game.registry.get('gestureState')).toBe('LANDING_COOLDOWN');
  expect(app.game.registry.get('poseTrackingValid')).toBe(true);
});

it('renders bilateral angles, unavailable ankle geometry and completed per-phase history', () => {
  for (let t = 0; t <= 1400; t += 20) feed(t, points(t >= 220 && t <= 720 ? .14 * Math.sin(Math.PI * (t - 220) / 500) : 0));
  expect(text('knee-bilateral')).toBe('0.0 / 0.0');
  expect(text('ankle-bilateral')).toBe('— / —'); // Coincident heel/toe fixture is not a real neutral ankle.
  expect(text('last-action-summary')).toContain('completed jump');
  expect(window.actionRecorder.getLast().phases.LANDING).toBeTruthy();
  feed(1420, null);
  expect(text('hip-bilateral')).toBe('— / —');
  expect(text('knee-bilateral')).toBe('— / —');
  expect(text('movement-phase')).toBe('Phase: —');
});

it('holds duck, releases it on missing input, clears metrics, and preserves calibration messages', () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 1000; t += 20) feed(t, points(0, true));
  expect(app.scene.duck.mock.calls).toEqual([[true]]);
  expect(app.scene.desiredDuckState).toBe(true);
  expect(Number(text('pause-duration'))).toBeGreaterThan(0.2);
  feed(1020, null);
  expect(app.scene.duck.mock.calls).toEqual([[true], [false]]);
  expect(app.scene.desiredDuckState).toBe(false);
  expect(text('knee-angle')).toBe('—');
  expect(text('pause-duration')).toBe('—');
  expect(app.scene.jump).not.toHaveBeenCalled();
  expect(app.game.registry.get('poseTrackingValid')).toBe(false);
  app.tracker.callbacks.onPoseUpdate(null, null);
  app.tracker.callbacks.onStatusChange('Calibrating — hold still: 3s');
  expect(text('state-val')).toBe('Calibrating — hold still: 3s');
});

it.each([23, 24, 25, 26, 27, 28, 29, 30, 31, 32])('clears all analytics when lower-body landmark %i falls below 0.65', (index) => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 720; t += 20) feed(t, points(0.14 * Math.sin(Math.PI * (t - 220) / 500)));
  for (let t = 740; t <= 800; t += 20) feed(t);
  expect(Number(text('jump-height'))).toBeGreaterThan(0); // A stale previous value must be cleared too.
  const unreliable = points();
  unreliable[index].visibility = 0.649;
  feed(820, unreliable);
  for (const id of ['flight-time', 'jump-height', 'vertical-displacement', 'knee-angle', 'hip-angle',
    'torso-lean', 'stance-width', 'pause-duration', 'squat-depth', 'hips-at-knee-level']) {
    expect(text(id)).toBe('—');
  }
  expect(text('state-val')).toContain('below 0.65 visibility');
  const metrics = app.game.registry.get('gestureMetrics');
  expect(metrics).toMatchObject({ valid: false, armed: false, kneeFlexion: null, jumpHeight: null, flightTime: null });
  expect(app.game.registry.get('poseTrackingValid')).toBe(false);
  expect(app.scene.desiredDuckState).toBe(false);
  expect(app.scene.setControllerStatus).toHaveBeenLastCalledWith(false, false, expect.any(String));
  for (let t = 840; t <= 1600; t += 20) feed(t);
  expect(text('knee-angle')).toBe('0.0'); // Zero is legitimate for reliable standing geometry.
  expect(text('jump-height')).toBe('—'); // Lost flight history must not reappear.
  expect(app.scene.jump).toHaveBeenCalledOnce();
});

it('synchronizes held duck on every pose even after a rejected airborne command', () => {
  app.scene.duck.mockReturnValue(false);
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 500; t += 20) feed(t, points(0, true));
  expect(app.scene.duck.mock.calls).toEqual([[true]]);
  expect(app.scene.desiredDuckState).toBe(true);
  app.scene.desiredDuckState = false;
  feed(520, points(0, true));
  expect(app.scene.desiredDuckState).toBe(true);
  expect(app.scene.duck).toHaveBeenCalledOnce();
  for (let t = 540; t <= 1100; t += 20) feed(t);
  expect(app.scene.desiredDuckState).toBe(false);
  expect(text('squat-depth')).toBe('Standing');
  expect(text('hips-at-knee-level')).toBe('No');
});

it('uses verified calibration history to arm immediately and restart still disarms', () => {
  const calibrated = { ...baseline, baselineLeftHeelY: 0.84, baselineRightHeelY: 0.84,
    baselineLeftToeY: 0.90, baselineRightToeY: 0.90 };
  const samples = [2800, 2850, 2900, 2950, 3000].map((timestamp) => {
    const landmarks = points();
    landmarks[29].y = landmarks[30].y = 0.84;
    landmarks[31].y = landmarks[32].y = 0.90;
    return { landmarks, frame: { timestamp, aspectRatio: 1 } };
  });
  app.tracker.callbacks.onCalibrationComplete(calibrated, samples);
  expect(window.gestureClassifier.metrics).toMatchObject({ armed: true, state: 'NEUTRAL', valid: true });
  expect(app.scene.setControllerStatus).toHaveBeenLastCalledWith(true, true, null);
  app.game.events.emit('runner:restartRequested', { recalibrate: false });
  expect(window.gestureClassifier.metrics.armed).toBe(false);
  expect(app.scene.desiredDuckState).toBe(false);
});

it('does not queue actions if the game scene is not ready', () => {
  app.scene = null;
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 720; t += 20) feed(t, points(0.14 * Math.sin(Math.PI * (t - 220) / 500)));
  expect(app.game.events.emit.mock.calls.filter(([name]) => name === 'gesture:action')).toHaveLength(0);
});

it('disarms the controller on restart, and requests recalibration only when selected', () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  expect(window.gestureClassifier.metrics.armed).toBe(true);
  app.game.events.emit('runner:restartRequested', { recalibrate: false });
  expect(window.gestureClassifier.metrics.armed).toBe(false);
  expect(app.tracker.recalibrate).not.toHaveBeenCalled();
  expect(app.scene.setControllerStatus).toHaveBeenLastCalledWith(false, false, 'Awaiting stable neutral pose');
  app.game.events.emit('runner:restartRequested', { recalibrate: true });
  expect(app.tracker.recalibrate).toHaveBeenCalledOnce();
  expect(app.game.registry.get('poseTrackingValid')).toBe(false);
});

it('updates the performance HUD and measures accepted actions using their triggering frame', () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 720; t += 20) feed(t, points(0.14 * Math.sin(Math.PI * (t - 220) / 500)));
  vi.advanceTimersByTime(250);
  expect(text('inference-latency')).toBe('10.0 ms');
  expect(text('action-latency')).toBe('16.0 ms (JUMP)');
  expect(Number(text('camera-fps'))).toBeGreaterThan(0);
  expect(text('timing-source')).toContain('estimate');
  expect(window.performanceMonitor.getSummary()).toMatchObject({ acceptedActions: 1, averageActionLatencyMs: 16 });
});

it('excludes rejected game commands, safety duck releases and out-of-frame calls from action latency', () => {
  app.scene.duck.mockReturnValue(false);
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 500; t += 20) feed(t, points(0, true));
  expect(window.performanceMonitor.getSummary().acceptedActions).toBe(0);
  app.scene.duck.mockReturnValue(true);
  feed(520, null);
  expect(app.scene.duck).toHaveBeenLastCalledWith(false);
  expect(window.performanceMonitor.getSummary().acceptedActions).toBe(0);
});

it('counts duck start/end from real pose transitions, but not a reset release', () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 500; t += 20) feed(t, points(0, true));
  for (let t = 520; t <= 1100; t += 20) feed(t);
  expect(window.performanceMonitor.getSummary().actions).toEqual({ JUMP: 0, DUCK_START: 1, DUCK_END: 1 });
  for (let t = 1120; t <= 1400; t += 20) feed(t, points(0, true));
  app.game.events.emit('runner:restartRequested', { recalibrate: false });
  expect(window.performanceMonitor.getSummary().actions.DUCK_END).toBe(1);
});

it('pauses the profiler on visibility change/stop and exposes working summary/reset controls', () => {
  feed(0);
  const change = document.addEventListener.mock.calls.find(([name]) => name === 'visibilitychange')[1];
  now = 100;
  document.hidden = true;
  change();
  expect(text('camera-fps')).toBe('0.0');
  expect(text('inference-latency')).toBe('—');
  now = 1100;
  document.hidden = false;
  change();
  expect(window.performanceMonitor.getSummary().activeSeconds).toBe(0.1);
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const click = (name) => elements.find((node) => node.textContent === name).addEventListener.mock.calls[0][1]();
  click('Log performance summary');
  expect(log).toHaveBeenCalledOnce();
  click('Reset sample');
  expect(window.performanceMonitor.getSummary().processedFrames).toBe(0);
  app.tracker.callbacks.onStreamStateChange({ active: false });
  expect(text('timing-source')).toContain('stopped');
});
