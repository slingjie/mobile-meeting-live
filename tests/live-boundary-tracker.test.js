import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBoundaryTracker } from '../public/lib/live-boundary-tracker.js';

test('tracks every audio boundary independently of transcript segment creation', () => {
  const tracker = new LiveBoundaryTracker();
  tracker.sent(7);
  tracker.sent(7);
  assert.equal(tracker.hasPending(7), true);
  assert.equal(tracker.pending(7), 2);
  tracker.completed(7);
  assert.equal(tracker.pending(7), 1);
  tracker.completed(7);
  assert.equal(tracker.hasPending(7), false);
});

test('does not let another websocket session drain the active session', () => {
  const tracker = new LiveBoundaryTracker();
  tracker.sent(3);
  tracker.completed(2);
  assert.equal(tracker.hasPending(3), true);
  tracker.clear(3);
  assert.equal(tracker.hasPending(3), false);
});
