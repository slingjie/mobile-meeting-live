export class PcmEnergyFramer {
  constructor({ frameBytes = 1600, frameMs = 50 } = {}) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0 || frameBytes % 2 !== 0) {
      throw new TypeError('frameBytes must be a positive even integer');
    }
    this.frameBytes = frameBytes;
    this.frameMs = frameMs;
    this.reset();
  }

  get bufferedBytes() {
    return this.buffer.byteLength;
  }

  reset() {
    this.buffer = new Uint8Array(0);
  }

  push(input) {
    const bytes = input instanceof Uint8Array
      ? input
      : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength || 0);
    if (!bytes.byteLength) return [];
    const merged = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.byteLength);

    const outputs = [];
    let offset = 0;
    while (offset + this.frameBytes <= merged.byteLength) {
      const samples = new Int16Array(merged.buffer, offset, this.frameBytes / 2);
      let total = 0;
      for (let index = 0; index < samples.length; index += 1) total += Math.abs(samples[index]);
      outputs.push({ energy: total / samples.length, frameMs: this.frameMs });
      offset += this.frameBytes;
    }
    this.buffer = merged.slice(offset);
    return outputs;
  }
}
