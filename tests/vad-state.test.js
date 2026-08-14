import test from 'node:test';
import assert from 'node:assert/strict';
import { VadState } from '../public/lib/vad-state.js';

test('reset after pause or reconnect lets the next voiced frame start a new segment', () => {
  const vad = new VadState({ silenceMs: 800, minVoicedMs: 200 });
  assert.equal(vad.observe({ speaking: true, now: 1000, frameMs: 100 }).started, true);
  vad.reset();
  assert.equal(vad.observe({ speaking: true, now: 2000, frameMs: 100 }).started, true);
});

test('a short noise pulse followed by silence is rejected', () => {
  const vad = new VadState({ silenceMs: 800, minVoicedMs: 200 });
  vad.observe({ speaking: true, now: 0, frameMs: 10 });
  vad.observe({ speaking: false, now: 10, frameMs: 100 });
  const result = vad.observe({ speaking: false, now: 810, frameMs: 700 });

  assert.equal(result.ended, true);
  assert.equal(result.accepted, false);
  assert.equal(result.voicedMs, 10);
});

test('wall-clock stalls do not fabricate silence that was never captured', () => {
  const vad = new VadState({ silenceMs: 800, minVoicedMs: 200 });
  vad.observe({ speaking: true, now: 0, frameMs: 200 });
  const delayed = vad.observe({ speaking: false, now: 10_000, frameMs: 100 });
  assert.equal(delayed.ended, false);
  assert.equal(vad.observe({ speaking: false, now: 10_050, frameMs: 700 }).ended, true);
});

test('accepts a segment only after enough above-threshold audio frames', () => {
  const vad = new VadState({ silenceMs: 800, minVoicedMs: 200 });
  vad.observe({ speaking: true, now: 0, frameMs: 100 });
  vad.observe({ speaking: true, now: 100, frameMs: 100 });
  vad.observe({ speaking: false, now: 200, frameMs: 100 });
  const result = vad.observe({ speaking: false, now: 1000, frameMs: 700 });

  assert.equal(result.ended, true);
  assert.equal(result.accepted, true);
  assert.equal(result.voicedMs, 200);
});

test('default constructor uses meeting-tuned defaults (900ms silence, 150ms minVoiced)', () => {
  const vad = new VadState();
  assert.equal(vad.silenceMs, 900);
  assert.equal(vad.minVoicedMs, 150);
});

