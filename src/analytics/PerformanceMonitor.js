const clock = () => performance.now();
const average = (sum, count) => count ? sum / count : null;
const CAPTURE_SOURCES = ['camera-capture', 'video-presentation', 'frame-acquisition'];

/** Browser-reported hints, not a claim that the CPU/GPU model is identifiable. */
export function getHardwareProfile(nav = globalThis.navigator) {
  return {
    userAgent: nav?.userAgent ?? 'Unavailable',
    platform: nav?.userAgentData?.platform ?? nav?.platform ?? 'Unavailable',
    logicalCores: nav?.hardwareConcurrency ?? null,
    approximateMemoryGiB: nav?.deviceMemory ?? null,
    note: 'Browser values may be reduced for privacy. Add CPU, GPU, RAM and OS version in hardwareNotes.'
  };
}

/**
 * One monotonic clock (performance.now()) for every stage. No DOM or timers.
 * recordInference runs at onResults ENTRY, before drawing/classification.
 * recordAction runs only AFTER Phaser accepts a command from that exact frame.
 * Session aggregates use constant space; the live window holds at most 240 frames.
 */
export class PerformanceMonitor {
  constructor({ now = clock, windowMs = 2000, staleAfterMs = 1000, hardwareProfile = getHardwareProfile() } = {}) {
    if (![windowMs, staleAfterMs].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Timing windows must be finite and positive.');
    Object.assign(this, { now, windowMs, staleAfterMs, hardwareProfile });
    this.active = false;
    this.camera = null;
    this.reset();
  }

  /** Start a new measurement after warm-up without restarting the camera/game. */
  reset() {
    this.startedAt = this.now();
    this._activeSince = this.active ? this.startedAt : null;
    this._activeMs = 0;
    this._windowFloor = this.startedAt;
    this._frames = [];
    this._lastFrame = null;
    this._lastAction = null;
    this._frameCount = this._inferenceTotal = this._actionCount = this._actionTotal = 0;
    this._maxInference = this._maxAction = null;
    this._staleCount = 0;
    this._captureSources = Object.fromEntries(CAPTURE_SOURCES.map((source) => [source, 0]));
    this._actionCounts = { JUMP: 0, DUCK_START: 0, DUCK_END: 0 };
  }

  /** Exclude stopped/hidden time. Visible stream stalls still reduce average FPS. */
  setActive(active) {
    active = Boolean(active);
    if (active === this.active) return;
    const now = this.now();
    if (this.active) this._activeMs += Math.max(0, now - this._activeSince);
    this.active = active;
    this._activeSince = active ? now : null;
    this._windowFloor = now;
    this._frames = [];
    this._lastFrame = this._lastAction = null;
  }

  setCameraSettings(settings = {}) {
    // Avoid persisting camera device/group identifiers in reports.
    this.camera = Object.fromEntries(['width', 'height', 'frameRate', 'facingMode']
      .filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
  }

  recordInference(frame) {
    const { frameId, capturedAt, inferenceStartedAt, inferenceEndedAt, captureSource } = frame ?? {};
    if (!this.active || !Number.isInteger(frameId) || frameId < 1 ||
        ![capturedAt, inferenceStartedAt, inferenceEndedAt].every(Number.isFinite) ||
        capturedAt < this._activeSince || inferenceStartedAt < capturedAt || inferenceEndedAt < inferenceStartedAt ||
        inferenceEndedAt > this.now() || !CAPTURE_SOURCES.includes(captureSource) ||
        (this._lastFrame && (frameId <= this._lastFrame.frameId || inferenceEndedAt <= this._lastFrame.inferenceEndedAt))) return false;
    const inferenceMs = inferenceEndedAt - inferenceStartedAt;
    const sample = { frameId, capturedAt, inferenceStartedAt, inferenceEndedAt, captureSource, inferenceMs, stale: Boolean(frame.stale), actionRecorded: false };
    this._lastFrame = sample;
    this._frames.push(sample);
    this._prune(inferenceEndedAt);
    this._frameCount++;
    this._inferenceTotal += inferenceMs;
    this._maxInference = Math.max(this._maxInference ?? 0, inferenceMs);
    this._captureSources[captureSource]++;
    if (frame.stale) this._staleCount++;
    return true;
  }

  /** Rejected commands and safety releases must never be passed here. */
  recordAction(action, frame, updatedAt = this.now()) {
    const sample = this._lastFrame;
    if (!this.active || !Object.hasOwn(this._actionCounts, action) || !sample || sample.stale || sample.actionRecorded ||
        frame?.frameId !== sample.frameId || frame?.capturedAt !== sample.capturedAt ||
        !Number.isFinite(updatedAt) || updatedAt < sample.inferenceEndedAt || updatedAt > this.now()) return false;
    const latencyMs = updatedAt - sample.capturedAt;
    sample.actionRecorded = true;
    this._lastAction = { action, latencyMs, captureSource: sample.captureSource };
    this._actionCount++;
    this._actionCounts[action]++;
    this._actionTotal += latencyMs;
    this._maxAction = Math.max(this._maxAction ?? 0, latencyMs);
    return true;
  }

  _prune(now) {
    while (this._frames.length && this._frames[0].inferenceEndedAt <= now - this.windowMs) this._frames.shift();
    if (this._frames.length > 240) {
      // If a >120 FPS source fills the cap, shorten the actual sample window;
      // dividing 240 retained frames by a fixed 2 s would underreport throughput.
      const removed = this._frames.splice(0, this._frames.length - 240);
      this._windowFloor = removed.at(-1).inferenceEndedAt;
    }
  }

  getLiveMetrics() {
    const now = this.now();
    this._prune(now);
    const fresh = this.active && this._lastFrame && now - this._lastFrame.inferenceEndedAt <= this.staleAfterMs;
    const duration = this.active ? Math.min(this.windowMs, Math.max(0, now - this._windowFloor)) : 0;
    return {
      active: this.active,
      cameraFps: fresh && duration > 0 ? this._frames.length * 1000 / duration : 0,
      inferenceMs: fresh ? average(this._frames.reduce((sum, frame) => sum + frame.inferenceMs, 0), this._frames.length) : null,
      actionLatencyMs: this._lastAction?.latencyMs ?? null,
      lastAction: this._lastAction?.action ?? null,
      // The action's source takes precedence: it describes the displayed latency.
      captureSource: this._lastAction?.captureSource ?? (fresh ? this._lastFrame.captureSource : null)
    };
  }

  getSummary(hardwareNotes = '') {
    const activeMs = this._activeMs + (this.active ? Math.max(0, this.now() - this._activeSince) : 0);
    return {
      schemaVersion: 1,
      reportedAt: new Date().toISOString(),
      model: { name: 'MediaPipe Pose Lite', version: '0.5.1675469404', complexity: 0 },
      hardware: { ...this.hardwareProfile, hardwareNotes }, camera: this.camera && { ...this.camera },
      activeSeconds: activeMs / 1000, processedFrames: this._frameCount,
      averageFps: activeMs > 0 ? this._frameCount * 1000 / activeMs : null,
      averageInferenceMs: average(this._inferenceTotal, this._frameCount), maxInferenceMs: this._maxInference,
      acceptedActions: this._actionCount, actions: { ...this._actionCounts },
      averageActionLatencyMs: average(this._actionTotal, this._actionCount), maxActionLatencyMs: this._maxAction,
      captureSources: { ...this._captureSources }, staleInferenceFrames: this._staleCount,
      definitions: {
        inference: 'pose.send start to onResults entry; includes SDK/GPU transfer and scheduling, excludes drawing/classification.',
        action: 'Triggering frame timestamp to accepted Phaser state mutation; excludes earlier debounce frames and display scanout.',
        capture: 'camera-capture when exposed; otherwise video-presentation or frame-acquisition is a browser timestamp estimate.',
        fps: 'Completed model results / visible active camera seconds, including calibration, no-pose results and stalls. Not render FPS.'
      }
    };
  }

  logSummary(hardwareNotes = '') {
    const summary = this.getSummary(hardwareNotes);
    console.info('CV Runner performance summary', summary);
    return summary;
  }
}
