import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFinalResult } from '../public/lib/final-result.js';

function recordingStore() {
  const calls = [];
  return {
    calls,
    applyFinalUtterances(id, result) { calls.push(['utterances', id, result]); },
    applyFinal(id, result) { calls.push(['flat', id, result]); },
  };
}

test('routes utterance-aware final results to row splitting', () => {
  const store = recordingStore();
  const result = { utterances: [{ source: 'Được.', translation: '好的。' }] };
  applyFinalResult(store, 'seg-1', result);
  assert.deepEqual(store.calls, [['utterances', 'seg-1', result]]);
});

test('keeps backward compatibility with flat final results', () => {
  const store = recordingStore();
  const result = { source: 'Hello', translation: '你好' };
  applyFinalResult(store, 'seg-2', result);
  assert.deepEqual(store.calls, [['flat', 'seg-2', result]]);
});
