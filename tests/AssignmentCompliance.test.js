import { describe, expect, it } from 'vitest';
import { GestureClassifier } from '../src/vision/GestureClassifier.js';
import { ActionRecorder } from '../src/analytics/ActionRecorder.js';
import { PoseTracker } from '../src/vision/PoseTracker.js';

const baseline = { baselineHipY: .45, baselineFootY: .87, torsoHeight: .25, shoulderWidth: .2 };
function pose(lift = 0, depth = 0) {
  const points = Array.from({ length: 33 }, () => ({ x: .5, y: .1, z: 0, visibility: 1 }));
  for (const [l, r, y] of [[11, 12, .2], [23, 24, .45], [25, 26, .65], [27, 28, .85], [29, 30, .87], [31, 32, .87]]) {
    points[l] = { x: .4, y: y - lift, z: 0, visibility: 1 };
    points[r] = { x: .6, y: y - lift, z: 0, visibility: 1 };
  }
  points[31].z = points[32].z = -.1;
  for (const i of [11, 12, 23, 24]) points[i].y += depth;
  for (const i of [25, 26]) { points[i].y += depth * .47; points[i].z -= depth * .87; }
  return points;
}
function setup(step = 20, smoothing = false) {
  const actions = [], recorder = new ActionRecorder();
  const classifier = new GestureClassifier({
    onActionTrigger: (kind, context) => actions.push({ kind, ...context }),
    onMetricsUpdate: (metrics) => recorder.update(metrics)
  });
  let time = 0;
  const tracker = smoothing ? new PoseTracker({}, { getContext: () => ({}) }) : null;
  const feed = (points) => {
    time += step;
    return classifier.update(tracker ? tracker._filter(points, step) : points, baseline, time, { aspectRatio: 1 });
  };
  const hold = (duration, fn = () => pose()) => {
    for (let elapsed = 0; elapsed < duration; elapsed += step) feed(fn(elapsed));
  };
  const flight = () => hold(500, (t) => pose(.14 * Math.sin(Math.PI * t / 500)));
  hold(300);
  return { classifier, actions, recorder, feed, hold, flight };
}

describe('assignment movement regressions', () => {
  it.each([[1000 / 30, false], [1000 / 60, false], [1000 / 30, true], [1000 / 60, true]])('detects one jump after crouched preparation at %f ms per frame, EMA=%s', (step, smoothing) => {
    const { classifier, actions, hold, flight, recorder } = setup(step, smoothing);
    hold(400, () => pose(0, .15));
    expect(classifier.state).toBe('DUCKING');
    // Extend while rising, then leave the ground: no still neutral hold in between.
    hold(100, (t) => pose(0, .15 * (1 - t / 100)));
    flight();
    hold(700);
    expect(actions.filter((a) => a.kind === 'JUMP')).toHaveLength(1);
    expect(classifier.state).toBe('NEUTRAL');
    expect(recorder.getLast()).toMatchObject({ action: 'JUMP' });
    expect(recorder.getLast().flightTime).toBeGreaterThan(.3);
    expect(recorder.getLast().phases.TAKEOFF).toBeDefined();
    expect(new Set(actions.map((a) => a.timestamp)).size).toBe(actions.length);
  });

  it('accepts a real takeoff just after duck release without accepting a grounded rise', () => {
    const { classifier, actions, hold, flight } = setup();
    hold(400, () => pose(0, .15));
    hold(120); // Duck ends, but stable neutral has not yet rearmed.
    expect(classifier.state).toBe('NEUTRAL');
    expect(classifier.metrics.armed).toBe(false);
    flight();
    hold(700);
    expect(actions.map((a) => a.kind)).toEqual(['DUCK_START', 'DUCK_END', 'JUMP']);
  });

  it.each(['grounded rise', 'single foot', 'brief bilateral spike', 'occlusion'])('does not turn %s after crouching into a jump', (kind) => {
    const { classifier, actions, hold, feed } = setup();
    hold(400, () => pose(0, .15));
    if (kind === 'brief bilateral spike') { feed(pose(.10)); hold(300, () => pose(0, .15)); }
    else if (kind === 'occlusion') { const p = pose(.10); p[31].visibility = .64; feed(p); hold(300, () => pose(.10)); }
    else hold(400, (t) => {
      const p = pose(kind === 'single foot' ? Math.min(.10, t * .001) : 0);
      if (kind === 'single foot') p[30].y = p[32].y = baseline.baselineFootY;
      return p;
    });
    hold(700);
    expect(actions.filter((a) => a.kind === 'JUMP')).toHaveLength(0);
    expect(classifier.metrics.flightTime).toBeNull();
    expect(classifier.metrics.jumpHeight).toBeNull();
  });

  it('clears previous jump values from the live metrics when a new crouch starts', () => {
    const { classifier, hold, flight } = setup();
    flight(); hold(700);
    expect(classifier.metrics.flightTime).toBeGreaterThan(0);
    hold(400, () => pose(0, .15));
    expect(classifier.metrics).toMatchObject({ state: 'DUCKING', flightTime: null, jumpHeight: null, verticalDisplacement: null, takeoffTimestamp: null, landingTimestamp: null });
  });

  it('clears the previous bottom-pause value when a new jump starts', () => {
    const { classifier, hold, flight } = setup();
    hold(900, () => pose(0, .15)); hold(700);
    expect(classifier.metrics.pauseDuration).toBeGreaterThan(0);
    flight();
    expect(classifier.metrics.pauseDuration).toBeNull();
  });
});
