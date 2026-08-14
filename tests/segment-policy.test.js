import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEGMENT_MS, PRE_ROLL_MS, VAD_WARMUP_MS, maxSegmentBytes, pcmBytesForMs, pcmDurationMs } from '../public/lib/segment-policy.js';

test('pre-roll covers the full adaptive VAD calibration window', () => {
  assert.equal(VAD_WARMUP_MS, 400);
  assert.equal(PRE_ROLL_MS, 500);
  assert.ok(PRE_ROLL_MS >= VAD_WARMUP_MS);
  assert.equal(pcmBytesForMs({ milliseconds: PRE_ROLL_MS, sampleRate: 16_000, bytesPerSample: 2 }), 16_000);
  assert.equal(pcmDurationMs({ bytes: 16_000, sampleRate: 16_000, bytesPerSample: 2 }), 500);
});

test('meeting finalization uses a 15-second safety window instead of a 60-second hard row', () => {
  assert.equal(MAX_SEGMENT_MS, 15_000);
  assert.equal(maxSegmentBytes({ sampleRate: 16_000, bytesPerSample: 2 }), 480_000);
});
