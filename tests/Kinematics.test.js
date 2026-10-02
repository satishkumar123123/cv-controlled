import { describe, it, expect } from 'vitest';
import {
  calculate3DAngle, calculateAngle, calculateKneeFlexion, calculateHipFlexion,
  calculateTorsoLean, calculateStanceWidthRatio, classifySquatDepth, estimateJumpHeight
} from '../src/analytics/Kinematics.js';

const p = (x, y, z = 0, visibility = 1) => ({ x, y, z, visibility });
describe('kinematics with confidence and degeneracy checks', () => {
  it('computes 3D interior angles using depth, with invariance to translation and scale', () => {
    const points = [p(1, 0, 0), p(0, 0, 0), p(0, 0, 1)];
    expect(calculate3DAngle(...points)).toBeCloseTo(90);
    const transformed = points.map((q) => p(q.x * 5 + 7, q.y * 5 - 3, q.z * 5 + 2));
    expect(calculate3DAngle(...transformed)).toBeCloseTo(90);
    expect(calculate3DAngle(p(-1, 0), p(0, 0), p(1, 0))).toBeCloseTo(180);
    expect(calculate3DAngle(p(1, 0), p(0, 0), p(2, 0))).toBeCloseTo(0);
    expect(calculate3DAngle(p(1, 0), p(0, 0), p(0.5, Math.sqrt(3) / 2))).toBeCloseTo(60);
  });
  it('defines straight neutral as zero flexion at both knee and hip', () => {
    expect(calculateKneeFlexion(p(0, -1), p(0, 0), p(0, 1))).toBeCloseTo(0);
    expect(calculateHipFlexion(p(0, -1), p(0, 0), p(0, 1))).toBeCloseTo(0);
    expect(calculateKneeFlexion(p(0, -1), p(0, 0), p(0, 0, 1))).toBeCloseTo(90);
    expect(calculateHipFlexion(p(0, -1), p(0, 0), p(1, 0))).toBeCloseTo(90);
  });
  it.each([null, p(0, 0, 0, 0.649), { x: 0, y: 0, z: 0 }, p(NaN, 0), p(0, 0, Infinity)])('rejects invalid/hidden 3D vertices: %j', (bad) => {
    for (const fn of [calculate3DAngle, calculateKneeFlexion, calculateHipFlexion]) {
      expect(fn(bad, p(0, 1), p(1, 1))).toBeNull();
      expect(fn(p(0, 1), bad, p(1, 1))).toBeNull();
      expect(fn(p(0, 1), p(1, 1), bad)).toBeNull();
    }
  });
  it('rejects zero-length segments and accepts threshold confidence exactly', () => {
    expect(calculate3DAngle(p(0, 0), p(0, 0), p(1, 1))).toBeNull();
    expect(calculateKneeFlexion(p(0, 0), p(0, 1), p(0, 1))).toBeNull();
    expect(calculate3DAngle(p(0, -1, 0, 0.65), p(0, 0), p(1, 0))).toBeCloseTo(90);
  });
  it('computes torso inclination from image up and preserves the 2D helper', () => {
    expect(calculateTorsoLean(p(0, -1), p(0, 0))).toBeCloseTo(0);
    expect(calculateTorsoLean(p(1, -1), p(0, 0))).toBeCloseTo(45);
    expect(calculateTorsoLean(p(1, 0), p(0, 0))).toBeCloseTo(90);
    expect(calculateTorsoLean(p(0, 0), p(0, 0))).toBeNull();
    expect(calculateTorsoLean(p(0, -1, 0, 0.5), p(0, 0))).toBeNull();
    expect(calculateAngle(p(0, 1), p(0, 0), p(1, 0))).toBeCloseTo(90);
  });
  it('normalizes stance width without mixing world units with image calibration', () => {
    expect(calculateStanceWidthRatio(p(0, 0), p(0.3, 0.4), 0.25)).toBeCloseTo(2);
    expect(calculateStanceWidthRatio(p(0, 0), p(1, 0), 0)).toBeNull();
    expect(calculateStanceWidthRatio(p(0, 0, 0, 0.5), p(1, 0), 0.2)).toBeNull();
  });
  it.each([
    [40, 40, 'Quarter squat'], [60, 60, 'Quarter squat'],
    [70, 70, 'Half squat'], [89, 90, 'Half squat'],
    [90, 90, 'Parallel squat'], [100, 110, 'Parallel squat'],
    [110, 120, 'Deep/full squat'], [130, 150, 'Deep/full squat'],
    [65, 65, 'Transition'], [105, 115, 'Transition'], [50, 100, 'Transition'],
    [0, 0, 'Standing']
  ])('classifies requested range hip=%s knee=%s as %s', (hip, knee, expected) => {
    expect(classifySquatDepth(hip, knee, 0.5, 0.7)).toEqual({ depthCategory: expected, isHipsAtKneeLevel: false });
  });
  it('keeps the knee-level observation independent of angle category and validity', () => {
    expect(classifySquatDepth(85, 85, 0.69, 0.7)).toEqual({ depthCategory: 'Half squat', isHipsAtKneeLevel: true });
    expect(classifySquatDepth(120, 130, 0.7, 0.7)).toEqual({ depthCategory: 'Deep/full squat', isHipsAtKneeLevel: true });
    expect(classifySquatDepth(null, 90, 0.5, 0.7)).toEqual({ depthCategory: null, isHipsAtKneeLevel: false });
    expect(classifySquatDepth(190, 90, 0.5, 0.7).depthCategory).toBeNull();
    expect(classifySquatDepth(50, 50, NaN, null)).toEqual({ depthCategory: 'Quarter squat', isHipsAtKneeLevel: null });
  });
  it.each([[0, 0], [0.25, 0.076640625], [0.5, 0.3065625], [0.8, 0.7848], [1, 1.22625]])(
    'estimates ballistic height for %ss flight as %sm', (time, expected) => {
      expect(estimateJumpHeight(time)).toBeCloseTo(expected, 7);
    }
  );
  it('rejects invalid flight times', () => {
    for (const value of [-1, NaN, Infinity, null, '0.5']) expect(estimateJumpHeight(value)).toBeNull();
  });
});
