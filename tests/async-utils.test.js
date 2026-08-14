import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDrain, waitForMeetingDrain } from '../public/lib/async-utils.js';

test('drain resolves as soon as no work remains', async () => {
  let checks = 0;
  const result = await waitForDrain({
    hasPending: () => ++checks < 3,
    timeoutMs: 100,
    pollMs: 1,
  });
  assert.equal(result, 'drained');
});

test('meeting drain waits for Live first and accurate-final requests second', async () => {
  const calls = [];
  const waitFor = async options => {
    calls.push({ pending: options.hasPending(), timeoutMs: options.timeoutMs });
    return 'drained';
  };
  const result = await waitForMeetingDrain({
    hasLivePending: () => 'live',
    hasFinalPending: () => 'final',
    waitFor,
    liveTimeoutMs: 2000,
    finalTimeoutMs: 21000,
  });
  assert.deepEqual(calls, [
    { pending: 'live', timeoutMs: 2000 },
    { pending: 'final', timeoutMs: 21000 },
  ]);
  assert.deepEqual(result, { live: 'drained', final: 'drained' });
});

test('drain returns after the bounded timeout', async () => {
  const started = Date.now();
  const result = await waitForDrain({ hasPending: () => true, timeoutMs: 10, pollMs: 2 });
  assert.equal(result, 'timeout');
  assert.ok(Date.now() - started < 100);
});
