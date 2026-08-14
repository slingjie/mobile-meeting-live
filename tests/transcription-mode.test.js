import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscriptMode, shouldRequestFinal } from '../public/lib/transcription-mode.js';

test('route 2 accurate mode is the safe default', () => {
  assert.equal(normalizeTranscriptMode(undefined), 'accurate');
  assert.equal(normalizeTranscriptMode('unknown'), 'accurate');
  assert.equal(shouldRequestFinal('accurate'), true);
});

test('live-only mode disables the second audio upload', () => {
  assert.equal(normalizeTranscriptMode('live'), 'live');
  assert.equal(shouldRequestFinal('live'), false);
});
