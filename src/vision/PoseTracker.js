import { Pose } from '@mediapipe/pose';
import { Camera } from '@mediapipe/camera_utils';
import { GestureClassifier, FOOT_BASELINES, groundContactTolerance } from './GestureClassifier.js';

// Match the pinned package version. Override assetBaseUrl to self-host assets.
const ASSETS = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404';
export const POSE_TIMEOUTS = Object.freeze({ MODEL: 30000, CAMERA: 30000, PLAY: 10000, INFERENCE: 5000, CLEANUP: 1000 });

// Cancellation settles our callers even when a browser/SDK promise never does.
// Always attach both settlement handlers so late rejection is also consumed.
function bounded(operation, timeoutMs, label, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, Object.assign(new Error('Camera operation cancelled.'), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(reject, new Error(`${label} timed out. Click Start camera to retry.`)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal?.aborted) cancel();
  });
}
const REQUIRED = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32]
];
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Client-side WASM/WebGL pose inference. The CDN supplies model/runtime assets,
 * never webcam frames. Baseline distances are normalized image units, not meters.
 * onPoseUpdate gets filtered landmarks only AFTER calibration. Null landmarks
 * mean tracking is invalid: clear motion history; do not infer any game action.
 * Invisible non-required landmarks are null within an otherwise valid array.
 * A third callback argument provides capture timestamp, aspectRatio and filtered
 * worldLandmarks for joint angles. World coordinates must not measure jumps:
 * their origin follows the hips, unlike image coordinates used for calibration.
 */
export class PoseTracker {
  constructor(videoElement, canvasElement, {
    onPoseUpdate = () => {}, onStatusChange = () => {},
    onCalibrationComplete = () => {}, onFrameMetrics = () => {}, onStreamStateChange = () => {}, visibilityThreshold = 0.65,
    emaAlpha = 0.4, assetBaseUrl = ASSETS
  } = {}) {
    if (!videoElement || !canvasElement) throw new Error('Video and canvas elements are required.');
    if (!(visibilityThreshold >= 0.65 && visibilityThreshold <= 1) || !(emaAlpha > 0 && emaAlpha <= 1)) {
      throw new Error('Visibility must be 0.65–1 and EMA alpha must be greater than 0 and at most 1.');
    }
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    if (!this.ctx) throw new Error('A 2D canvas context is unavailable.');
    Object.assign(this, { onPoseUpdate, onStatusChange, onCalibrationComplete, onFrameMetrics, onStreamStateChange, visibilityThreshold, emaAlpha });
    this.assetBaseUrl = assetBaseUrl.replace(/\/$/, '');
    this.baseline = null;
    this.isRunning = false;
    this._generation = 0;
    this._smoothed = null;
    this._calibration = null;
    this._inputValid = false;
    this._lastResultAt = null;
    this._status = '';
    this._trackListeners = [];
    this._frameSequence = 0;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
  }

  /** Call from a user gesture. Concurrent calls share one startup operation. */
  async init() {
    if (this._stopPromise) await this._stopPromise;
    if (this._startPromise) return this._startPromise;
    if (this.isRunning) return;
    const generation = ++this._generation;
    const session = this._session = { generation, controller: new AbortController(), listeners: [] };
    this._trackListeners = session.listeners;
    this.isRunning = true;
    const start = this._startPromise = this._start(session);
    try { await start; } finally { if (this._startPromise === start) this._startPromise = null; }
  }

  async _start(session) {
    const { generation, controller } = session;
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Open this app on HTTPS or localhost to use the webcam.');
      }
      if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is unavailable in this browser.');
      this._setStatus('Loading pose model…');
      this.baseline = null;
      this._invalidate();
      const pose = new Pose({ locateFile: (file) => `${this.assetBaseUrl}/${file}` });
      this.pose = session.pose = pose;
      pose.setOptions({
        modelComplexity: 0, smoothLandmarks: false, enableSegmentation: false,
        minDetectionConfidence: 0.65, minTrackingConfidence: 0.65
      });
      // Use one explicit EMA below rather than stacking two smoothing filters.
      pose.onResults((results) => {
        if (!this._isActive(generation)) return;
        // Stop inference timing BEFORE any drawing, filtering or game callbacks.
        const inferenceEndedAt = performance.now();
        if (this._currentFrame && !this._currentFrame.completed) {
          this._currentFrame.completed = true;
          this._currentFrame.inferenceEndedAt = inferenceEndedAt;
          this.onFrameMetrics({
            ...this._currentFrame,
            stale: inferenceEndedAt - this._currentFrame.capturedAt > 500
          });
        }
        // A very slow inference can finish after tracking was invalidated.
        if (inferenceEndedAt - (this._currentFrame?.capturedAt ?? this._frameStartedAt ?? inferenceEndedAt) > 500) {
          this._invalidate('Pose frame delayed — waiting for fresh input.');
          this._draw(results.image, null);
          return;
        }
        this._handleResults(results);
      });
      session.work = pose.initialize();
      session.workKind = 'model';
      await bounded(session.work, POSE_TIMEOUTS.MODEL, 'Pose model loading', controller.signal);
      if (!this._isActive(generation)) return;
      session.work = null;
      this._setStatus('Allow camera access; keep your whole body in view.');
      const onFrame = async (_now, metadata = {}) => {
        if (!this._isActive(generation) || session.sendPromise || document.hidden || this.video.readyState < 2) return;
        try {
          this._frameStartedAt = performance.now();
          // Metadata uses the same monotonic origin as performance.now(). Most
          // browsers omit captureTime; never present a fallback as sensor time.
          const available = (value) => Number.isFinite(value) && value >= 0 && value <= this._frameStartedAt;
          const captureSource = available(metadata.captureTime) ? 'camera-capture'
            : available(metadata.presentationTime) ? 'video-presentation' : 'frame-acquisition';
          const capturedAt = captureSource === 'camera-capture' ? metadata.captureTime
            : captureSource === 'video-presentation' ? metadata.presentationTime : this._frameStartedAt;
          this._currentFrame = session.frame = {
            frameId: ++this._frameSequence, capturedAt, captureSource,
            inferenceStartedAt: performance.now()
          };
          this._sendPromise = session.work = session.sendPromise = pose.send({ image: this.video });
          session.workKind = 'inference';
          await bounded(session.sendPromise, POSE_TIMEOUTS.INFERENCE, 'Pose inference', controller.signal);
        } catch (error) {
          if (this._isActive(generation)) this._fail(error);
        } finally {
          session.sendPromise = null;
          session.frame = null;
          if (this._isActive(generation)) {
            session.work = null;
            this._sendPromise = null;
            this._currentFrame = null;
          }
        }
      };
      // The SDK cannot cancel getUserMedia. Isolate acquisition on a private
      // video so a late permission grant can never replace a restarted stream.
      const capture = session.capture = document.createElement('video');
      capture.muted = true;
      capture.playsInline = true;
      this.camera = session.camera = new Camera(capture, { width: 640, height: 480, facingMode: 'user', onFrame });
      const cameraStart = session.camera.start();
      // This microtask precedes loadedmetadata's task. Never launch the SDK's
      // uncancellable RAF loop, including when acquisition finishes after stop.
      const acquired = Promise.resolve(cameraStart).then(() => {
        capture.onloadedmetadata = null;
        if (controller.signal.aborted) this._releaseCapture(session);
      });
      await bounded(acquired, POSE_TIMEOUTS.CAMERA, 'Camera permission/acquisition', controller.signal);
      if (!this._isActive(generation)) return;
      const tracks = capture.srcObject?.getVideoTracks() ?? [];
      if (!tracks.length || tracks.every((track) => track.readyState === 'ended')) {
        throw new Error('The webcam could not start. Check camera permissions and retry.');
      }
      session.stream = capture.srcObject;
      this.video.srcObject = session.stream;
      this.video.onloadedmetadata = null;
      for (const track of tracks) {
        const ended = () => {
          if (this._isActive(generation)) this._fail(new Error('Camera disconnected. Reconnect it and click Start camera.'));
        };
        track.addEventListener('ended', ended);
        session.listeners.push([track, ended]);
      }
      await bounded(this.video.play(), POSE_TIMEOUTS.PLAY, 'Camera playback', controller.signal);
      if (!this._isActive(generation)) return;
      this.onStreamStateChange({ active: true, settings: tracks[0].getSettings?.() ?? {} });
      this._lastResultAt = performance.now();
      this.recalibrate();
      let lastVideoTime = -1;
      const useVideoCallback = typeof this.video.requestVideoFrameCallback === 'function';
      const schedule = () => {
        if (useVideoCallback) this._videoFrameId = session.videoFrameId = this.video.requestVideoFrameCallback(tick);
        else this._frameId = session.frameId = requestAnimationFrame(tick);
      };
      const tick = async (now, metadata) => {
        if (!this._isActive(generation)) return;
        if (useVideoCallback || this.video.currentTime !== lastVideoTime) {
          lastVideoTime = this.video.currentTime;
          await onFrame(now, metadata); // One in-flight inference; never queue stale frames.
        }
        if (this._isActive(generation)) schedule();
      };
      schedule();
      this._watchdog = session.watchdog = setInterval(() => {
        if (!this._isActive(generation)) return;
        if (document.hidden || performance.now() - this._lastResultAt > 500) {
          this._invalidate(document.hidden ? 'Paused — return to this tab.' : 'Waiting for fresh camera frames…');
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
      }, 250);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (this._isActive(generation)) {
        this.isRunning = false;
        this.onStreamStateChange({ active: false });
        this._invalidate();
        this._setStatus(`Camera error: ${this._errorMessage(error)}`);
      }
      await this._release(session);
      // Stop is successful cancellation, not a camera permission failure.
      if (!cancelled) throw error;
    }
  }

  _isActive(generation) { return this.isRunning && generation === this._generation; }

  _setStatus(text) {
    if (text === this._status) return;
    this._status = text;
    this.onStatusChange(text);
  }

  /** Require a new uninterrupted 3-second standing hold. */
  recalibrate() {
    this.baseline = null;
    this._invalidate(undefined, true);
    this._setStatus('Calibration — face the camera, stand upright and hold still for 3s.');
  }

  _invalidate(status, force = false) {
    this._smoothed = null;
    this._smoothedWorld = null;
    this._calibration = null;
    if (this._inputValid || force) {
      this._inputValid = false;
      this.onPoseUpdate(null, this.baseline);
    }
    if (status) this._setStatus(status);
  }

  _visible(point) {
    return point != null && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      Number.isFinite(point.visibility) && point.visibility >= this.visibilityThreshold && point.visibility <= 1 &&
      point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
  }

  _filter(landmarks, dt, world = false) {
    // Time-adjusted EMA gives approximately equal lag at 30 and 60 FPS.
    const alpha = 1 - (1 - this.emaAlpha) ** (Math.max(1, dt) / (1000 / 30));
    const key = world ? '_smoothedWorld' : '_smoothed';
    const previous = this[key];
    this[key] = landmarks.map((point, index) => {
      const visible = world
        ? point && ['x', 'y', 'z', 'visibility'].every((axis) => Number.isFinite(point[axis])) &&
          point.visibility >= this.visibilityThreshold && point.visibility <= 1
        : this._visible(point);
      if (!visible) return null;
      const old = previous?.[index];
      const next = { ...point };
      if (old) {
        for (const axis of ['x', 'y', 'z']) {
          if (Number.isFinite(point[axis]) && Number.isFinite(old[axis])) {
            next[axis] = (1 - alpha) * old[axis] + alpha * point[axis];
          }
        }
      }
      // Never smooth visibility or preserve an invisible landmark.
      return next;
    });
    return this[key];
  }

  _handleResults(results) {
    if (document.hidden) { this._invalidate('Paused — return to this tab.'); return; }
    const now = performance.now();
    const dt = this._lastResultAt == null ? 1000 / 30 : now - this._lastResultAt;
    this._lastResultAt = now;
    if (dt > 500) this._invalidate();
    const raw = results?.poseLandmarks;
    // Gate raw confidence BEFORE EMA so a previously confident leg cannot leak.
    if (!Array.isArray(raw) || !REQUIRED.every((index) => this._visible(raw[index]))) {
      this._invalidate('Tracking lost — show shoulders, hips, knees and both feet.');
      this._draw(results?.image, null);
      return;
    }
    if (results.poseWorldLandmarks != null && !Array.isArray(results.poseWorldLandmarks)) {
      this._invalidate('Tracking lost — joint geometry unavailable.');
      this._draw(results.image, null);
      return;
    }
    const landmarks = this._filter(raw, dt);
    const world = results.poseWorldLandmarks?.map((point, index) => point && ({
      ...point,
      visibility: Math.min(point.visibility ?? raw[index]?.visibility ?? 0, raw[index]?.visibility ?? 0)
    }));
    const worldLandmarks = world ? this._filter(world, dt, true) : null;
    if (!world) this._smoothedWorld = null;
    this._draw(results.image, landmarks);
    const frame = {
      ...this._currentFrame,
      timestamp: this._currentFrame?.capturedAt ?? this._frameStartedAt ?? now,
      aspectRatio: (this.video.videoWidth || 640) / (this.video.videoHeight || 480),
      worldLandmarks: worldLandmarks?.map((point) => point && { ...point }) ?? null
    };
    if (!this.baseline) this._calibrate(raw, landmarks, now, frame);
    if (!this.baseline) return;
    this._setStatus('Tracking — calibrated');
    this._inputValid = true;
    // Consumers cannot mutate the filter's history.
    this.onPoseUpdate(landmarks.map((point) => point && { ...point }), this.baseline, frame);
  }

  _measure(landmarks) {
    const hip = midpoint(landmarks[23], landmarks[24]);
    const shoulder = midpoint(landmarks[11], landmarks[12]);
    return {
      baselineHipY: hip.y,
      baselineFootY: [29, 30, 31, 32].reduce((sum, index) => sum + landmarks[index].y, 0) / 4,
      ...Object.fromEntries(Object.entries(FOOT_BASELINES).map(([index, key]) => [key, landmarks[index].y])),
      torsoHeight: distance(shoulder, hip),
      shoulderWidth: distance(landmarks[11], landmarks[12])
    };
  }

  _standing(landmarks, metrics) {
    const shoulder = midpoint(landmarks[11], landmarks[12]);
    const hip = midpoint(landmarks[23], landmarks[24]);
    // Image-plane sanity checks, not a medical posture assessment.
    if (metrics.torsoHeight < 0.06 || metrics.shoulderWidth < 0.04 ||
        hip.y - shoulder.y < metrics.torsoHeight * 0.85 ||
        Math.abs(landmarks[11].y - landmarks[12].y) > metrics.shoulderWidth * 0.4) return false;
    const aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    return [[23, 25, 27], [24, 26, 28]].every(([h, k, a]) => {
      const [hipPoint, knee, ankle] = [landmarks[h], landmarks[k], landmarks[a]];
      if (knee.y - hipPoint.y < 0.04 || ankle.y - knee.y < 0.04) return false;
      const u = { x: (hipPoint.x - knee.x) * aspect, y: hipPoint.y - knee.y };
      const v = { x: (ankle.x - knee.x) * aspect, y: ankle.y - knee.y };
      const cosine = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
      return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI >= 160;
    });
  }

  _calibrate(raw, filtered, now, frame) {
    const rawMetrics = this._measure(raw);
    if (!this._standing(raw, rawMetrics)) {
      this._calibration = null;
      this._smoothed = null;
      this._setStatus('Calibration reset — stand upright with straight legs, facing the camera.');
      return;
    }
    let sample = this._calibration;
    // Anchor to the start of the hold; slow cumulative drift must also reset it.
    if (sample && REQUIRED.some((index) => distance(raw[index], sample.anchor[index]) > sample.torsoHeight * 0.1)) {
      this._calibration = null;
      this._smoothed = null;
      this._setStatus('Calibration reset — movement detected. Hold still for 3s.');
      return;
    }
    if (!sample) {
      sample = this._calibration = {
        startedAt: now, lastAt: -Infinity, count: 0,
        anchor: raw.map((point) => point && { ...point }), torsoHeight: rawMetrics.torsoHeight,
        totals: Object.fromEntries(Object.keys(rawMetrics).map((key) => [key, 0])),
        footNoise: Object.fromEntries(Object.keys(FOOT_BASELINES).map((index) => [index, { mean: 0, m2: 0 }])),
        recent: []
      };
    }
    if (now <= sample.lastAt) return;
    const metrics = this._measure(filtered);
    for (const key of Object.keys(sample.totals)) sample.totals[key] += metrics[key];
    sample.count += 1;
    sample.lastAt = now;
    // Welford's online variance measures raw jitter, not EMA-reduced noise.
    for (const [index, noise] of Object.entries(sample.footNoise)) {
      const delta = raw[index].y - noise.mean;
      noise.mean += delta / sample.count;
      noise.m2 += delta * (raw[index].y - noise.mean);
    }
    sample.recent.push({ landmarks: filtered.map((point) => point && { ...point }), frame });
    sample.recent = sample.recent.filter((item) => item.frame.timestamp >= frame.timestamp - 300).slice(-64);
    const remaining = Math.max(0, 3000 - (now - sample.startedAt));
    this._setStatus(`Calibrating — hold still: ${Math.max(1, Math.ceil(remaining / 1000))}s`);
    // Require fresh frames, 3 continuous seconds and at least 30 observations.
    if (remaining > 0 || sample.count < 30) return;
    const baseline = Object.fromEntries(
      Object.entries(sample.totals).map(([key, total]) => [key, total / sample.count])
    );
    baseline.footYStdDev = Object.freeze(Object.fromEntries(Object.entries(sample.footNoise)
      .map(([index, noise]) => [index, Math.sqrt(Math.max(0, noise.m2 / (sample.count - 1)))])));
    baseline.footYNoiseEnvelope = Object.freeze(Object.fromEntries(Object.entries(baseline.footYStdDev)
      .map(([index, deviation]) => [index, 3 * deviation])));
    // Verify the SAME neutral/contact/visibility criteria as live control. A
    // calibration that cannot arm must not report success and freeze the game.
    const check = new GestureClassifier();
    const neutral = check.completeCalibration(baseline, sample.recent);
    if (!neutral.armed || Object.values(baseline.footYNoiseEnvelope).some((noise) => noise > groundContactTolerance(baseline))) {
      this._calibration = null;
      this._smoothed = this._smoothedWorld = null;
      this._setStatus('Calibration reset — neutral self-check failed. Stand still with both feet flat.');
      return;
    }
    this.baseline = Object.freeze(baseline);
    this._calibration = null;
    // Optional second argument lets the controller reuse this already-held pose.
    this.onCalibrationComplete(this.baseline, sample.recent);
  }

  _draw(image, landmarks) {
    const width = this.video.videoWidth || 640;
    const height = this.video.videoHeight || 480;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    if (image) ctx.drawImage(image, 0, 0, width, height);
    if (!landmarks) return;
    // Existing CSS mirrors video and connectors together; keep coordinates raw.
    ctx.strokeStyle = '#38bdf8';
    ctx.fillStyle = '#22c55e';
    ctx.lineWidth = Math.max(2, width / 250);
    for (const [from, to] of CONNECTIONS) {
      const a = landmarks[from], b = landmarks[to];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }
    for (const index of REQUIRED) {
      const point = landmarks[index];
      if (!point) continue;
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, Math.max(3, width / 160), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _errorMessage(error) {
    const messages = {
      NotAllowedError: 'Camera access denied. Allow it in browser settings, then retry.',
      PermissionDeniedError: 'Camera access denied. Allow it in browser settings, then retry.',
      NotFoundError: 'No webcam found. Connect a camera and retry.',
      NotReadableError: 'Camera is unavailable or busy in another app. Close that app and retry.',
      OverconstrainedError: 'The camera cannot supply the requested video settings.',
      SecurityError: 'Camera access is blocked. Use HTTPS or localhost and allow the camera.'
    };
    return messages[error?.name] ?? `${error?.message || 'Pose runtime failed.'} Check the connection and WebGL support, then retry.`;
  }

  _fail(error) {
    // Do not await shutdown from inside the operation being cancelled.
    void this.stop(`Camera error: ${this._errorMessage(error)}`);
  }

  async stop(status = 'Camera stopped — click Start camera.') {
    if (this._stopPromise) return this._stopPromise;
    this.isRunning = false;
    this.onStreamStateChange({ active: false });
    this._generation += 1;
    this.baseline = null;
    this._invalidate(undefined, true);
    this._setStatus(status);
    const stopped = this._stopPromise = this._release(this._session);
    try { await stopped; } finally { if (this._stopPromise === stopped) this._stopPromise = null; }
  }

  _releaseCapture(session) {
    const capture = session.capture;
    if (!capture) return;
    capture.onloadedmetadata = null;
    for (const track of capture.srcObject?.getTracks() ?? []) track.stop();
    capture.srcObject = null;
    capture.pause();
  }

  /** Detach synchronously; bound SDK disposal and isolate every late completion. */
  async _release(session) {
    if (!session) { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }
    if (session.releasePromise) return session.releasePromise;
    session.controller.abort();
    cancelAnimationFrame(session.frameId);
    if (session.videoFrameId != null) this.video.cancelVideoFrameCallback?.(session.videoFrameId);
    clearInterval(session.watchdog);
    for (const [track, listener] of session.listeners) track.removeEventListener('ended', listener);
    session.listeners.length = 0;
    // Neither HMR nor a late previous-session cleanup may clear a new stream.
    if (session.stream && this.video.srcObject === session.stream) {
      for (const track of session.stream.getTracks()) track.stop();
      this.video.srcObject = null;
      this.video.onloadedmetadata = null;
      this.video.pause();
    }
    this._releaseCapture(session);
    if (this._session === session) {
      this._session = null;
      this.camera = this.pose = this._sendPromise = this._currentFrame = null;
      this._frameStartedAt = this._lastResultAt = null;
      this._frameId = this._videoFrameId = this._watchdog = null;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    const dispose = (resource) => {
      try { return Promise.resolve(resource?.()).catch((error) => console.warn('SDK cleanup:', error)); }
      catch (error) { console.warn('SDK cleanup:', error); return Promise.resolve(); }
    };
    const cameraStop = dispose(session.camera && (() => session.camera.stop()));
    session.releasePromise = (async () => {
      let workSettled = true;
      if (session.work) {
        await bounded(session.work, POSE_TIMEOUTS.CLEANUP, 'Pending pose operation')
          .catch(() => { workSettled = false; });
      }
      const close = () => dispose(session.pose && (() => session.pose.close()));
      const poseClose = close();
      // A cancelled initialize can allocate its graph AFTER early close. Dispose
      // that late graph too; this continuation owns only the old session.
      if (!workSettled && session.workKind === 'model') {
        Promise.resolve(session.work).then(() => bounded(close(), POSE_TIMEOUTS.CLEANUP, 'Late model cleanup').catch(() => {}), () => {});
      }
      await bounded(Promise.all([cameraStop, poseClose]), POSE_TIMEOUTS.CLEANUP, 'SDK cleanup').catch(() => {});
    })();
    return session.releasePromise;
  }
}
