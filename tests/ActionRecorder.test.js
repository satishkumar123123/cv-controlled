import { describe, expect, it } from 'vitest';
import { GestureClassifier } from '../src/vision/GestureClassifier.js';
import { ActionRecorder, JOINT_METRICS } from '../src/analytics/ActionRecorder.js';
import { createSessionReport } from '../src/analytics/SessionReport.js';
import { PerformanceMonitor } from '../src/analytics/PerformanceMonitor.js';

const baseline = { baselineHipY: 0.45, baselineFootY: 0.87, torsoHeight: 0.25, shoulderWidth: 0.2 };
const pose = (lift = 0, duck = false) => {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, z: 0, visibility: 1 }));
  for (const [left, right, y] of [[11, 12, .2], [23, 24, .45], [25, 26, .65], [27, 28, .85], [29, 30, .87], [31, 32, .87]]) {
    p[left] = { x: .6, y: y - lift, z: 0, visibility: 1 };
    p[right] = { x: .4, y: y - lift, z: 0, visibility: 1 };
  }
  p[31].z = p[32].z = -.1;
  if (duck) {
    for (const i of [11, 12, 23, 24]) p[i].y += .15;
    for (const i of [25, 26]) Object.assign(p[i], { y: .72, z: -.13 });
  }
  return p;
};
const setup = (options) => {
  const recorder = new ActionRecorder(options), actions = [];
  const classifier = new GestureClassifier({ onActionTrigger: (action) => actions.push(action), onMetricsUpdate: (m) => recorder.update(m) });
  const feed = (t, p = pose(), context = {}) => classifier.update(p, baseline, t, { aspectRatio: 1, ...context });
  const runJump = (offset = 0) => {
    for (let t = 0; t <= 1400; t += 20) feed(offset + t, pose(t >= 220 && t <= 720 ? .14 * Math.sin(Math.PI * (t - 220) / 500) : 0));
  };
  return { recorder, classifier, feed, runJump, actions };
};

describe('per-action lower-limb recording', () => {
  it('records real FSM preparation/takeoff/flight/landing samples and a single completed jump', () => {
    const { recorder, classifier, runJump, actions } = setup();
    runJump();
    expect(actions).toEqual(['JUMP']);
    const record = recorder.getLast();
    expect(record.action).toBe('JUMP');
    expect(Object.keys(record.phases)).toEqual(['PREPARATION', 'TAKEOFF', 'FLIGHT', 'LANDING']);
    expect(record.samples.find((s) => s.phase === 'TAKEOFF').timestamp).toBe(classifier.t_takeoff);
    expect(record.samples.find((s) => s.phase === 'LANDING').timestamp).toBe(classifier.t_landing);
    expect(record.flightTime).toBeCloseTo((record.landingAt - record.startedAt) / 1000);
    expect(record.jumpHeight).toBeCloseTo(9.81 * record.flightTime ** 2 / 8);
    for (const phase of Object.values(record.phases)) for (const key of JOINT_METRICS) {
      expect(phase.angles[key].validSamples).toBe(phase.samples);
      expect(phase.angles[key].min).toBeCloseTo(0);
    }
    expect(recorder.history).toHaveLength(1);
  });
  it('records held crouch angles and bottom pause without copying the preceding jump metrics', () => {
    const { recorder, runJump, feed, actions } = setup();
    runJump();
    for (let t = 1420; t <= 2200; t += 20) feed(t, pose(0, true));
    for (let t = 2220; t <= 3000; t += 20) feed(t);
    expect(actions).toEqual(['JUMP', 'DUCK_START', 'DUCK_END']);
    const record = recorder.getLast();
    expect(record.action).toBe('DUCK');
    expect(record.pauseDuration).toBeGreaterThan(.2);
    expect(record.flightTime).toBeNull();
    expect(record.jumpHeight).toBeNull();
    expect(record.phases.CROUCH.angles.leftAnkleDorsiflexion.max).toBeGreaterThan(0);
  });
  it('discards incomplete action history after occlusion without a false completed repetition', () => {
    const { recorder, feed } = setup();
    for (let t = 0; t <= 200; t += 20) feed(t);
    for (let t = 220; t <= 420; t += 20) feed(t, pose((t - 220) * .0005));
    expect(recorder.active.action).toBe('JUMP');
    const hidden = pose(.1); hidden[31].visibility = .64;
    feed(440, hidden);
    expect(recorder.active).toBeNull();
    expect(recorder.getLast()).toBeNull();
    expect(recorder.currentPhase).toBe('—');
    expect(recorder.cancellationReason).toContain('visibility');
  });
  it('keeps an unavailable world-foot angle null while image contacts can still control the game', () => {
    const { classifier, feed } = setup();
    const world = pose(); world[31].visibility = .64;
    feed(0, pose(), { worldLandmarks: world });
    expect(classifier.metrics).toMatchObject({ valid: true, leftAnkleDorsiflexion: null, rightAnkleDorsiflexion: 0, ankleDorsiflexion: null });
  });
  it('does not treat outward foot rotation as ducking', () => {
    const { feed, actions, classifier } = setup();
    for (let t = 0; t <= 1000; t += 20) {
      const p = pose(); p[31].x += .1; p[32].x -= .1;
      feed(t, p);
    }
    expect(actions).toEqual([]);
    expect(classifier.metrics).toMatchObject({ state: 'NEUTRAL', armed: true });
  });
  it('bounds long holds/history, marks omitted samples, rejects duplicate frames and resets cleanly', () => {
    const { recorder, feed, runJump } = setup({ maxSamples: 12, maxActions: 2 });
    for (const offset of [0, 1420, 2840]) runJump(offset);
    expect(recorder.history).toHaveLength(2);
    for (const record of recorder.history) {
      expect(record.samples.length).toBeLessThanOrEqual(12);
      expect(record.truncated).toBe(true);
    }
    feed(4240); // duplicate final frame
    expect(recorder.history).toHaveLength(2);
    expect(recorder._buffer.length).toBeLessThanOrEqual(64);
    recorder.reset();
    expect(recorder.getReport().completedActions).toEqual([]);
  });
  it('exports hardware, duration, averages, model configuration and numeric action data without frames', () => {
    const { recorder, runJump } = setup();
    runJump();
    const monitor = new PerformanceMonitor({ now: () => 100, hardwareProfile: { platform: 'test OS' } });
    const report = createSessionReport(monitor, recorder, 'Test CPU; simulated fixture');
    expect(report.performance.hardware.hardwareNotes).toContain('Test CPU');
    expect(report.performance.model).toMatchObject({ complexity: 0 });
    expect(report.performance.averageActionLatencyMs).toBeNull();
    expect(report.movement.completedActions).toHaveLength(1);
    report.movement.completedActions[0].samples[0].leftKneeFlexion = 999;
    expect(recorder.history[0].samples[0].leftKneeFlexion).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity|data:image/);
  });
});
