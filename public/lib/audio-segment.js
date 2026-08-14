function copyBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.slice();
}

function concatChunks(chunks, totalBytes) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class PcmSegmentRecorder {
  constructor({ preRollBytes = 9600, maxSegmentBytes = 1920000 } = {}) {
    this.preRollBytes = preRollBytes;
    this.maxSegmentBytes = maxSegmentBytes;
    this.preRoll = new Uint8Array(0);
    this.active = null;
  }

  get bufferedPreRollBytes() {
    return this.preRoll.byteLength;
  }

  push(input) {
    const bytes = copyBytes(input);
    if (!this.active) {
      const combined = new Uint8Array(this.preRoll.byteLength + bytes.byteLength);
      combined.set(this.preRoll);
      combined.set(bytes, this.preRoll.byteLength);
      this.preRoll = combined.slice(Math.max(0, combined.byteLength - this.preRollBytes));
      return { full: false, truncated: false };
    }

    if (this.active.totalBytes >= this.maxSegmentBytes) {
      this.active.truncated = true;
      return { full: true, truncated: true };
    }
    if (bytes.byteLength) {
      this.active.chunks.push(bytes);
      this.active.totalBytes += bytes.byteLength;
    }
    return {
      full: this.active.totalBytes >= this.maxSegmentBytes,
      truncated: false,
    };
  }

  start({ id, startedAt }) {
    if (this.active) throw new Error('a segment is already recording');
    const initial = this.preRoll.slice(Math.max(0, this.preRoll.byteLength - this.maxSegmentBytes));
    this.active = {
      id,
      startedAt,
      chunks: initial.byteLength ? [initial] : [],
      totalBytes: initial.byteLength,
      truncated: false,
    };
    this.preRoll = new Uint8Array(0);
  }

  finish({ endedAt }) {
    if (!this.active) return null;
    const result = {
      id: this.active.id,
      startedAt: this.active.startedAt,
      endedAt,
      pcm: concatChunks(this.active.chunks, this.active.totalBytes),
      truncated: this.active.truncated,
    };
    this.active = null;
    return result;
  }

  reset() {
    this.active = null;
    this.preRoll = new Uint8Array(0);
  }
}

export function pcm16ToWav(input, sampleRate = 16000) {
  const pcm = copyBytes(input);
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) wav[offset + i] = value.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}
