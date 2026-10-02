import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const app = vi.hoisted(() => ({ tracker: null, game: null, scene: null }));
vi.mock('phaser', () => ({ default: {
  AUTO: 0, Scene: class {},
  Game: class {
    constructor() {
      this.registry = new Map();
      this.events = { emit: vi.fn() };
      this.scene = { getScene: vi.fn(() => app.scene) };
      this.destroy = vi.fn();
      app.game = this;
    }
  }
} }));
vi.mock('../src/vision/PoseTracker.js', () => ({ PoseTracker: class {
  constructor(video, canvas, callbacks) { this.callbacks = callbacks; app.tracker = this; }
  init() {}
  stop() {}
  recalibrate() {}
} }));

let elements;
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
  app.tracker.callbacks.onPoseUpdate(p, baseline, { timestamp: time, aspectRatio: 1 });
}
const text = (id) => document.getElementById(id).textContent;

beforeEach(async () => {
  vi.resetModules();
  elements = [];
  for (const id of ['webcam', 'pose-canvas', 'state-val', 'analytics-panel', 'flight-time', 'jump-height', 'squat-depth', 'knee-angle']) element(id);
  vi.stubGlobal('document', {
    createElement: () => element(),
    querySelector: (selector) => elements.find((node) => node.id === selector.slice(1)),
    getElementById: (id) => elements.find((node) => node.id === id)
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  app.scene = { player: { body: {} }, jump: vi.fn(), duck: vi.fn() };
  await import('../src/main.js');
  app.tracker.callbacks.onCalibrationComplete(baseline);
  app.tracker.callbacks.onStatusChange('Tracking — calibrated');
});
afterEach(() => { vi.unstubAllGlobals(); });

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
});

it('holds duck, releases it on missing input, clears metrics, and preserves calibration messages', () => {
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 1000; t += 20) feed(t, points(0, true));
  expect(app.scene.duck.mock.calls).toEqual([[true]]);
  expect(Number(text('pause-duration'))).toBeGreaterThan(0.2);
  feed(1020, null);
  expect(app.scene.duck.mock.calls).toEqual([[true], [false]]);
  expect(text('knee-angle')).toBe('—');
  expect(text('pause-duration')).toBe('—');
  expect(app.scene.jump).not.toHaveBeenCalled();
  app.tracker.callbacks.onPoseUpdate(null, null);
  app.tracker.callbacks.onStatusChange('Calibrating — hold still: 3s');
  expect(text('state-val')).toBe('Calibrating — hold still: 3s');
});

it('does not queue actions if the game scene is not ready', () => {
  app.scene = null;
  for (let t = 0; t <= 200; t += 20) feed(t);
  for (let t = 220; t <= 720; t += 20) feed(t, points(0.14 * Math.sin(Math.PI * (t - 220) / 500)));
  expect(app.game.events.emit.mock.calls.filter(([name]) => name === 'gesture:action')).toHaveLength(0);
});
