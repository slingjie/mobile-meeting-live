import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSpeakerLabel } from '../public/lib/speaker-label.js';

test('labels local estimated speakers without implying stable identity', () => {
  assert.equal(formatSpeakerLabel({ speaker: 'S1', speakerEstimated: true }), '本段发言人1（模型估计）');
  assert.equal(formatSpeakerLabel({ speaker: 'S4', speakerEstimated: true }), '本段发言人4（模型估计）');
});

test('uses an honest unknown label when the voice cannot be separated', () => {
  assert.equal(formatSpeakerLabel({ speaker: 'unknown', speakerEstimated: true }), '发言人未知');
  assert.equal(formatSpeakerLabel({}), '');
});
