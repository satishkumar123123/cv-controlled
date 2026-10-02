import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceMonitor, getHardwareProfile } from '../src/analytics/PerformanceMonitor.js';

let now, monitor;
const frame = (frameId = 1, capturedAt = 0, inferenceStartedAt = 5, inferenceEndedAt = 25) => ({
  frameId, capturedAt, inferenceStartedAt, inferenceEndedAt, captureSource: 'frame-acquisition'
});
function complete(sample = frame()) {
  now = sample.inferenceEndedAt;
  return monitor.recordInference(sample);
}
beforeEach(() => {
  now = 0;
  monitor = new PerformanceMonitor({ now: () => now, hardwareProfile: { platform: 'Test OS', logicalCores: 4 } });
  monitor.setActive(true);
});

describe('independent inference and accepted-action boundaries', () => {
  it('measures inference separately from acquisition/drawing/game dispatch', () => {
    const sample = frame();
    expect(complete(sample)).toBe(true);
    now = 40;
    expect(monitor.recordAction('JUMP', sample)).toBe(true);
    expect(monitor.getLiveMetrics()).toMatchObject({ inferenceMs: 20, actionLatencyMs: 40, lastAction: 'JUMP' });
    expect(monitor.getSummary()).toMatchObject({ processedFrames: 1, averageInferenceMs: 20, averageActionLatencyMs: 40 });
  });

  it('pairs actions to one completed frame and rejects duplicate/unmatched commands', () => {
    complete();
    now = 30;
    expect(monitor.recordAction('JUMP', { ...frame(), frameId: 2 })).toBe(false);
    expect(monitor.recordAction('JUMP', { ...frame(), capturedAt: 1 })).toBe(false);
    expect(monitor.recordAction('UNKNOWN', frame())).toBe(false);
    expect(monitor.recordAction('JUMP', frame(), 24)).toBe(false);
    expect(monitor.recordAction('JUMP', frame(), 31)).toBe(false);
    expect(monitor.recordAction('JUMP', frame())).toBe(true);
    expect(monitor.recordAction('DUCK_START', frame())).toBe(false);
    expect(monitor.getSummary().acceptedActions).toBe(1);
  });

  it.each([
    { capturedAt: NaN }, { inferenceStartedAt: -1 }, { inferenceEndedAt: 4 },
    { frameId: 0 }, { captureSource: 'unknown' }
  ])('rejects invalid frame timing %j without poisoning aggregates', (override) => {
    now = 100;
    expect(monitor.recordInference({ ...frame(), ...override })).toBe(false);
    expect(monitor.getSummary().averageInferenceMs).toBeNull();
  });

  it('rejects duplicate, backward, future and inactive frame samples', () => {
    complete();
    expect(monitor.recordInference(frame())).toBe(false);
    expect(monitor.recordInference(frame(2, 0, 2, 20))).toBe(false);
    expect(monitor.recordInference(frame(2, 0, 2, 30))).toBe(false);
    monitor.setActive(false);
    now = 100;
    expect(monitor.recordInference(frame(2))).toBe(false);
    expect(monitor.getSummary().processedFrames).toBe(1);
  });

  it('reports slow inference even when a stale pose is discarded; never counts its action', () => {
    const sample = { ...frame(1, 0, 0, 600), stale: true };
    complete(sample);
    expect(monitor.recordAction('JUMP', sample)).toBe(false);
    expect(monitor.getSummary()).toMatchObject({ averageInferenceMs: 600, staleInferenceFrames: 1, acceptedActions: 0 });
  });
});

describe('FPS, sessions and bounded storage', () => {
  it('reports processing throughput rather than inverse model latency', () => {
    for (let id = 1; id <= 30; id++) complete(frame(id, id * 1000 / 30 - 15, id * 1000 / 30 - 10, id * 1000 / 30));
    expect(monitor.getLiveMetrics().cameraFps).toBeCloseTo(30);
    expect(monitor.getSummary()).toMatchObject({ averageFps: 30, averageInferenceMs: 10, processedFrames: 30 });
    now = 2101;
    expect(monitor.getLiveMetrics()).toMatchObject({ cameraFps: 0, inferenceMs: null });
    expect(monitor.getSummary().averageFps).toBeCloseTo(30 / 2.101);
  });

  it('excludes stopped/hidden intervals, clears stale HUD values, rejects a cross-pause frame', () => {
    complete();
    now = 100;
    monitor.setActive(false);
    now = 5100;
    expect(monitor.getSummary()).toMatchObject({ activeSeconds: 0.1, averageFps: 10 });
    expect(monitor.getLiveMetrics()).toMatchObject({ active: false, cameraFps: 0, inferenceMs: null, actionLatencyMs: null });
    monitor.setActive(true);
    expect(complete(frame(2, 5000, 5100, 5120))).toBe(false);
    complete(frame(3, 5150, 5155, 5175));
    now = 5200;
    expect(monitor.getSummary()).toMatchObject({ activeSeconds: 0.2, averageFps: 10, processedFrames: 2 });
  });

  it('resets warm-up samples while preserving active state and camera settings', () => {
    monitor.setCameraSettings({ width: 640, height: 480, deviceId: 'private-device', groupId: 'private-group' });
    complete();
    now = 100;
    monitor.reset();
    expect(monitor.getSummary()).toMatchObject({ processedFrames: 0, acceptedActions: 0, averageFps: null, averageInferenceMs: null, camera: { width: 640, height: 480 } });
    expect(monitor.active).toBe(true);
    expect(complete(frame(2, 100, 105, 125))).toBe(true);
    expect(monitor.getSummary().processedFrames).toBe(1);
  });

  it('keeps session aggregates after evicting the bounded live samples', () => {
    for (let id = 1; id <= 3000; id++) complete(frame(id, id, id, id));
    expect(monitor._frames.length).toBeLessThanOrEqual(240);
    expect(monitor.getSummary().processedFrames).toBe(3000);
    expect(monitor.getLiveMetrics().cameraFps).toBe(1000); // No undercount when the cap shortens the live window.
  });

  it('logs serializable hardware/OS, source counts and action counts with no invented hardware', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const sample = { ...frame(), captureSource: 'camera-capture' };
    complete(sample);
    now = 30;
    monitor.recordAction('DUCK_START', sample);
    const summary = monitor.logSummary('CPU/GPU manually documented');
    expect(log).toHaveBeenCalledWith('CV Runner performance summary', summary);
    expect(summary.hardware).toMatchObject({ platform: 'Test OS', logicalCores: 4, hardwareNotes: 'CPU/GPU manually documented' });
    expect(summary.captureSources['camera-capture']).toBe(1);
    expect(summary.actions.DUCK_START).toBe(1);
    expect(() => JSON.stringify(summary)).not.toThrow();
    summary.actions.DUCK_START = 100;
    expect(monitor.getSummary().actions.DUCK_START).toBe(1);
    expect(getHardwareProfile({})).toMatchObject({ platform: 'Unavailable', logicalCores: null, approximateMemoryGiB: null });
    log.mockRestore();
  });
});
