export class VadState {
  constructor({ silenceMs = 900, minVoicedMs = 150 } = {}) {
    this.silenceMs = silenceMs;
    this.minVoicedMs = minVoicedMs;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.startedAt = 0;
    this.silenceStartedAt = 0;
    this.silentMs = 0;
    this.voicedMs = 0;
  }

  observe({ speaking, now, frameMs = 0 }) {
    const result = { started: false, ended: false, accepted: false, voicedMs: this.voicedMs };

    if (speaking) {
      if (!this.speaking) {
        this.speaking = true;
        this.startedAt = now;
        result.started = true;
      }
      this.silenceStartedAt = 0;
      this.silentMs = 0;
      this.voicedMs += Math.max(0, frameMs);
      result.voicedMs = this.voicedMs;
      return result;
    }

    if (!this.speaking) return result;
    if (!this.silenceStartedAt) this.silenceStartedAt = now;
    this.silentMs += Math.max(0, frameMs);
    if (this.silentMs < this.silenceMs) return result;

    result.ended = true;
    result.voicedMs = this.voicedMs;
    result.accepted = this.voicedMs >= this.minVoicedMs;
    this.reset();
    return result;
  }
}
