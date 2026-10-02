export const MIN_VISIBILITY = 0.65;
const EPSILON = 1e-8;
const degrees = (radians) => radians * 180 / Math.PI;
const clamp = (value) => Math.max(-1, Math.min(1, value));

/** Missing confidence is unknown, not implicitly visible. */
export function isVisibleLandmark(point, dimensions = 3) {
  return point != null && Number.isFinite(point.visibility) && point.visibility >= MIN_VISIBILITY &&
    ['x', 'y', ...(dimensions === 3 ? ['z'] : [])].every((axis) => Number.isFinite(point[axis]));
}

export function midpoint(a, b, dimensions = 3) {
  if (![a, b].every((point) => isVisibleLandmark(point, dimensions))) return null;
  const result = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(a.visibility, b.visibility) };
  if (dimensions === 3) result.z = (a.z + b.z) / 2;
  return result;
}

function interiorAngle(a, b, c, dimensions) {
  if (![a, b, c].every((point) => isVisibleLandmark(point, dimensions))) return null;
  const axes = dimensions === 3 ? ['x', 'y', 'z'] : ['x', 'y'];
  const u = axes.map((axis) => a[axis] - b[axis]);
  const v = axes.map((axis) => c[axis] - b[axis]);
  const uLength = Math.hypot(...u), vLength = Math.hypot(...v);
  if (uLength < EPSILON || vLength < EPSILON) return null;
  // Normalize before dotting to avoid overflowing a product of lengths.
  const cosine = u.reduce((sum, value, index) => sum + (value / uLength) * (v[index] / vLength), 0);
  return Number.isFinite(cosine) ? degrees(Math.acos(clamp(cosine))) : null;
}

/** Interior angle in degrees, using XYZ in a single, consistent coordinate scale. */
export function calculate3DAngle(a, b, c) { return interiorAngle(a, b, c, 3); }

/** Backward-compatible image-plane interior angle. */
export function calculateAngle(a, b, c) { return interiorAngle(a, b, c, 2); }

export function calculateKneeFlexion(hip, knee, ankle) {
  const interior = calculate3DAngle(hip, knee, ankle);
  return interior === null ? null : 180 - interior;
}

/**
 * Unsigned thigh-to-torso departure from straight anatomical neutral (0°).
 * A three-point angle cannot isolate sagittal flexion from hip abduction or
 * extension. Treat this as a pose-based proxy, not a clinical joint measurement.
 */
export function calculateHipFlexion(shoulder, hip, knee) {
  const interior = calculate3DAngle(shoulder, hip, knee);
  return interior === null ? null : 180 - interior;
}

/** Image-plane inclination from (0, -1). Requires a fixed, level camera. */
export function calculateTorsoLean(midShoulder, midHip) {
  if (![midShoulder, midHip].every((point) => isVisibleLandmark(point, 2))) return null;
  const dx = midShoulder.x - midHip.x, dy = midShoulder.y - midHip.y;
  const length = Math.hypot(dx, dy);
  return length < EPSILON ? null : degrees(Math.acos(clamp(-dy / length)));
}

/** Both ankle XY and shoulderWidth must use the same image coordinate scale. */
export function calculateStanceWidthRatio(leftAnkle, rightAnkle, shoulderWidth) {
  if (![leftAnkle, rightAnkle].every((point) => isVisibleLandmark(point, 2)) ||
      !Number.isFinite(shoulderWidth) || shoulderWidth <= EPSILON) return null;
  return Math.hypot(leftAnkle.x - rightAnkle.x, leftAnkle.y - rightAnkle.y) / shoulderWidth;
}

/**
 * Task-specified bands; squat-depth terminology varies between protocols.
 * Gaps or conflicting angles stay Transition rather than inventing a category.
 * The angle category and image-plane knee-level observation are independent.
 * hipY/kneeY are normalized image Y; 0.02 is the knee-level tolerance.
 */
export function classifySquatDepth(hipFlexion, kneeFlexion, hipY, kneeY) {
  const result = {
    depthCategory: null,
    isHipsAtKneeLevel: [hipY, kneeY].every((y) => Number.isFinite(y) && y >= 0 && y <= 1)
      ? Math.abs(hipY - kneeY) <= 0.02 : null
  };
  if (![hipFlexion, kneeFlexion].every(Number.isFinite) ||
      hipFlexion < 0 || hipFlexion > 180 || kneeFlexion < 0 || kneeFlexion > 180) return result;
  const between = (value, low, high) => value >= low && value <= high;
  if (between(hipFlexion, 110, 130) && between(kneeFlexion, 120, 150)) result.depthCategory = 'Deep/full squat';
  else if (between(hipFlexion, 90, 100) && between(kneeFlexion, 90, 110)) result.depthCategory = 'Parallel squat';
  else if (between(hipFlexion, 70, 90) && between(kneeFlexion, 70, 90)) result.depthCategory = 'Half squat';
  else if (between(hipFlexion, 40, 60) && between(kneeFlexion, 40, 60)) result.depthCategory = 'Quarter squat';
  else result.depthCategory = hipFlexion < 40 && kneeFlexion < 40 ? 'Standing' : 'Transition';
  return result;
}

/** Ballistic estimate in meters. Assumes equal COM height at takeoff/landing. */
export function estimateJumpHeight(flightTimeSeconds) {
  if (!Number.isFinite(flightTimeSeconds) || flightTimeSeconds < 0) return null;
  const height = 9.81 * flightTimeSeconds ** 2 / 8;
  return Number.isFinite(height) ? height : null;
}
