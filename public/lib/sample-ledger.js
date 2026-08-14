export class SampleLedger {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.bytesPerSample = options.bytesPerSample || 2;
    this.channels = options.channels || 1;
    this.warningThresholdRatio = options.warningThresholdRatio || 0.05; // 5% drift threshold
    this.minWallDurationForWarningMs = options.minWallDurationForWarningMs || 10000; // only warn after 10s

    this.isStarted = false;
    this.startWallTimeMs = 0;
    this.capturedSamples = 0;
  }

  start(nowMs = Date.now()) {
    this.isStarted = true;
    this.startWallTimeMs = nowMs;
    this.capturedSamples = 0;
  }

  addSamples(count) {
    if (!this.isStarted || typeof count !== 'number' || count <= 0) return;
    this.capturedSamples += count;
  }

  addBytes(byteLength) {
    if (!this.isStarted || typeof byteLength !== 'number' || byteLength <= 0) return;
    const samples = Math.floor(byteLength / (this.bytesPerSample * this.channels));
    this.addSamples(samples);
  }

  get capturedBytes() {
    return this.capturedSamples * this.bytesPerSample * this.channels;
  }

  getTelemetry(nowMs = Date.now()) {
    if (!this.isStarted) {
      return {
        isStarted: false,
        wallDurationMs: 0,
        capturedDurationMs: 0,
        capturedSamples: 0,
        capturedBytes: 0,
        driftMs: 0,
        driftRatio: 0,
        hasWarning: false,
        warningText: ''
      };
    }

    const wallDurationMs = Math.max(0, nowMs - this.startWallTimeMs);
    const capturedDurationMs = Math.round((this.capturedSamples / this.sampleRate) * 1000);
    const driftMs = Math.max(0, wallDurationMs - capturedDurationMs);
    const driftRatio = wallDurationMs > 0 ? driftMs / wallDurationMs : 0;

    const hasWarning = wallDurationMs >= this.minWallDurationForWarningMs && driftRatio >= this.warningThresholdRatio;
    const warningText = hasWarning
      ? `检测到系统节电或采样延迟，约 ${(driftMs / 1000).toFixed(1)} 秒音频未被录入`
      : '';

    return {
      isStarted: true,
      wallDurationMs,
      capturedDurationMs,
      capturedSamples: this.capturedSamples,
      capturedBytes: this.capturedBytes,
      driftMs,
      driftRatio,
      hasWarning,
      warningText
    };
  }

  reset() {
    this.isStarted = false;
    this.startWallTimeMs = 0;
    this.capturedSamples = 0;
  }
}
