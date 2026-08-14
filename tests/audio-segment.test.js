import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmSegmentRecorder, pcm16ToWav } from '../public/lib/audio-segment.js';

test('records a speech segment with pre-roll and returns an isolated byte copy', () => {
  const recorder = new PcmSegmentRecorder({ preRollBytes: 4, maxSegmentBytes: 20 });
  recorder.push(new Uint8Array([1, 2, 3, 4]));
  recorder.start({ id: 's-1', startedAt: 1000 });
  const live = new Uint8Array([5, 6]);
  recorder.push(live);
  live.fill(9);

  const result = recorder.finish({ endedAt: 1200 });

  assert.deepEqual([...result.pcm], [1, 2, 3, 4, 5, 6]);
  assert.equal(result.id, 's-1');
  assert.equal(result.startedAt, 1000);
  assert.equal(result.endedAt, 1200);
  assert.equal(result.truncated, false);
});

test('signals a clean rotation exactly at the segment size limit', () => {
  const recorder = new PcmSegmentRecorder({ preRollBytes: 0, maxSegmentBytes: 8 });
  recorder.start({ id: 'seg-long', startedAt: 1000 });

  const state = recorder.push(new Uint8Array(8));
  const result = recorder.finish({ endedAt: 2000 });

  assert.deepEqual(state, { full: true, truncated: false });
  assert.equal(result.truncated, false);
  assert.equal(result.pcm.byteLength, 8);
});

test('keeps the whole callback when it crosses the segment limit', () => {
  const recorder = new PcmSegmentRecorder({ preRollBytes: 0, maxSegmentBytes: 8 });
  recorder.start({ id: 'seg-crossing', startedAt: 1000 });

  const state = recorder.push(new Uint8Array(10));
  const result = recorder.finish({ endedAt: 2000 });

  assert.deepEqual(state, { full: true, truncated: false });
  assert.equal(result.truncated, false);
  assert.equal(result.pcm.byteLength, 10);
});

test('wraps PCM16 mono data in a valid 16kHz WAV header', () => {
  const wav = pcm16ToWav(new Uint8Array([1, 2, 3, 4]), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset, length) => String.fromCharCode(...wav.subarray(offset, offset + length));

  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
});
