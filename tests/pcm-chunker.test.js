import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmChunker } from '../public/lib/pcm-chunker.js';

test('buffers irregular PCM callbacks into exact 100ms chunks', () => {
  const chunker = new PcmChunker(3200);

  assert.deepEqual(chunker.push(new Uint8Array(100)), []);
  const chunks = chunker.push(new Uint8Array(3100).fill(7));

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].byteLength, 3200);
  assert.equal(chunker.bufferedBytes, 0);
});

test('returns every complete chunk and keeps only the remainder', () => {
  const chunker = new PcmChunker(3200);
  const chunks = chunker.push(new Uint8Array(6500).fill(3));

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(chunk => chunk.byteLength), [3200, 3200]);
  assert.equal(chunker.bufferedBytes, 100);
  assert.equal(chunker.flush().byteLength, 100);
  assert.equal(chunker.bufferedBytes, 0);
});

test('copies source bytes so transferred worklet buffers cannot mutate queued audio', () => {
  const chunker = new PcmChunker(4);
  const source = new Uint8Array([1, 2]);
  chunker.push(source);
  source.fill(9);

  const chunk = chunker.push(new Uint8Array([3, 4]))[0];
  assert.deepEqual([...chunk], [1, 2, 3, 4]);
});
