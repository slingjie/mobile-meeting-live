import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentStore } from '../public/lib/segment-store.js';

test('final result replaces the matching draft and late live text cannot overwrite it', () => {
  const store = new SegmentStore();
  const segment = store.create({ id: 's-1', time: '09:33:00', startedAt: 1000 });

  store.appendDraft(segment.id, { source: 'Khí', translation: '气体' });
  store.applyFinal(segment.id, {
    source: 'Khi thì cái này không có sao đâu.',
    translation: '这个没关系。',
  });
  store.appendDraft(segment.id, { source: 'late fragment', translation: '迟到片段' });

  assert.deepEqual(store.get(segment.id), {
    id: 's-1',
    time: '09:33:00',
    startedAt: 1000,
    sourceDraft: 'Khí',
    translationDraft: '气体',
    sourceFinal: 'Khi thì cái này không có sao đâu.',
    translationFinal: '这个没关系。',
    status: 'final',
    error: '',
  });
  assert.deepEqual(store.toEntries(), [{
    id: 's-1',
    time: '09:33:00',
    text: 'Khi thì cái này không có sao đâu.',
    translation: '这个没关系。',
    status: 'final',
  }]);
});

test('final utterances replace one parent segment with timestamped estimated-speaker rows', () => {
  const store = new SegmentStore();
  store.create({ id: 's-multi', time: '14:21:02', startedAt: 1000 });
  store.appendDraft('s-multi', { source: 'one long draft', translation: '一整段草稿' });

  store.applyFinalUtterances('s-multi', {
    utterances: [
      { id: 's-multi-u1', startMs: 0, endMs: 1800, speaker: 'S1', speakerEstimated: true, source: 'Đúng không?', translation: '对吗？', uncertain: false },
      { id: 's-multi-u2', startMs: 2200, endMs: 3000, speaker: 'S2', speakerEstimated: true, source: 'Đúng rồi.', translation: '对。', uncertain: false },
    ],
  });

  assert.equal(store.get('s-multi').status, 'final');
  assert.deepEqual(store.toEntries(), [
    {
      id: 's-multi-u1',
      parentId: 's-multi',
      time: '14:21:02',
      text: 'Đúng không?',
      translation: '对吗？',
      status: 'final',
      speaker: 'S1',
      speakerEstimated: true,
      startMs: 0,
      endMs: 1800,
      uncertain: false,
    },
    {
      id: 's-multi-u2',
      parentId: 's-multi',
      time: '14:21:04',
      text: 'Đúng rồi.',
      translation: '对。',
      status: 'final',
      speaker: 'S2',
      speakerEstimated: true,
      startMs: 2200,
      endMs: 3000,
      uncertain: false,
    },
  ]);
});

test('imports legacy persisted entries without losing text or translation', () => {
  const store = new SegmentStore();
  store.importEntries([{ id: 'old-1', time: '08:00:00', text: 'Hello', translation: '你好' }]);

  assert.deepEqual(store.toEntries(), [{
    id: 'old-1',
    time: '08:00:00',
    text: 'Hello',
    translation: '你好',
    status: 'failed',
  }]);
});

test('reload preserves estimated speaker metadata for split final rows', () => {
  const original = new SegmentStore();
  original.create({ id: 'parent', time: '10:00:00', startedAt: 1000 });
  original.applyFinalUtterances('parent', {
    utterances: [{ id: 'parent-u1', startMs: 500, endMs: 1200, speaker: 'S2', speakerEstimated: true, source: 'Được.', translation: '好的。', uncertain: true }],
  });

  const reloaded = new SegmentStore();
  reloaded.importEntries(original.toEntries());
  assert.deepEqual(reloaded.toEntries(), original.toEntries());
});

test('preserves verified final status when reloading new-format entries', () => {
  const store = new SegmentStore();
  store.importEntries([{ id: 'new-1', time: '08:01:00', text: 'Xin chào', translation: '你好', status: 'final' }]);

  assert.equal(store.toEntries()[0].status, 'final');
});

test('failed refinement keeps the live draft available for export', () => {
  const store = new SegmentStore();
  const segment = store.create({ id: 's-2', time: '09:34:00', startedAt: 2000 });
  store.appendDraft(segment.id, { source: 'Dạ đúng rồi.', translation: '对，没错。' });

  store.markFailed(segment.id, 'refiner timeout');

  assert.equal(store.get(segment.id).status, 'failed');
  assert.equal(store.get(segment.id).error, 'refiner timeout');
  assert.deepEqual(store.toEntries()[0], {
    id: 's-2',
    time: '09:34:00',
    text: 'Dạ đúng rồi.',
    translation: '对，没错。',
    status: 'failed',
  });
});
