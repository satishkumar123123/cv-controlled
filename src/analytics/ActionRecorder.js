export const JOINT_METRICS = Object.freeze([
  'leftKneeFlexion', 'rightKneeFlexion', 'leftHipFlexion', 'rightHipFlexion',
  'leftHipSagittalAngle', 'rightHipSagittalAngle',
  'leftAnkleDorsiflexion', 'rightAnkleDorsiflexion'
]);
const finite = (value) => Number.isFinite(value) ? value : null;

/**
 * Bounded, timestamped per-action joint history. It observes the classifier;
 * it never dispatches controls. Confirmed takeoff/contact timestamps relabel
 * candidate frames retrospectively, so debounce does not erase those phases.
 * Preparation is a 500 ms look-back, not a claim of force-plate phase detection.
 */
export class ActionRecorder {
  constructor({ maxSamples = 600, maxActions = 5, preparationMs = 500 } = {}) {
    if (![maxSamples, maxActions].every((n) => Number.isInteger(n) && n > 0) ||
        !Number.isFinite(preparationMs) || preparationMs < 0) throw new Error('Invalid recording bounds.');
    Object.assign(this, { maxSamples, maxActions, preparationMs });
    this.reset();
  }

  reset() {
    this.history = [];
    this.active = null;
    this._buffer = [];
    this._lastTimestamp = null;
    this.currentPhase = '—';
    this.cancellationReason = null;
  }

  update(metrics) {
    if (!metrics?.valid || !Number.isFinite(metrics.timestamp)) {
      if (this.active) this.cancellationReason = metrics?.reason ?? 'Tracking interrupted';
      this.active = null;
      this._buffer = [];
      this._lastTimestamp = null;
      this.currentPhase = '—';
      return;
    }
    const time = metrics.timestamp;
    if (this._lastTimestamp !== null && time <= this._lastTimestamp) return;
    this._lastTimestamp = time;
    const sample = {
      timestamp: time, angleSource: metrics.angleSource ?? null,
      ...Object.fromEntries(JOINT_METRICS.map((key) => [key, finite(metrics[key])]))
    };
    const action = metrics.state === 'JUMPING' ? 'JUMP' : metrics.state === 'DUCKING' ? 'DUCK' : null;
    if (!this.active && action) {
      const onset = action === 'JUMP' ? metrics.takeoffTimestamp : metrics.duckStartedAt;
      if (!Number.isFinite(onset) || onset > time) return;
      this.active = {
        action, startedAt: onset, endedAt: null, landingAt: null, truncated: false,
        samples: this._buffer.filter((p) => p.timestamp >= onset - this.preparationMs),
        flightTime: null, jumpHeight: null, verticalDisplacement: null, pauseDuration: null
      };
      this.cancellationReason = null;
    }
    if (this.active) {
      const record = this.active;
      record.samples.push(sample);
      if (record.samples.length > this.maxSamples) {
        // Preserve the oldest preparation/takeoff half, plus recent recovery.
        record.samples.splice(Math.floor(this.maxSamples / 2), record.samples.length - this.maxSamples);
        record.truncated = true;
      }
      if (record.action === 'JUMP' && Number.isFinite(metrics.landingTimestamp)) record.landingAt = metrics.landingTimestamp;
      const fields = record.action === 'JUMP' ? ['flightTime', 'jumpHeight', 'verticalDisplacement'] : ['pauseDuration'];
      for (const key of fields) record[key] = finite(metrics[key]);
      this.currentPhase = this._phase(sample, record);
      const complete = record.action === 'JUMP'
        ? record.landingAt !== null && metrics.state === 'NEUTRAL'
        : metrics.state === 'NEUTRAL';
      if (complete) {
        record.endedAt = time;
        this.history.push(this._snapshot(record));
        if (this.history.length > this.maxActions) this.history.shift();
        this.active = null;
        this.currentPhase = 'NEUTRAL';
      } else if ((record.action === 'JUMP' && !['JUMPING', 'LANDING_COOLDOWN'].includes(metrics.state)) ||
                 (record.action === 'DUCK' && metrics.state !== 'DUCKING')) {
        this.active = null;
        this.cancellationReason = 'Action interrupted before completion';
      }
    } else this.currentPhase = metrics.state === 'LANDING_COOLDOWN' ? 'RECOVERY' : 'NEUTRAL';
    this._buffer.push(sample);
    while (this._buffer.length && this._buffer[0].timestamp < time - this.preparationMs) this._buffer.shift();
    if (this._buffer.length > 64) this._buffer.shift();
  }

  _phase(sample, record) {
    if (sample.timestamp < record.startedAt) return 'PREPARATION';
    if (record.action === 'DUCK') return 'CROUCH';
    if (record.landingAt !== null && sample.timestamp >= record.landingAt) return 'LANDING';
    return sample.timestamp === record.startedAt ? 'TAKEOFF' : 'FLIGHT';
  }

  _snapshot(record) {
    const samples = record.samples.map((sample) => ({ ...sample, phase: this._phase(sample, record) }));
    const phases = {};
    for (const sample of samples) {
      const phase = phases[sample.phase] ??= { samples: 0, angles: {} };
      phase.samples++;
      for (const key of JOINT_METRICS) {
        if (!Number.isFinite(sample[key])) continue;
        const range = phase.angles[key] ??= { min: sample[key], max: sample[key], validSamples: 0 };
        range.min = Math.min(range.min, sample[key]);
        range.max = Math.max(range.max, sample[key]);
        range.validSamples++;
      }
    }
    return { ...record, samples, phases };
  }

  getCurrent() { return this.active ? this._snapshot(this.active) : null; }
  getLast() { return this.history.at(-1) ?? null; }
  getReport() {
    return {
      schemaVersion: 1, units: { timestamps: 'monotonic milliseconds', angles: 'degrees', verticalDisplacement: 'normalized image height' },
      conventions: { knee: '0 = extension; positive = flexion', hip: 'unsigned 3D flexion proxy',
        hipSagittal: 'positive flexion / negative extension in estimated body plane',
        ankle: 'positive dorsiflexion / negative plantarflexion; 90 minus shin-to-heel/toe angle' },
      phaseDefinition: `${this.preparationMs} ms preparation look-back; first qualifying airborne frame = takeoff; confirmed contact through neutral recovery = landing`,
      bounds: { maxActions: this.maxActions, maxSamples: this.maxSamples },
      completedActions: structuredClone(this.history), activeAction: this.getCurrent(),
      cancellationReason: this.cancellationReason
    };
  }
}
