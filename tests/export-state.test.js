import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDisableExport } from '../public/lib/export-state.js';

test('export stays disabled while any accurate final request is pending', () => {
  assert.equal(shouldDisableExport({ entryCount: 2, finalizingCount: 1 }), true);
  assert.equal(shouldDisableExport({ entryCount: 2, finalizingCount: 0 }), false);
  assert.equal(shouldDisableExport({ entryCount: 0, finalizingCount: 0 }), true);
});
