export class PcmChunker {
  constructor(chunkBytes = 3200) {
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
      throw new TypeError('chunkBytes must be a positive integer');
    }
    this.chunkBytes = chunkBytes;
    this.pending = new Uint8Array(0);
  }

  get bufferedBytes() {
    return this.pending.byteLength;
  }

  push(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const merged = new Uint8Array(this.pending.byteLength + bytes.byteLength);
    merged.set(this.pending, 0);
    merged.set(bytes, this.pending.byteLength);

    const chunks = [];
    let offset = 0;
    while (merged.byteLength - offset >= this.chunkBytes) {
      chunks.push(merged.slice(offset, offset + this.chunkBytes));
      offset += this.chunkBytes;
    }
    this.pending = merged.slice(offset);
    return chunks;
  }

  flush() {
    const remainder = this.pending;
    this.pending = new Uint8Array(0);
    return remainder;
  }

  reset() {
    this.pending = new Uint8Array(0);
  }
}
