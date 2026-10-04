import {
  isVisibleLandmark, midpoint, calculateKneeFlexion, calculateHipFlexion,
  calculateAnkleDorsiflexion, calculateHipSagittalAngle,
  calculateTorsoLean, calculateStanceWidthRatio, classifySquatDepth, estimateJumpHeight
} from '../analytics/Kinematics.js';

export const GestureState = Object.freeze({
  NEUTRAL: 'NEUTRAL', JUMPING: 'JUMPING', DUCKING: 'DUCKING', LANDING_COOLDOWN: 'LANDING_COOLDOWN'
});
const REQUIRED = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const JOINTS = [11, 12, 23, 24, 25, 26, 27, 28];
export const FOOT_BASELINES = Object.freeze({
  29: 'baselineLeftHeelY', 30: 'baselineRightHeelY',
  31: 'baselineLeftToeY', 32: 'baselineRightToeY'
});
// A normalized-image floor also protects subjects who stand farther away.
export const groundContactTolerance = (baseline, scale = 0.10) =>
  Math.max(0.025, 0.10 * baseline.torsoHeight, scale * baseline.torsoHeight);
const DEFAULTS = Object.freeze({
  footLift: 0.12, groundTolerance: 0.10, jumpVelocity: 0.6,
  duckDrop: 0.15, duckKneeFlexion: 40, neutralHipTolerance: 0.05,
  neutralKneeFlexion: 25, stillVelocity: 0.12,
  jumpDebounceMs: 35, duckDebounceMs: 120, exitDebounceMs: 80,
  landingDebounceMs: 30, cooldownMs: 250, neutralHoldMs: 120,
  pauseDebounceMs: 120, pauseDepthTolerance: 0.03,
  maxFrameGapMs: 200, minFlightMs: 100, maxFlightMs: 2000, velocityTimeConstantMs: 60
});
const emptyMetrics = () => ({
  flightTime: null, jumpHeight: null, verticalDisplacement: null, squatDepth: null,
  depthCategory: null, isHipsAtKneeLevel: null,
  leftKneeFlexion: null, rightKneeFlexion: null, leftHipFlexion: null, rightHipFlexion: null,
  leftHipSagittalAngle: null, rightHipSagittalAngle: null,
  leftAnkleDorsiflexion: null, rightAnkleDorsiflexion: null, ankleDorsiflexion: null,
  kneeFlexion: null, hipFlexion: null, torsoLean: null, stanceWidthRatio: null, pauseDuration: null
});
const FOOT_KEYS = Object.values(FOOT_BASELINES);
const baselineValid = (b) => b && ['baselineHipY', 'baselineFootY', 'torsoHeight', 'shoulderWidth']
  .every((key) => Number.isFinite(b[key])) && b.torsoHeight > 1e-6 && b.shoulderWidth > 1e-6 &&
  b.torsoHeight <= Math.SQRT2 && b.shoulderWidth <= Math.SQRT2 &&
  b.baselineHipY >= 0 && b.baselineHipY <= 1 && b.baselineFootY >= 0 && b.baselineFootY <= 1 &&
  // Legacy four-metric callers remain supported; partial new calibration is unsafe.
  (FOOT_KEYS.every((key) => b[key] === undefined) ||
    FOOT_KEYS.every((key) => Number.isFinite(b[key]) && b[key] >= 0 && b[key] <= 1));
const signature = (b) => b && [b.baselineHipY, b.baselineFootY, b.torsoHeight, b.shoulderWidth,
  ...FOOT_KEYS.map((key) => b[key])].join('|');

/**
 * update(imageLandmarks, baseline, timestampMs, { worldLandmarks, aspectRatio }).
 * Timestamp must be monotonic capture time in milliseconds. Threshold distances
 * and velocities are torso heights and torso heights/second respectively.
 * Metrics: seconds, degrees, meters (jumpHeight only), normalized image Y
 * (verticalDisplacement = peak rise of hips above calibrated hip position).
 * Missing frames cancel incomplete gestures; recovery requires standing still.
 */
export class GestureClassifier {
  constructor({ onActionTrigger = () => {}, onMetricsUpdate = () => {}, thresholds = {} } = {}) {
    this.onActionTrigger = onActionTrigger;
    this.onMetricsUpdate = onMetricsUpdate;
    this.config = { ...DEFAULTS, ...thresholds };
    if (Object.entries(this.config).some(([key, value]) => !(key in DEFAULTS) || !Number.isFinite(value) || value <= 0) ||
        this.config.footLift <= this.config.groundTolerance || this.config.cooldownMs < 250 ||
        this.config.minFlightMs >= this.config.maxFlightMs) throw new Error('Invalid gesture thresholds.');
    this.state = GestureState.NEUTRAL;
    this.baseline = null;
    this._lastTimestamp = null;
    this._metrics = emptyMetrics();
    this._clearMotion();
  }

  _clearMotion() {
    this._previous = null;
    this._upVelocity = 0;
    this._armed = false;
    this._neutralSince = null;
    this._candidate = null;
    this._exitSince = null;
    this._landingSince = null;
    this._jump = null;
    this._duck = null;
    this.t_takeoff = null;
    this.t_landing = null;
    this._cooldownUntil = 0;
    this.lastProvisionalAirborneTime = null;
    this.provisionalLandingCooldown = 0;
  }

  /** Recalibration/stop: release an active duck once, then forget all motion. */
  reset(baseline = null) {
    const wasDucking = this.state === GestureState.DUCKING;
    this.state = GestureState.NEUTRAL;
    this.baseline = baselineValid(baseline) ? { ...baseline } : null;
    this._baselineSignature = signature(this.baseline);
    this._lastTimestamp = null;
    this._clearMotion();
    this._metrics = emptyMetrics();
    if (wasDucking) this.onActionTrigger('DUCK_END', { source: 'safety' });
    return this._publish(false, 'Awaiting stable neutral pose');
  }

  /** Reuse the verified final calibration hold, without dispatching old actions. */
  completeCalibration(baseline, samples = []) {
    this.reset(baseline);
    if (!this.baseline || !Array.isArray(samples) || !samples.length) return this.metrics;
    const check = new GestureClassifier({ thresholds: this.config });
    let previousTimestamp = -Infinity;
    for (const sample of samples) {
      const { landmarks, frame } = sample ?? {};
      // A malformed/replayed hold must neither throw nor reuse an armed result.
      if (!frame || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp <= previousTimestamp) return this.metrics;
      previousTimestamp = frame.timestamp;
      const metrics = check.update(landmarks, baseline, frame.timestamp, frame);
      if (!metrics.valid || !metrics.neutral || metrics.state !== GestureState.NEUTRAL) return this.metrics;
    }
    if (!check.metrics.armed) return this.metrics;
    // Keep the capture-time velocity/history so the next live frame is continuous.
    this._previous = check._previous;
    this._lastTimestamp = check._lastTimestamp;
    this._upVelocity = check._upVelocity;
    this._neutralSince = check._neutralSince;
    this._armed = true;
    this._metrics = { ...check._metrics };
    return this._publish(true, null, { angleSource: check.metrics.angleSource, upwardVelocity: this._upVelocity, neutral: true });
  }

  /** DUCK_END on invalidation is a safety release, not a completed repetition. */
  invalidate(reason = 'Tracking unavailable') {
    const wasDucking = this.state === GestureState.DUCKING;
    const wasActive = this.state !== GestureState.NEUTRAL;
    this._clearMotion();
    this.state = wasActive ? GestureState.LANDING_COOLDOWN : GestureState.NEUTRAL;
    this._cooldownUntil = (this._lastTimestamp ?? 0) + this.config.cooldownMs;
    this._metrics = emptyMetrics();
    if (wasDucking) this.onActionTrigger('DUCK_END', { source: 'safety' });
    return this._publish(false, reason);
  }

  _publish(valid, reason = null, extra = {}) {
    this.metrics = Object.freeze({
      ...this._metrics, valid, reason, state: this.state, armed: this._armed,
      timestamp: this._lastTimestamp, ...extra,
      takeoffTimestamp: this.t_takeoff, landingTimestamp: this.t_landing,
      duckStartedAt: this._duck?.startedAt ?? null
    });
    this.onMetricsUpdate(this.metrics);
    return this.metrics;
  }

  _poseMetrics(points, context) {
    const aspect = Number.isFinite(context.aspectRatio) && context.aspectRatio > 0 ? context.aspectRatio : 1;
    // MediaPipe image Z scales like X. Convert XYZ to image-height units before
    // using a 3D dot product. Prefer actual model world coordinates when valid.
    const world = context.worldLandmarks;
    const useWorld = world != null;
    if (useWorld && (!Array.isArray(world) || !JOINTS.every((index) => isVisibleLandmark(world[index])))) return null;
    const joints = useWorld ? world : points.map((p) => p && ({ ...p, x: p.x * aspect, z: p.z * aspect }));
    const knee = [calculateKneeFlexion(joints[23], joints[25], joints[27]), calculateKneeFlexion(joints[24], joints[26], joints[28])];
    const hip = [calculateHipFlexion(joints[11], joints[23], joints[25]), calculateHipFlexion(joints[12], joints[24], joints[26])];
    // Optional metric geometry must not change reliable jump/duck decisions.
    // A missing world foot or degenerate heel→toe vector leaves its angle null.
    const ankle = [calculateAnkleDorsiflexion(joints[25], joints[27], joints[29], joints[31]),
      calculateAnkleDorsiflexion(joints[26], joints[28], joints[30], joints[32])];
    const signedHip = [calculateHipSagittalAngle(joints[11], joints[23], joints[25], joints[23], joints[24]),
      calculateHipSagittalAngle(joints[12], joints[24], joints[26], joints[23], joints[24])];
    if ([...knee, ...hip].some((value) => value === null)) return null;
    const midHip = midpoint(points[23], points[24], 2);
    const midKnee = midpoint(points[25], points[26], 2);
    // Torso lean uses image vertical with aspect-corrected XY, never hip-relative
    // world translation. Stance uses unscaled XY to match calibrated width.
    const midShoulder = midpoint(points[11], points[12], 2);
    const kneeFlexion = (knee[0] + knee[1]) / 2, hipFlexion = (hip[0] + hip[1]) / 2;
    const torsoLean = calculateTorsoLean({ ...midShoulder, x: midShoulder.x * aspect }, { ...midHip, x: midHip.x * aspect });
    const stanceWidthRatio = calculateStanceWidthRatio(points[27], points[28], this.baseline.shoulderWidth);
    if (torsoLean === null || stanceWidthRatio === null) return null;
    const depth = classifySquatDepth(hipFlexion, kneeFlexion, midHip.y, midKnee.y);
    return {
      hipY: midHip.y, kneeFlexion, hipFlexion, torsoLean, stanceWidthRatio,
      leftKneeFlexion: knee[0], rightKneeFlexion: knee[1], leftHipFlexion: hip[0], rightHipFlexion: hip[1],
      leftHipSagittalAngle: signedHip[0], rightHipSagittalAngle: signedHip[1],
      leftAnkleDorsiflexion: ankle[0], rightAnkleDorsiflexion: ankle[1],
      ankleDorsiflexion: ankle.every(Number.isFinite) ? (ankle[0] + ankle[1]) / 2 : null,
      ...depth, squatDepth: depth.depthCategory, // Preserve the existing metrics alias.
      angleSource: useWorld ? 'world-3d' : 'image-3d-estimate'
    };
  }

  update(points, baseline, timestamp = performance.now(), context = {}) {
    if (!Number.isFinite(timestamp) || timestamp < 0) return this.invalidate('Invalid frame timestamp');
    if (!baselineValid(baseline)) { this.reset(); return this.metrics; }
    if (signature(baseline) !== this._baselineSignature) this.reset(baseline);
    // Ignore duplicate/out-of-order frames; never calculate a negative dt.
    if (this._lastTimestamp !== null && timestamp <= this._lastTimestamp) return this.metrics;
    const previousTimestamp = this._lastTimestamp;
    this._lastTimestamp = timestamp;
    if (!Array.isArray(points) || !REQUIRED.every((index) => isVisibleLandmark(points[index], 2) &&
        points[index].x >= 0 && points[index].x <= 1 && points[index].y >= 0 && points[index].y <= 1)) {
      return this.invalidate('Required landmarks are missing or below 0.65 visibility');
    }
    if (previousTimestamp !== null && timestamp - previousTimestamp > this.config.maxFrameGapMs) {
      this.invalidate('Frame gap — motion history discarded');
    }
    const pose = this._poseMetrics(points, context ?? {});
    if (!pose) return this.invalidate('Joint geometry is unavailable');
    const c = this.config, b = this.baseline;
    const dt = this._previous ? timestamp - this._previous.time : 0;
    if (dt > 0) {
      const velocity = (this._previous.hipY - pose.hipY) / (dt / 1000) / b.torsoHeight;
      if (!Number.isFinite(velocity)) return this.invalidate('Invalid frame interval — motion history discarded');
      const alpha = 1 - Math.exp(-dt / c.velocityTimeConstantMs);
      this._upVelocity += alpha * (velocity - this._upVelocity);
    }
    this._previous = { hipY: pose.hipY, time: timestamp };
    const drop = (pose.hipY - b.baselineHipY) / b.torsoHeight;
    const tolerance = groundContactTolerance(b, c.groundTolerance);
    const footRise = (index) => (b[FOOT_BASELINES[index]] ?? b.baselineFootY) - points[index].y;
    const contact = (index) => Math.abs(footRise(index)) <= tolerance;
    const leftGround = contact(29) || contact(31), rightGround = contact(30) || contact(32);
    const bothGround = leftGround && rightGround, anyGround = leftGround || rightGround;
    // Keep takeoff strictly above contact even when the absolute tolerance dominates.
    const liftThreshold = Math.max(c.footLift * b.torsoHeight, tolerance + 0.02 * b.torsoHeight);
    const airborne = [29, 30, 31, 32].every((index) => footRise(index) > liftThreshold);
    const neutral = bothGround && Math.abs(drop) <= c.neutralHipTolerance &&
      pose.kneeFlexion < c.neutralKneeFlexion && Math.abs(this._upVelocity) <= c.stillVelocity;
    const { hipY, angleSource, ...live } = pose;
    Object.assign(this._metrics, live);

    // Even a sub-debounce flight can end in an impact bend. Remember observed
    // foot clearance independently of hip speed/action confirmation, then recover
    // through the same neutral gate as a confirmed jump (no invented jump metrics).
    if (this.state === GestureState.NEUTRAL) {
      if ([29, 30, 31, 32].every((index) => footRise(index) > tolerance)) {
        this.lastProvisionalAirborneTime = timestamp;
      } else if (anyGround && this.lastProvisionalAirborneTime !== null) {
        this.provisionalLandingCooldown = timestamp + c.cooldownMs;
        this._cooldownUntil = this.provisionalLandingCooldown;
        this.state = GestureState.LANDING_COOLDOWN;
        this._armed = false;
        this._candidate = null;
        this._neutralSince = null;
      }
    }

    // Exactly one state branch per frame. Returning from duck/cooldown cannot
    // evaluate a second action trigger during the same update.
    switch (this.state) {
      case GestureState.NEUTRAL: {
        if (!this._armed) {
          if (this._heldNeutral(neutral, timestamp)) this._armed = true;
          break;
        }
        const jump = airborne && this._upVelocity > c.jumpVelocity;
        const duck = bothGround && drop > c.duckDrop && pose.kneeFlexion > c.duckKneeFlexion;
        const kind = jump ? 'JUMP' : duck ? 'DUCK_START' : null;
        if (!kind) { this._candidate = null; break; }
        if (this._candidate?.kind !== kind) this._candidate = { kind, since: timestamp, peakY: hipY };
        this._candidate.peakY = Math.min(this._candidate.peakY, hipY);
        const requiredMs = jump ? c.jumpDebounceMs : c.duckDebounceMs;
        if (timestamp - this._candidate.since < requiredMs) break;
        this._armed = false;
        this._neutralSince = null;
        if (jump) {
          this.state = GestureState.JUMPING;
          this.lastProvisionalAirborneTime = null;
          this.t_takeoff = this._candidate.since; // First qualifying frame, not end of debounce.
          this.t_landing = null;
          this._jump = { peakY: this._candidate.peakY };
          this._metrics.flightTime = null;
          this._metrics.jumpHeight = null;
          this._metrics.verticalDisplacement = Math.max(0, b.baselineHipY - this._jump.peakY);
        } else {
          this.state = GestureState.DUCKING;
          this._duck = { startedAt: this._candidate.since, deepestY: hipY, pauseDepth: hipY, pauseStart: null, pauseTotal: 0 };
          this._metrics.pauseDuration = 0;
        }
        this._candidate = null;
        this.onActionTrigger(kind, { source: 'pose', timestamp });
        break;
      }
      case GestureState.JUMPING: {
        this._jump.peakY = Math.min(this._jump.peakY, hipY);
        this._metrics.verticalDisplacement = Math.max(0, b.baselineHipY - this._jump.peakY);
        const elapsed = timestamp - this.t_takeoff;
        if (elapsed > c.maxFlightMs) return this.invalidate('Flight not completed — metrics discarded');
        // Contact must persist and occur after takeoff, while no longer rising.
        if (anyGround && elapsed >= c.minFlightMs && this._upVelocity <= c.stillVelocity) {
          this._landingSince ??= timestamp;
          if (timestamp - this._landingSince >= c.landingDebounceMs) {
            this.t_landing = this._landingSince;
            this._metrics.flightTime = (this.t_landing - this.t_takeoff) / 1000;
            this._metrics.jumpHeight = estimateJumpHeight(this._metrics.flightTime);
            this._cooldownUntil = timestamp + c.cooldownMs;
            this.state = GestureState.LANDING_COOLDOWN;
            this._neutralSince = null;
            this._jump = null;
          }
        } else this._landingSince = null;
        break;
      }
      case GestureState.DUCKING: {
        if (!bothGround) return this.invalidate('Feet left the ground during duck — action cancelled');
        this._updatePause(hipY, timestamp);
        if (bothGround && Math.abs(drop) <= c.neutralHipTolerance) {
          this._exitSince ??= timestamp;
          if (timestamp - this._exitSince >= c.exitDebounceMs) {
            this.state = GestureState.NEUTRAL;
            this._duck = null;
            this._exitSince = null;
            this._neutralSince = null;
            this.onActionTrigger('DUCK_END', { source: 'pose', timestamp });
          }
        } else this._exitSince = null;
        break;
      }
      case GestureState.LANDING_COOLDOWN:
        // A prolonged landing knee bend is STILL recovery, even after 250ms.
        if (this._heldNeutral(neutral, timestamp) && timestamp >= this._cooldownUntil) {
          this.state = GestureState.NEUTRAL;
          this._armed = true;
          this._candidate = null;
          this.lastProvisionalAirborneTime = null;
          this.provisionalLandingCooldown = 0;
        }
        break;
    }
    return this._publish(true, null, { angleSource, upwardVelocity: this._upVelocity, neutral });
  }

  _heldNeutral(neutral, timestamp) {
    if (!neutral) { this._neutralSince = null; return false; }
    this._neutralSince ??= timestamp;
    return timestamp - this._neutralSince >= this.config.neutralHoldMs;
  }

  _updatePause(hipY, timestamp) {
    const d = this._duck, c = this.config, tolerance = c.pauseDepthTolerance * this.baseline.torsoHeight;
    d.deepestY = Math.max(d.deepestY, hipY);
    // If the user goes appreciably deeper, discard pauses at shallower depths.
    if (d.deepestY - d.pauseDepth > tolerance) {
      d.pauseTotal = 0;
      d.pauseStart = null;
      d.pauseDepth = d.deepestY;
    }
    const atBottom = Math.abs(hipY - d.deepestY) <= tolerance && Math.abs(this._upVelocity) <= c.stillVelocity;
    if (atBottom) {
      d.pauseStart ??= timestamp;
      d.pauseLast = timestamp;
    }
    else if (d.pauseStart !== null) {
      const duration = d.pauseLast - d.pauseStart;
      if (duration >= c.pauseDebounceMs) d.pauseTotal += duration;
      d.pauseStart = null;
    }
    const pending = d.pauseStart === null ? 0 : timestamp - d.pauseStart;
    this._metrics.pauseDuration = (d.pauseTotal + (pending >= c.pauseDebounceMs ? pending : 0)) / 1000;
  }
}
