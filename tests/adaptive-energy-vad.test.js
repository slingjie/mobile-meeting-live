import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveEnergyVad } from '../public/lib/adaptive-energy-vad.js';
import { VadState } from '../public/lib/vad-state.js';

test('calibrates steady road noise without treating it as continuous speech', () => {
  const vad = new AdaptiveEnergyVad({ warmupMs: 400, historyMs: 3000 });
  let state;
  for (let i = 0; i < 50; i += 1) state = vad.classify({ energy: 800, frameMs: 20, active: false });
  assert.equal(state.speaking, false);
  assert.ok(state.noiseFloor >= 700);
  assert.ok(state.startThreshold > 800);
});

test('uses hysteresis to detect speech above calibrated road noise and then end it', () => {
  const vad = new AdaptiveEnergyVad({ warmupMs: 400, historyMs: 3000 });
  for (let i = 0; i < 30; i += 1) vad.classify({ energy: 800, frameMs: 20, active: false });

  const started = vad.classify({ energy: 1800, frameMs: 20, active: false });
  assert.equal(started.speaking, true);
  assert.ok(started.startThreshold > started.endThreshold);

  for (let i = 0; i < 20; i += 1) vad.classify({ energy: 1700, frameMs: 20, active: true });
  const ended = vad.classify({ energy: 800, frameMs: 20, active: true });
  assert.equal(ended.speaking, false);
});

test('bounds the rolling percentile history and recomputes it only every 250ms', () => {
  const vad = new AdaptiveEnergyVad({ warmupMs: 400, historyMs: 12_000, recomputeIntervalMs: 250 });
  for (let i = 0; i < 400; i += 1) vad.classify({ energy: 700, frameMs: 50, active: false });
  assert.ok(vad.sampleCount <= 240);
  assert.equal(vad.recomputeCount, 80);
});

test('continuous speech is not learned as noise and reopens after a 15-second rotation', () => {
  const energy = new AdaptiveEnergyVad({ warmupMs: 400, historyMs: 12_000, recomputeIntervalMs: 250 });
  const state = new VadState({ silenceMs: 800, minVoicedMs: 200 });
  for (let i = 0; i < 40; i += 1) {
    const classified = energy.classify({ energy: 800, frameMs: 50, active: state.speaking });
    state.observe({ speaking: classified.speaking, now: i * 50, frameMs: 50 });
  }

  let starts = 0;
  let ends = 0;
  let last;
  for (let i = 0; i < 400; i += 1) {
    last = energy.classify({ energy: 1800, frameMs: 50, active: state.speaking });
    const event = state.observe({ speaking: last.speaking, now: 2000 + i * 50, frameMs: 50 });
    if (event.started) starts += 1;
    if (event.ended) ends += 1;
    if (i === 299) state.reset(); // 与前端15秒安全轮转一致，只重置讲话状态
  }
  assert.equal(starts, 2);
  assert.equal(ends, 0);
  assert.ok(last.noiseFloor < 1000);
  assert.equal(state.speaking, true);
});

test('reset requires fresh noise calibration after pause or reconnect', () => {
  const vad = new AdaptiveEnergyVad({ warmupMs: 400 });
  for (let i = 0; i < 30; i += 1) vad.classify({ energy: 700, frameMs: 20, active: false });
  vad.reset();
  const state = vad.classify({ energy: 1800, frameMs: 20, active: false });
  assert.equal(state.calibrating, true);
  assert.equal(state.speaking, false);
});
