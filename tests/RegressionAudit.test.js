import { afterEach, describe, expect, it, vi } from 'vitest';

// Rendering/SDK dependencies are replaced only at their boundaries. Tests call
// the production scene, classifier and calibration methods. Real Arcade collision
// ordering is additionally exercised by scripts/check-gameplay.cjs.
vi.mock('phaser', () => ({ default: {
  Scene: class {}, Math: { Between: (min, max) => Math.floor((min + max) / 2), FloatBetween: (min) => min }
} }));
vi.mock('@mediapipe/pose', () => ({ Pose: class {} }));
vi.mock('@mediapipe/camera_utils', () => ({ Camera: class {} }));
import { GameScene, RUNNER } from '../src/game/GameScene.js';
import { GestureClassifier } from '../src/vision/GestureClassifier.js';
import { PoseTracker } from '../src/vision/PoseTracker.js';
import { classifySquatDepth } from '../src/analytics/Kinematics.js';

const baseline = { baselineHipY: 0.45, baselineFootY: 0.87, torsoHeight: 0.25, shoulderWidth: 0.2 };
function standing(lift = 0, splitFeet = false) {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, z: 0, visibility: 1 }));
  for (const [left, right, y] of [[11, 12, 0.2], [23, 24, 0.45], [25, 26, 0.65], [27, 28, 0.82],
    [29, 30, splitFeet ? 0.84 : 0.87], [31, 32, splitFeet ? 0.90 : 0.87]]) {
    p[left] = { x: 0.4, y: y - lift, z: 0, visibility: 1 };
    p[right] = { x: 0.6, y: y - lift, z: 0, visibility: 1 };
  }
  return p;
}
function bentKnees() {
  const p = standing();
  for (const i of [11, 12, 23, 24]) p[i].y += 0.15;
  for (const i of [25, 26]) Object.assign(p[i], { y: 0.72, z: -0.13 });
  return p;
}
function feed(classifier, from, to, pose = standing, b = baseline) {
  for (let t = from; t <= to; t += 20) classifier.update(pose(), b, t, { aspectRatio: 1 });
}

// Small rectangle/body adapter: no simulated collision results or gesture logic.
function rectangle(x = 110, y = 410, width = 30, height = 60) {
  const rect = {
    x, y, width, height, active: false,
    setSize(w, h) { this.width = w; this.height = h; return this; },
    setDisplaySize() { return this; }, setStrokeStyle() { return this; },
    setFillStyle(color) { this.fillColor = color; return this; },
    setAlpha() { return this; }, setVisible() { return this; },
    setActive(active) { this.active = active; return this; }
  };
  rect.body = {
    width, height, velocity: { x: 0, y: 0 }, blocked: { down: false }, touching: { down: false },
    get bottom() { return rect.y + this.height / 2; }, get top() { return rect.y - this.height / 2; },
    get left() { return rect.x - this.width / 2; }, get right() { return rect.x + this.width / 2; },
    setSize(w, h) { this.width = w; this.height = h; },
    reset(px, py) { rect.x = px; rect.y = py; this.setVelocity(0, 0); },
    setVelocity(vx, vy) { this.velocity.x = vx; this.velocity.y = vy; },
    setVelocityX(vx) { this.velocity.x = vx; }, setVelocityY(vy) { this.velocity.y = vy; }
  };
  return rect;
}
function sceneFixture() {
  const scene = new GameScene(), obstacle = rectangle();
  Object.assign(scene, {
    player: rectangle(), obstacles: { getFirstDead: () => obstacle.active ? null : obstacle, getChildren: () => [obstacle] },
    physics: { pause: vi.fn(), resume: vi.fn() }, game: { events: { emit: vi.fn() } },
    overlay: { setVisible: vi.fn() }, _scrollGround: vi.fn(), _updateHUD: vi.fn(), _showOverlay: vi.fn(), saveHighScore: vi.fn()
  });
  scene._resetRun();
  scene.setControllerStatus(true, true);
  scene._distanceUntilSpawn = Infinity;
  scene.invulnerableUntil = 0;
  return scene;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('release restart controls', () => {
  it('only restarts after collision, preserving keyboard shortcuts and focused controls', () => {
    const scene = sceneFixture(), restart = vi.spyOn(scene, 'restartGame');
    const event = { preventDefault: vi.fn(), target: { tagName: 'CANVAS' } };
    scene._onRestartKey(event);
    expect(restart).not.toHaveBeenCalled();
    scene.gameOver();
    for (const override of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
      { target: { tagName: 'INPUT' } }, { target: { tagName: 'BUTTON' } }, { target: { isContentEditable: true } }]) {
      scene._onRestartKey({ ...event, ...override });
    }
    expect(restart).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    scene._onRestartKey(event);
    expect(restart).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(scene.runState).toBe('WAITING');
    expect(scene.score).toBe(0);
  });
});

describe('audit bug 1: held duck reconciles on virtual landing', () => {
  it('remembers a rejected airborne duck and applies its hitbox without another edge event', () => {
    const scene = sceneFixture();
    expect(scene.jump()).toBe(true);
    scene.player.body.reset(110, 330);
    scene.player.body.setVelocityY(300);
    expect(scene.duck(true)).toBe(false);
    expect(scene.desiredDuckState).toBe(true);
    scene.update(0, 16);
    expect(scene.player.body.height).toBe(60);
    scene.player.body.reset(110, 410);
    scene.player.body.touching.down = true;
    scene.update(16, 16);
    expect(scene.isDucking).toBe(true);
    expect(scene.player.body.height).toBe(28);
    expect(scene.player.body.bottom).toBe(440);
    expect(scene.player.fillColor).toBe(0xeab308);
    scene.duck(false);
    for (let t = 32; t <= 160; t += 16) scene.update(t, 16);
    expect(scene.player.body.height).toBe(60);
    expect(scene.player.body.bottom).toBe(440);
  });

  it.each(['release', 'tracking loss', 'restart'])('cancels pending intent on %s before landing', (cause) => {
    const scene = sceneFixture();
    scene.jump();
    scene.duck(true);
    if (cause === 'release') scene.duck(false);
    if (cause === 'tracking loss') scene.setControllerStatus(false);
    if (cause === 'restart') scene.restartGame();
    scene.setControllerStatus(true, true);
    scene.player.body.reset(110, 410);
    scene.player.body.touching.down = true;
    scene.update(16, 16);
    expect(scene.desiredDuckState).toBe(false);
    expect(scene.isDucking).toBe(false);
    expect(scene.player.body.height).toBe(60);
  });
});

describe('audit bug 2: provisional airborne recovery', () => {
  it.each([0.03, 0.05])('rejects impact duck after an unconfirmed %s foot rise, including beyond 250 ms', (lift) => {
    const actions = vi.fn(), classifier = new GestureClassifier({ onActionTrigger: actions });
    feed(classifier, 0, 200);
    feed(classifier, 220, 240, () => standing(lift)); // Only 20 ms; below 35 ms takeoff debounce.
    expect(classifier.state).toBe('NEUTRAL');
    expect(classifier.lastProvisionalAirborneTime).toBe(240);
    classifier.update(bentKnees(), baseline, 260);
    expect(classifier.state).toBe('LANDING_COOLDOWN');
    expect(classifier.provisionalLandingCooldown).toBe(510);
    feed(classifier, 280, 900, bentKnees);
    expect(actions).not.toHaveBeenCalled(); // Previously DUCK_START at 380 ms.
    expect(classifier.metrics).toMatchObject({ armed: false, flightTime: null, jumpHeight: null });
    feed(classifier, 920, 1800);
    expect(classifier.metrics).toMatchObject({ state: 'NEUTRAL', armed: true });
    feed(classifier, 1820, 2100, bentKnees);
    expect(actions.mock.calls.map(([action]) => action)).toEqual(['DUCK_START']);
  });

  it('keeps the full 250 ms window even if stable neutral returns earlier', () => {
    const classifier = new GestureClassifier();
    feed(classifier, 0, 200);
    const feetOnly = standing();
    for (const i of [29, 30, 31, 32]) feetOnly[i].y -= 0.04;
    classifier.update(feetOnly, baseline, 220);
    feed(classifier, 240, 480);
    expect(classifier.metrics).toMatchObject({ state: 'LANDING_COOLDOWN', armed: false });
    classifier.update(standing(), baseline, 490);
    expect(classifier.metrics).toMatchObject({ state: 'NEUTRAL', armed: true });
  });
});

function calibrate({ jitter = 0, world = null } = {}) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('document', { hidden: false });
  const ctx = Object.fromEntries(['clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill'].map((key) => [key, vi.fn()]));
  const video = { videoWidth: 640, videoHeight: 480 };
  const classifier = new GestureClassifier(), onCalibrationComplete = vi.fn((b, samples) => classifier.completeCalibration(b, samples));
  const tracker = new PoseTracker(video, { getContext: () => ctx }, { onCalibrationComplete,
    onPoseUpdate: (p, b, frame) => p && classifier.update(p, b, frame.timestamp, frame) });
  for (let frame = 0; frame <= 60; frame++) {
    now = frame * 50;
    const p = standing(0, true);
    for (const i of [29, 30, 31, 32]) p[i].y += (frame % 2 ? jitter : -jitter);
    tracker._handleResults({ poseLandmarks: p, poseWorldLandmarks: world });
  }
  return { tracker, classifier, onCalibrationComplete };
}

describe('audit bug 3: each foot marker has its own calibrated ground', () => {
  it('arms immediately after static calibration with heels at .84 and toes at .90', () => {
    const { tracker, classifier, onCalibrationComplete } = calibrate();
    expect(onCalibrationComplete).toHaveBeenCalledOnce();
    expect(tracker.baseline.baselineFootY).toBeCloseTo(0.87);
    for (const key of ['baselineLeftHeelY', 'baselineRightHeelY']) expect(tracker.baseline[key]).toBeCloseTo(0.84);
    for (const key of ['baselineLeftToeY', 'baselineRightToeY']) expect(tracker.baseline[key]).toBeCloseTo(0.90);
    expect(classifier.metrics).toMatchObject({ valid: true, state: 'NEUTRAL', armed: true, neutral: true });
    expect(Object.values(tracker.baseline.footYStdDev)).toEqual([0, 0, 0, 0]);
    expect(Object.isFrozen(tracker.baseline.footYNoiseEnvelope)).toBe(true);
  });

  it('stores raw sample standard deviations and 3-sigma envelopes while tolerating small jitter', () => {
    const { tracker, classifier } = calibrate({ jitter: 0.002 });
    const samples = Array.from({ length: 61 }, (_, i) => i % 2 ? 0.002 : -0.002);
    const mean = samples.reduce((sum, n) => sum + n, 0) / samples.length;
    const deviation = Math.sqrt(samples.reduce((sum, n) => sum + (n - mean) ** 2, 0) / 60);
    expect(classifier.metrics.armed).toBe(true);
    for (const i of [29, 30, 31, 32]) {
      expect(tracker.baseline.footYStdDev[i]).toBeCloseTo(deviation, 10);
      expect(tracker.baseline.footYNoiseEnvelope[i]).toBeCloseTo(3 * deviation, 10);
    }
  });

  it('refuses calibration success when world geometry cannot satisfy neutral arming', () => {
    const world = standing(0, true);
    world[25].z = world[26].z = -0.2; // Image looks straight; 3D knees are flexed.
    const { tracker, classifier, onCalibrationComplete } = calibrate({ world });
    expect(tracker.baseline).toBeNull();
    expect(onCalibrationComplete).not.toHaveBeenCalled();
    expect(tracker._status).toContain('neutral self-check failed');
    expect(classifier.metrics?.armed ?? false).toBe(false);
  });

  it('rejects a raw 3-sigma noise envelope larger than the contact tolerance', () => {
    const { tracker, onCalibrationComplete } = calibrate({ jitter: 0.012 });
    expect(tracker.baseline).toBeNull();
    expect(onCalibrationComplete).not.toHaveBeenCalled();
    expect(tracker._status).toContain('neutral self-check failed');
  });

  it('does not arm with a partial marker calibration or bypass contact/takeoff hysteresis', () => {
    const classifier = new GestureClassifier(), actions = vi.fn();
    classifier.onActionTrigger = actions;
    feed(classifier, 0, 200, standing, { ...baseline, baselineLeftHeelY: 0.84 });
    expect(classifier.metrics).toMatchObject({ valid: false, armed: false });
    feed(classifier, 220, 500);
    feed(classifier, 520, 600, () => {
      const p = standing(0.06);
      for (const i of [29, 30, 31, 32]) p[i].y = baseline.baselineFootY - 0.024;
      return p; // Hips rising fast, but feet still inside adaptive contact tolerance.
    });
    expect(actions).not.toHaveBeenCalled();
  });
});

describe('audit bug 4: a high barrier can only be cleared by ducking', () => {
  it('collides with a -600 / 1400 jump at 360 px/s, but leaves 10 px duck clearance', () => {
    const scene = sceneFixture();
    scene.speed = RUNNER.MAX_SPEED;
    const high = scene.spawnObstacle('HIGH');
    expect(high.body.top).toBe(0);
    expect(high.body.bottom).toBe(402);
    const startX = scene.player.body.right + high.width / 2 + 360 * 0.2;
    expect(scene.jump()).toBe(true);
    const initialVy = scene.player.body.velocity.y;
    let collisions = 0;
    // Sample the ballistic envelope against production obstacle geometry. A real
    // Arcade step/overlap test at the same timing is in the browser suite.
    for (let t = 0; t < 0.86; t += 1 / 120) {
      const feet = 440 + initialVy * t + 0.5 * RUNNER.GRAVITY * t ** 2;
      high.body.reset(startX - 360 * t, high.y);
      if (high.body.left < 125 && high.body.right > 95 && feet > high.body.top && feet - 60 < high.body.bottom) collisions++;
    }
    expect(collisions).toBeGreaterThan(0);
    scene._onObstacleHit();
    expect(scene.runState).toBe('GAME_OVER');
    scene.restartGame();
    scene.setControllerStatus(true, true);
    expect(scene.duck(true)).toBe(true);
    const next = scene.spawnObstacle('HIGH');
    expect(scene.player.body.top - next.body.bottom).toBe(10);
  });
});

describe('squat labels never inherit the knee-level heuristic', () => {
  it.each([[50, 50, 'Quarter squat'], [80, 80, 'Half squat'], [95, 100, 'Parallel squat'],
    [120, 135, 'Deep/full squat'], [65, 65, 'Transition']])('%s/%s remains %s at knee level', (hip, knee, category) => {
    expect(classifySquatDepth(hip, knee, 0.7, 0.7)).toEqual({ depthCategory: category, isHipsAtKneeLevel: true });
    expect(classifySquatDepth(hip, knee, 0.5, 0.7)).toEqual({ depthCategory: category, isHipsAtKneeLevel: false });
  });
});
