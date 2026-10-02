// Biomechanical calculations scaffold
export function calculateAngle(a, b, c) {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs((radians * 180.0) / Math.PI);
  if (angle > 180.0) angle = 360.0 - angle;
  return angle;
}

export function estimateJumpHeight(flightTimeSeconds) {
  const g = 9.81;
  return (g * Math.pow(flightTimeSeconds, 2)) / 8;
}
