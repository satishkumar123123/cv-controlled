import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ poses: [], cameras: [], startError: null, initGate: null, sendGate: null, stream: null }));
vi.mock('@mediapipe/pose', () => ({
  Pose: class {
    constructor(config) {
      this.config = config;
      this.close = vi.fn(async () => {});
      this.setOptions = vi.fn();
      this.initialize = vi.fn(async () => { await sdk.initGate; });
      this.send = vi.fn(async () => { await sdk.sendGate; });
      sdk.poses.push(this);
    }
    onResults(callback) { this.results = callback; }
  }
}));
vi.mock('@mediapipe/camera_utils', () => ({
  Camera: class {
    constructor(video, options) {
      this.options = options;
      this.start = vi.fn(async () => {
        if (sdk.startError) throw sdk.startError;
        video.srcObject = sdk.stream;
        video.onloadedmetadata = vi.fn();
      });
      this.stop = vi.fn(async () => {});
      sdk.cameras.push(this);
    }
  }
}));
import { PoseTracker } from '../src/vision/PoseTracker.js';

let now, track, ctx, video, canvas, callbacks, tracker;
const pose = () => {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.2, z: 0, visibility: 0.99 }));
  for (const [index, x, y] of [
    [11, 0.4, 0.25], [12, 0.6, 0.25], [23, 0.4, 0.5], [24, 0.6, 0.5],
    [25, 0.4, 0.7], [26, 0.6, 0.7], [27, 0.4, 0.9], [28, 0.6, 0.9],
    [29, 0.4, 0.92], [30, 0.6, 0.92], [31, 0.42, 0.94], [32, 0.62, 0.94]
  ]) Object.assign(points[index], { x, y });
  return points;
};
function feed(time, landmarks = pose()) {
  now = time;
  tracker._handleResults({ poseLandmarks: landmarks, image: video });
}
function hold(start = 0, duration = 3000, makePose = pose) {
  for (let time = start; time <= start + duration; time += 50) feed(time, makePose(time));
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 123));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  sdk.poses.length = sdk.cameras.length = 0;
  sdk.startError = sdk.initGate = sdk.sendGate = null;
  track = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  sdk.stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  ctx = Object.fromEntries(['clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill'].map((key) => [key, vi.fn()]));
  video = { videoWidth: 640, videoHeight: 480, readyState: 4, currentTime: 1, play: vi.fn(async () => {}), pause: vi.fn() };
  canvas = { width: 640, height: 480, getContext: () => ctx };
  callbacks = { onPoseUpdate: vi.fn(), onStatusChange: vi.fn(), onCalibrationComplete: vi.fn() };
  tracker = new PoseTracker(video, canvas, callbacks);
});

afterEach(async () => {
  await tracker.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('standing calibration and input validity', () => {
  it('requires 3 seconds and returns the requested averaged baseline exactly once', () => {
    hold(0, 2950);
    expect(callbacks.onCalibrationComplete).not.toHaveBeenCalled();
    expect(callbacks.onPoseUpdate).not.toHaveBeenCalled();
    feed(3000);
    expect(callbacks.onCalibrationComplete).toHaveBeenCalledTimes(1);
    expect(tracker.baseline.baselineHipY).toBeCloseTo(0.5);
    expect(tracker.baseline.baselineFootY).toBeCloseTo(0.93);
    expect(tracker.baseline.torsoHeight).toBeCloseTo(0.25);
    expect(tracker.baseline.shoulderWidth).toBeCloseTo(0.2);
    expect(Object.isFrozen(tracker.baseline)).toBe(true);
    hold(3050);
    expect(callbacks.onCalibrationComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onStatusChange.mock.calls.flat()).toEqual(expect.arrayContaining([
      'Calibrating — hold still: 3s', 'Calibrating — hold still: 2s', 'Calibrating — hold still: 1s'
    ]));
  });

  it.each([11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32])('rejects a low-visibility required landmark %i before smoothing', (index) => {
    hold();
    const baseline = tracker.baseline;
    const bad = pose();
    bad[index].visibility = 0.649;
    feed(3050, bad);
    expect(callbacks.onPoseUpdate).toHaveBeenLastCalledWith(null, baseline);
    expect(tracker._smoothed).toBeNull();
    expect(tracker.baseline).toBe(baseline);
    const moved = pose().map((point) => ({ ...point, y: point.y - 0.05 }));
    feed(3100, moved);
    expect(callbacks.onPoseUpdate.mock.lastCall[0][23].y).toBeCloseTo(0.45);
  });

  it.each(['missing', 'NaN', 'offscreen', 'no visibility'])('rejects %s lower-body landmarks', (kind) => {
    hold();
    const bad = pose();
    if (kind === 'missing') bad[31] = null;
    if (kind === 'NaN') bad[31].x = NaN;
    if (kind === 'offscreen') bad[31].y = 1.01;
    if (kind === 'no visibility') delete bad[31].visibility;
    feed(3050, bad);
    expect(callbacks.onPoseUpdate.mock.lastCall[0]).toBeNull();
  });

  it('accepts exactly 0.65 visibility and tolerates an invisible non-required landmark', () => {
    hold(0, 3000, () => pose().map((point, index) => ({ ...point, visibility: index === 15 ? 0 : 0.65 })));
    expect(tracker.baseline).not.toBeNull();
    expect(callbacks.onPoseUpdate.mock.lastCall[0][15]).toBeNull();
  });

  it('resets calibration on missing pose and requires a full new hold', () => {
    hold(0, 2500);
    feed(2550, undefined);
    // Explicit missing output rather than feed's default pose argument.
    tracker._handleResults({ image: video });
    hold(2600, 2950);
    expect(tracker.baseline).toBeNull();
    feed(5600);
    expect(tracker.baseline).not.toBeNull();
  });

  it('rejects a stationary crouch and requires standing again', () => {
    hold(0, 3500, () => {
      const p = pose();
      p[25].x = 0.52;
      p[26].x = 0.72;
      return p;
    });
    expect(tracker.baseline).toBeNull();
    hold(3550);
    expect(tracker.baseline).not.toBeNull();
  });

  it('resets on movement and slow drift instead of averaging a moving baseline', () => {
    hold(0, 3500, (time) => pose().map((point) => ({ ...point, x: point.x + time * 0.00002 })));
    expect(tracker.baseline).toBeNull();
    expect(callbacks.onStatusChange.mock.calls.flat().some((text) => text.includes('movement detected'))).toBe(true);
  });

  it('does not complete using elapsed time across a stalled stream', () => {
    hold(0, 1000);
    feed(5000);
    expect(tracker.baseline).toBeNull();
    hold(5050, 2900);
    expect(tracker.baseline).toBeNull();
    feed(8000);
    expect(tracker.baseline).not.toBeNull();
  });

  it('filters jitter, leaves confidence unsmoothed, and protects history from consumers', () => {
    hold();
    const changed = pose();
    changed[23].y = 0.52;
    changed[23].visibility = 0.7;
    feed(3033.333333, changed);
    const output = callbacks.onPoseUpdate.mock.lastCall[0];
    expect(output[23].y).toBeCloseTo(0.508);
    expect(output[23].visibility).toBe(0.7);
    output[23].y = 10;
    expect(tracker._smoothed[23].y).toBeCloseTo(0.508);
  });

  it('invalidates game data when recalibrating or hiding the tab', () => {
    hold();
    document.hidden = true;
    feed(3050);
    expect(callbacks.onPoseUpdate.mock.lastCall[0]).toBeNull();
    document.hidden = false;
    feed(3100);
    tracker.recalibrate();
    expect(callbacks.onPoseUpdate).toHaveBeenLastCalledWith(null, null);
    expect(tracker.baseline).toBeNull();
    hold(3150);
    expect(callbacks.onCalibrationComplete).toHaveBeenCalledTimes(2);
  });

  it('draws camera pixels plus all requested connectors and hides invalid skeletons', () => {
    feed(0);
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 480);
    expect(ctx.stroke).toHaveBeenCalledTimes(14);
    expect(ctx.arc).toHaveBeenCalledTimes(12);
    ctx.stroke.mockClear();
    tracker._handleResults({ image: video });
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});

describe('runtime lifecycle', () => {
  it('deduplicates startup and releases camera, model and scheduled work on stop', async () => {
    await Promise.all([tracker.init(), tracker.init()]);
    expect(sdk.poses).toHaveLength(1);
    expect(sdk.cameras).toHaveLength(1);
    expect(video.onloadedmetadata).toBeNull();
    expect(video.play).toHaveBeenCalledOnce();
    expect(sdk.poses[0].config.locateFile('test.wasm')).toContain('@0.5.1675469404/test.wasm');
    await tracker.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(sdk.cameras[0].stop).toHaveBeenCalledOnce();
    expect(sdk.poses[0].close).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(123);
    expect(vi.getTimerCount()).toBe(0);
    await tracker.init();
    expect(sdk.poses).toHaveLength(2);
  });

  it('reports camera permission errors and allows a clean retry', async () => {
    sdk.startError = Object.assign(new Error('Denied'), { name: 'NotAllowedError' });
    await expect(tracker.init()).rejects.toThrow('Denied');
    expect(tracker.isRunning).toBe(false);
    expect(callbacks.onStatusChange.mock.lastCall[0]).toContain('Camera access denied');
    expect(sdk.poses[0].close).toHaveBeenCalledOnce();
    sdk.startError = null;
    await tracker.init();
    expect(tracker.isRunning).toBe(true);
  });

  it('stops safely while the model is still initializing', async () => {
    let finish;
    sdk.initGate = new Promise((resolve) => { finish = resolve; });
    const pending = tracker.init();
    const stopped = tracker.stop();
    finish();
    await Promise.all([pending, stopped]);
    expect(sdk.cameras).toHaveLength(0);
    expect(sdk.poses[0].close).toHaveBeenCalledOnce();
    expect(tracker.isRunning).toBe(false);
  });

  it('does not queue another frame while inference is pending', async () => {
    await tracker.init();
    let finish;
    sdk.sendGate = new Promise((resolve) => { finish = resolve; });
    const tick = requestAnimationFrame.mock.lastCall[0];
    requestAnimationFrame.mockClear();
    const pending = tick();
    await flush();
    expect(sdk.poses[0].send).toHaveBeenCalledOnce();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it('invalidates frozen-stream data through the watchdog', async () => {
    await tracker.init();
    hold();
    now = 3600;
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.onPoseUpdate.mock.lastCall[0]).toBeNull();
    expect(callbacks.onStatusChange.mock.lastCall[0]).toContain('fresh camera frames');
  });

  it('drops delayed inference results instead of restoring stale game input', async () => {
    await tracker.init();
    hold();
    tracker._frameStartedAt = 3000;
    now = 3700;
    sdk.poses[0].results({ poseLandmarks: pose(), image: video });
    expect(callbacks.onPoseUpdate.mock.lastCall[0]).toBeNull();
    expect(callbacks.onStatusChange.mock.lastCall[0]).toContain('delayed');
  });

  it('reports inference failures and completes cleanup without deadlock', async () => {
    await tracker.init();
    sdk.poses[0].send.mockRejectedValueOnce(new Error('WebGL context lost'));
    const tick = requestAnimationFrame.mock.lastCall[0];
    await tick();
    await tracker._stopPromise;
    expect(tracker.isRunning).toBe(false);
    expect(callbacks.onStatusChange.mock.lastCall[0]).toContain('WebGL context lost');
    expect(sdk.poses[0].close).toHaveBeenCalledOnce();
  });

  it('invalidates the baseline and releases resources when the camera disconnects', async () => {
    await tracker.init();
    hold();
    track.addEventListener.mock.calls.find(([event]) => event === 'ended')[1]();
    await tracker._stopPromise;
    expect(callbacks.onPoseUpdate).toHaveBeenLastCalledWith(null, null);
    expect(callbacks.onStatusChange.mock.lastCall[0]).toContain('Camera disconnected');
    expect(tracker.isRunning).toBe(false);
  });
});
