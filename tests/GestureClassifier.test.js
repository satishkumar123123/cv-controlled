import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GestureClassifier, GestureState } from '../src/vision/GestureClassifier.js';

const baseline = Object.freeze({ baselineHipY: 0.45, baselineFootY: 0.87, torsoHeight: 0.25, shoulderWidth: 0.2 });
function standing(lift = 0) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1 - lift, z: 0, visibility: 1 }));
  for (const [index, x, y] of [
    [11, 0.4, 0.2], [12, 0.6, 0.2], [23, 0.4, 0.45], [24, 0.6, 0.45],
    [25, 0.4, 0.65], [26, 0.6, 0.65], [27, 0.4, 0.85], [28, 0.6, 0.85],
    [29, 0.4, 0.87], [30, 0.6, 0.87], [31, 0.42, 0.87], [32, 0.62, 0.87]
  ]) Object.assign(points[index], { x, y: y - lift });
  return points;
}
function ducked(depth = 0.15) {
  const points = standing();
  for (const i of [11, 12, 23, 24]) points[i].y += depth;
  for (const i of [25, 26]) { points[i].y = 0.72; points[i].z = -0.13; }
  return points;
}
let classifier, actions, updates;
const feed = (time, points = standing(), context = {}) => classifier.update(points, baseline, time, { aspectRatio: 1, ...context });
const sequence = (from, to, makePose = standing, step = 20) => {
  for (let t = from; t <= to; t += step) feed(t, makePose(t));
};
const arm = () => sequence(0, 200, () => standing());
function jump(from = 220, duration = 500, step = 20) {
  sequence(from, from + duration, (t) => standing(0.14 * Math.sin(Math.PI * (t - from) / duration)), step);
}

beforeEach(() => {
  actions = vi.fn();
  updates = vi.fn();
  classifier = new GestureClassifier({ onActionTrigger: actions, onMetricsUpdate: updates });
});

describe('gesture sequences', () => {
  it('follows the full jump state path and timestamps the frame that completes debounce', () => {
    const transitions = [classifier.state];
    updates.mockImplementation(({ state }) => {
      if (transitions.at(-1) !== state) transitions.push(state);
    });
    arm();
    jump();
    sequence(740, 1400, () => standing());
    expect(transitions).toEqual(['NEUTRAL', 'JUMPING', 'LANDING_COOLDOWN', 'NEUTRAL']);
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    const [action, event] = actions.mock.calls[0];
    expect(action).toBe('JUMP');
    expect(event).toMatchObject({ source: 'pose' });
    expect(event.timestamp).toBeGreaterThan(classifier.t_takeoff); // End of debounce, the action's source frame.
  });

  it('allows at most one event per frame throughout jumping with bent knees and landing', () => {
    arm();
    for (let t = 220; t <= 720; t += 20) {
      const lift = 0.14 * Math.sin(Math.PI * (t - 220) / 500);
      const p = standing(lift);
      p[25].z = p[26].z = -0.13;
      const before = actions.mock.calls.length;
      feed(t, p);
      expect(actions.mock.calls.length - before).toBeLessThanOrEqual(1);
    }
    sequence(740, 1400, () => ducked());
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
  });

  it('arms only after stable neutral and ignores standing, sway and head movement', () => {
    feed(0);
    expect(classifier.metrics.armed).toBe(false);
    sequence(20, 1000, (t) => {
      const p = standing(Math.sin(t / 200) * 0.001);
      p[0].y += Math.sin(t) * 0.2;
      return p;
    });
    expect(classifier.metrics.armed).toBe(true);
    expect(classifier.state).toBe('NEUTRAL');
    expect(actions).not.toHaveBeenCalled();
  });

  it('emits exactly one jump, records flight time at first contact and peak hip rise', () => {
    arm();
    jump();
    sequence(740, 800, () => standing());
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
    expect(classifier.metrics.flightTime).toBeGreaterThan(0.4);
    expect(classifier.metrics.flightTime).toBeLessThan(0.52);
    expect(classifier.metrics.jumpHeight).toBeCloseTo(9.81 * classifier.metrics.flightTime ** 2 / 8);
    expect(classifier.metrics.verticalDisplacement).toBeCloseTo(0.14, 2);
    expect(classifier.t_landing - classifier.t_takeoff).toBeCloseTo(classifier.metrics.flightTime * 1000);
  });

  it('accepts landing on either foot, including toe-first contact', () => {
    arm();
    sequence(220, 460, (t) => standing(Math.min(0.14, (t - 220) * 0.001)));
    sequence(480, 660, (t) => {
      const p = standing(0.14 - (t - 480) * 0.0005);
      p[31].y = baseline.baselineFootY; // One toe contacts; all other foot markers remain raised.
      return p;
    });
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
    expect(classifier.metrics.flightTime).toBeGreaterThan(0);
  });

  it('suppresses a prolonged landing bend beyond 250ms, then permits a fresh duck', () => {
    arm();
    jump();
    sequence(740, 1600, () => ducked());
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
    sequence(1620, 2100, () => standing());
    expect(classifier.state).toBe('NEUTRAL');
    sequence(2120, 2600, () => ducked());
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP', 'DUCK_START']);
  });

  it('enforces the 250ms refractory period even if posture is already neutral', () => {
    arm();
    jump();
    sequence(740, 960, () => standing());
    expect(classifier.state).toBe('LANDING_COOLDOWN');
    sequence(980, 1100, () => standing());
    expect(classifier.state).toBe('NEUTRAL');
  });

  it('emits one duck start/end, measures bottom pause, and ignores rising from duck', () => {
    arm();
    sequence(220, 1000, () => ducked());
    expect(classifier.state).toBe('DUCKING');
    expect(classifier.metrics.kneeFlexion).toBeGreaterThan(40);
    expect(classifier.metrics.pauseDuration).toBeGreaterThan(0.25);
    expect(classifier.metrics.pauseDuration).toBeLessThan(0.8);
    sequence(1020, 1800, () => standing());
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['DUCK_START', 'DUCK_END']);
    expect(classifier.state).toBe('NEUTRAL');
    expect(classifier.metrics.pauseDuration).toBeGreaterThan(0);
  });

  it('does not label rapid downward motion as a bottom pause', () => {
    arm();
    sequence(220, 500, (t) => ducked(0.05 + (t - 220) * 0.0003));
    expect(classifier.state).toBe('DUCKING');
    expect(classifier.metrics.pauseDuration).toBe(0);
  });

  it('rejects momentary crouches and a single-frame foot/hip spike', () => {
    arm();
    feed(220, ducked());
    feed(240, standing());
    feed(260, standing(0.1));
    sequence(280, 600, () => standing());
    expect(actions).not.toHaveBeenCalled();
  });

  it('requires both feet fully raised and sufficient upward hip velocity', () => {
    arm();
    sequence(220, 600, (t) => {
      const p = standing(Math.min(0.1, (t - 220) * 0.001));
      p[30].y = p[32].y = baseline.baselineFootY; // Right foot remains grounded.
      return p;
    });
    expect(actions).not.toHaveBeenCalled();
    classifier.reset(baseline);
    arm();
    sequence(220, 2000, (t) => standing((t - 220) * 0.00002));
    expect(actions).not.toHaveBeenCalled();
  });

  it('requires bent knees AND lowered hips AND grounded feet to start duck', () => {
    arm();
    sequence(220, 600, () => {
      const p = ducked();
      p[25].z = p[26].z = 0; // Straight legs despite hips dropping.
      return p;
    });
    expect(actions).not.toHaveBeenCalled();
  });

  it('does not emit simultaneous jump/duck events, even if an active duck leaves the ground', () => {
    arm();
    sequence(220, 500, () => ducked());
    for (let t = 520; t <= 900; t += 20) {
      const before = actions.mock.calls.length;
      feed(t, standing(0.1));
      expect(actions.mock.calls.length - before).toBeLessThanOrEqual(1);
    }
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['DUCK_START', 'DUCK_END']);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
  });

  it.each([23, 25, 27, 29, 31])('cancels flight on low visibility at landmark %i without fabricating a landing', (index) => {
    arm();
    sequence(220, 400, (t) => standing(Math.min(0.1, (t - 220) * 0.001)));
    expect(classifier.state).toBe('JUMPING');
    const p = standing(0.1);
    p[index].visibility = 0.64;
    feed(420, p);
    expect(classifier.metrics.valid).toBe(false);
    expect(classifier.metrics.flightTime).toBeNull();
    expect(classifier.metrics.jumpHeight).toBeNull();
    sequence(440, 700, () => standing(0.1));
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    sequence(720, 1300, () => standing());
    expect(classifier.metrics.flightTime).toBeNull();
  });

  it('releases a duck once on tracking loss and will not resume it without neutral recovery', () => {
    arm();
    sequence(220, 500, () => ducked());
    feed(520, null);
    feed(540, null);
    sequence(560, 1000, () => ducked());
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['DUCK_START', 'DUCK_END']);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
  });

  it('discards flight after a timestamp gap or an implausibly long flight', () => {
    arm();
    sequence(220, 400, (t) => standing(Math.min(0.1, (t - 220) * 0.001)));
    feed(1000, standing());
    expect(classifier.metrics.flightTime).toBeNull();
    expect(classifier.metrics.armed).toBe(false);
    classifier.reset(baseline);
    arm();
    sequence(220, 3000, (t) => standing(Math.min(0.1, (t - 220) * 0.001)));
    expect(classifier.metrics.flightTime).toBeNull();
    expect(classifier.state).toBe('LANDING_COOLDOWN');
  });

  it('ignores duplicate/backwards timestamps and resets on changed calibration', () => {
    arm();
    feed(180, standing(0.1));
    feed(200, ducked());
    expect(actions).not.toHaveBeenCalled();
    classifier.update(standing(), { ...baseline, torsoHeight: 0.3 }, 220);
    expect(classifier.metrics.armed).toBe(false);
    expect(classifier.metrics.flightTime).toBeNull();
  });

  it('uses world coordinates for angles while retaining image Y for movement', () => {
    const world = ducked().map((p) => ({ ...p, x: p.x - 0.5, y: p.y - 0.6 }));
    feed(0, standing(), { worldLandmarks: world });
    expect(classifier.metrics.angleSource).toBe('world-3d');
    expect(classifier.metrics.kneeFlexion).toBeGreaterThan(40);
    expect(classifier.metrics.verticalDisplacement).toBeNull();
    world[25].visibility = 0.4;
    feed(20, standing(), { worldLandmarks: world });
    expect(classifier.metrics.valid).toBe(false);
  });

  it('rejects invalid baseline and degenerate joint segments', () => {
    classifier.update(standing(), { ...baseline, torsoHeight: 0 }, 0);
    expect(classifier.metrics.valid).toBe(false);
    const p = standing();
    p[25] = { ...p[23] };
    feed(20, p);
    expect(classifier.metrics.valid).toBe(false);
    expect(classifier.metrics.kneeFlexion).toBeNull();
  });

  it.each([30, 60])('classifies a complete jump sampled at %i FPS exactly once', (fps) => {
    const step = 1000 / fps;
    for (let t = 0; t < 200; t += step) feed(t);
    for (let frame = 0; frame <= Math.ceil(1100 / step); frame++) {
      const t = 220 + frame * step;
      const lift = t <= 720 ? 0.14 * Math.sin(Math.PI * (t - 220) / 500) : 0;
      feed(t, standing(Math.max(0, lift)));
    }
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['JUMP']);
    expect(classifier.metrics.flightTime).toBeGreaterThan(0.4);
    expect(classifier.metrics.flightTime).toBeLessThan(0.55);
    expect(classifier.state).toBe(GestureState.NEUTRAL);
  });
});
