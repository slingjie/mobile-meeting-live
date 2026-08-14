import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveSegmentQueue } from '../public/lib/live-segment-queue.js';

test('keeps late Live fragments on the oldest closed segment when the next segment has started', () => {
  const queue = new LiveSegmentQueue();
  queue.enqueue('s-1', 10);
  queue.enqueue('s-2', 10);

  assert.equal(queue.target(10), 's-1');
  assert.equal(queue.complete(10), 's-1');
  assert.equal(queue.target(10), 's-2');
});

test('ignores frames from an obsolete WebSocket session', () => {
  const queue = new LiveSegmentQueue();
  queue.enqueue('s-old', 10);
  queue.enqueue('s-new', 11);

  assert.equal(queue.target(9), null);
  assert.equal(queue.complete(9), null);
  assert.deepEqual(queue.clearSession(10), ['s-old']);
  assert.equal(queue.target(11), 's-new');
});

test('expires one segment without clearing a later pending segment', () => {
  const queue = new LiveSegmentQueue();
  queue.enqueue('s-1', 10);
  queue.enqueue('s-2', 10);

  assert.equal(queue.expire('s-1'), true);
  assert.equal(queue.target(10), 's-2');
});
