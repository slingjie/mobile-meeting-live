export class AdaptiveEnergyVad {
  constructor({
    initialNoiseFloor = 150,
    warmupMs = 400,
    historyMs = 12_000,
    recomputeIntervalMs = 250,
    startRatio = 1.8,
    endRatio = 1.3,
    startFloor = 250,
    endFloor = 180,
    startMargin = 120,
    endMargin = 60,
    maxActiveRisePerSecond = 0.15,
  } = {}) {
    this.options = {
      initialNoiseFloor,
      warmupMs,
      historyMs,
      recomputeIntervalMs,
      startRatio,
      endRatio,
      startFloor,
      endFloor,
      startMargin,
      endMargin,
      maxActiveRisePerSecond,
    };
    this.reset();
  }

  get sampleCount() {
    return this.history.length;
  }

  reset() {
    this.noiseFloor = this.options.initialNoiseFloor;
    this.elapsedMs = 0;
    this.historyDurationMs = 0;
    this.recomputeElapsedMs = 0;
    this.recomputeCount = 0;
    this.history = [];
  }

  updateNoiseFloor(active) {
    const sorted = this.history.map(item => item.energy).sort((a, b) => a - b);
    const quantileIndex = Math.max(0, Math.floor((sorted.length - 1) * 0.2));
    const lowEnergy = sorted[quantileIndex] ?? this.noiseFloor;
    const calibrating = this.elapsedMs <= this.options.warmupMs + this.options.recomputeIntervalMs;

    if (calibrating) {
      this.noiseFloor += (lowEnergy - this.noiseFloor) * 0.5;
    } else if (lowEnergy <= this.noiseFloor) {
      this.noiseFloor += (lowEnergy - this.noiseFloor) * 0.4;
    } else if (!active) {
      this.noiseFloor += (lowEnergy - this.noiseFloor) * 0.4;
    } else {
      const desiredRise = (lowEnergy - this.noiseFloor) * 0.2;
      const maxRise = this.noiseFloor * this.options.maxActiveRisePerSecond
        * (this.options.recomputeIntervalMs / 1000);
      this.noiseFloor += Math.min(desiredRise, maxRise);
    }
    this.recomputeCount += 1;
  }

  classify({ energy, frameMs, active = false }) {
    const value = Math.max(0, Number(energy) || 0);
    const duration = Math.max(0, Number(frameMs) || 0);
    this.elapsedMs += duration;

    const currentEndThreshold = Math.max(
      this.options.endFloor,
      this.noiseFloor * this.options.endRatio,
      this.noiseFloor + this.options.endMargin,
    );
    const activeSpeechFrame = active && value >= currentEndThreshold;
    if (!activeSpeechFrame) {
      this.historyDurationMs += duration;
      this.recomputeElapsedMs += duration;
      this.history.push({ energy: value, frameMs: duration });
      while (this.history.length > 1 && this.historyDurationMs > this.options.historyMs) {
        const removed = this.history.shift();
        this.historyDurationMs -= removed.frameMs;
      }

      while (this.recomputeElapsedMs >= this.options.recomputeIntervalMs) {
        this.recomputeElapsedMs -= this.options.recomputeIntervalMs;
        this.updateNoiseFloor(active);
      }
    }

    const startThreshold = Math.max(
      this.options.startFloor,
      this.noiseFloor * this.options.startRatio,
      this.noiseFloor + this.options.startMargin,
    );
    const endThreshold = Math.max(
      this.options.endFloor,
      this.noiseFloor * this.options.endRatio,
      this.noiseFloor + this.options.endMargin,
    );
    const calibrating = this.elapsedMs < this.options.warmupMs;
    const speaking = !calibrating && value >= (active ? endThreshold : startThreshold);
    return {
      speaking,
      calibrating,
      noiseFloor: this.noiseFloor,
      startThreshold,
      endThreshold,
    };
  }
}
