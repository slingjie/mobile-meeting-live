import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleLedger } from '../public/lib/sample-ledger.js';

test('SampleLedger records samples and computes duration correctly', () => {
  const ledger = new SampleLedger({ sampleRate: 16000 });
  const start = 100000;
  ledger.start(start);

  // Add 16000 samples (1 second at 16kHz)
  ledger.addSamples(16000);

  const t1 = ledger.getTelemetry(start + 1000);
  assert.equal(t1.wallDurationMs, 1000);
  assert.equal(t1.capturedDurationMs, 1000);
  assert.equal(t1.capturedSamples, 16000);
  assert.equal(t1.capturedBytes, 32000);
  assert.equal(t1.driftMs, 0);
  assert.equal(t1.driftRatio, 0);
  assert.equal(t1.hasWarning, false);
});

test('SampleLedger tracks drift and flags warning when drift exceeds threshold', () => {
  const ledger = new SampleLedger({ sampleRate: 16000, warningThresholdRatio: 0.05, minWallDurationForWarningMs: 10000 });
  const start = 100000;
  ledger.start(start);

  // 100 seconds wall clock, but only 90 seconds captured (10% drift)
  ledger.addSamples(90 * 16000);

  const t = ledger.getTelemetry(start + 100000);
  assert.equal(t.wallDurationMs, 100000);
  assert.equal(t.capturedDurationMs, 90000);
  assert.equal(t.driftMs, 10000);
  assert.equal(t.driftRatio, 0.1);
  assert.equal(t.hasWarning, true);
  assert.match(t.warningText, /约 10\.0 秒/);
});

test('SampleLedger does not flag warning for short recordings', () => {
  const ledger = new SampleLedger({ sampleRate: 16000, minWallDurationForWarningMs: 10000 });
  const start = 100000;
  ledger.start(start);

  // 5 seconds wall clock, 4 seconds captured (20% drift, but duration < 10s)
  ledger.addSamples(4 * 16000);

  const t = ledger.getTelemetry(start + 5000);
  assert.equal(t.hasWarning, false);
});

test('SampleLedger addBytes converts byte length to 16-bit mono sample count', () => {
  const ledger = new SampleLedger({ sampleRate: 16000 });
  ledger.start(0);
  ledger.addBytes(3200); // 1600 samples (100ms)
  assert.equal(ledger.capturedSamples, 1600);
  assert.equal(ledger.capturedBytes, 3200);
});

test('SampleLedger reset clears state', () => {
  const ledger = new SampleLedger({ sampleRate: 16000 });
  ledger.start(0);
  ledger.addSamples(16000);
  ledger.reset();
  assert.equal(ledger.capturedSamples, 0);
  assert.equal(ledger.isStarted, false);
});
