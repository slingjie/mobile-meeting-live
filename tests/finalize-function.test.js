import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeAudio, onRequestPost, readJsonBody } from '../functions/finalize.js';
import { createFinalizeTicket } from '../functions/_lib/finalize-ticket.js';
import { pcm16ToWav } from '../public/lib/audio-segment.js';

async function authorizedHeaders(extra = {}) {
  const ticket = await createFinalizeTicket({
    secret: 'test-key',
    origin: 'https://example.test',
    nonce: 'test-nonce',
  });
  return {
    'content-type': 'application/json',
    origin: 'https://example.test',
    'x-finalize-ticket': ticket,
    ...extra,
  };
}

test('sends the complete WAV segment to Gemini and returns structured final text', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        utterances: [
          {
            startMs: 120,
            endMs: 250,
            speaker: 'S2',
            source: 'Còn cái này nữa.',
            translation: '还有这个。',
            uncertain: false,
          },
          {
            startMs: 0,
            endMs: 120,
            speaker: 'S1',
            source: 'Dạ đúng rồi.',
            translation: '对，没错。',
            uncertain: false,
          },
        ],
        language: 'vi',
        uncertain: false,
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await finalizeAudio({
    payload: {
      segmentId: 's-1',
      audioBase64: Buffer.from(pcm16ToWav(new Uint8Array(6400))).toString('base64'),
      mimeType: 'audio/wav',
      draftSource: 'Dạ đúng rồi.',
      previousContext: [{ source: 'Xin chào.', translation: '你好。' }],
    },
    apiKey: 'test-key',
    model: 'gemini-test-model',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-test-model:generateContent$/);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
  assert.equal(result.segmentId, 's-1');
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.audioDurationMs, 200);
  assert.deepEqual(result.utterances, [
    {
      id: 's-1-u1',
      startMs: 0,
      endMs: 120,
      speaker: 'S1',
      speakerEstimated: true,
      source: 'Dạ đúng rồi.',
      translation: '对，没错。',
      uncertain: false,
    },
    {
      id: 's-1-u2',
      startMs: 120,
      endMs: 200,
      speaker: 'S2',
      speakerEstimated: true,
      source: 'Còn cái này nữa.',
      translation: '还有这个。',
      uncertain: false,
    },
  ]);
  assert.equal(result.source, 'Dạ đúng rồi.\nCòn cái này nữa.');
  assert.equal(result.translation, '对，没错。\n还有这个。');
  assert.equal(result.diarization, 'estimated');
  assert.equal(result.speakerScope, 'segment');
  assert.equal(result.model, 'gemini-test-model');
  assert.match(sent.contents[0].parts[0].text, /Do not identify speakers by name/);
  assert.match(sent.contents[0].parts[0].text, /Audio duration: 200ms/);
});

test('includes meetingTitle, participants, and hotwords in Gemini prompt when provided', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        utterances: [
          {
            startMs: 0,
            endMs: 200,
            speaker: 'S1',
            source: 'Kiểm tra trạm biến áp Pengding 35MW.',
            translation: '检查鹏鼎 35MW 变电站。',
            uncertain: false,
          },
        ],
        language: 'vi',
        uncertain: false,
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await finalizeAudio({
    payload: {
      segmentId: 's-meeting-1',
      audioBase64: Buffer.from(pcm16ToWav(new Uint8Array(6400))).toString('base64'),
      mimeType: 'audio/wav',
      meetingTitle: '鹏鼎 35MW 储能电站调试会',
      participants: ['戴总', '孙宇', '阮工'],
      hotwords: ['鹏鼎', 'PCS', 'BMS', '35MW/87.5MWh', '并网柜'],
    },
    apiKey: 'test-key',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].options.body);
  const prompt = sent.contents[0].parts[0].text;

  assert.match(prompt, /Meeting topic: 鹏鼎 35MW 储能电站调试会/);
  assert.match(prompt, /Known participants: 戴总, 孙宇, 阮工/);
  assert.match(prompt, /Domain hotwords & terminology hints: 鹏鼎, PCS, BMS, 35MW\/87\.5MWh, 并网柜/);
  assert.match(prompt, /CRITICAL VERBATIM & ANTI-HALLUCINATION RULES/);
  assert.equal(result.utterances[0].source, 'Kiểm tra trạm biến áp Pengding 35MW.');
  assert.equal(result.utterances[0].translation, '检查鹏鼎 35MW 变电站。');
});


test('endpoint rejects malformed JSON without exposing server details', async () => {
  const response = await onRequestPost({
    request: new Request('https://example.test/finalize', {
      method: 'POST',
      headers: await authorizedHeaders(),
      body: '{not-json',
    }),
    env: { GEMINI_API_KEY: 'test-key' },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid JSON body' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('endpoint rejects oversized requests before parsing JSON', async () => {
  const response = await onRequestPost({
    request: new Request('https://example.test/finalize', {
      method: 'POST',
      headers: await authorizedHeaders({ 'content-length': '4000001' }),
      body: '{}',
    }),
    env: { GEMINI_API_KEY: 'test-key' },
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request body is too large' });
});

test('endpoint rejects cross-origin browser requests before spending model quota', async () => {
  const response = await onRequestPost({
    request: new Request('https://example.test/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.test' },
      body: JSON.stringify({ segmentId: 's-3', audioBase64: 'AAAA', mimeType: 'audio/wav' }),
    }),
    env: { GEMINI_API_KEY: 'test-key' },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Forbidden origin' });
});

test('endpoint requires a ticket issued by the Live WebSocket session', async () => {
  const response = await onRequestPost({
    request: new Request('https://example.test/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.test' },
      body: '{}',
    }),
    env: { GEMINI_API_KEY: 'test-key' },
  });
  assert.equal(response.status, 401);
});

test('stream reader enforces a hard byte limit without Content-Length', async () => {
  const request = new Request('https://example.test/finalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(200) }),
  });
  await assert.rejects(() => readJsonBody(request, 100), /too large/);
});

test('rejects malformed segment IDs and non-WAV audio before calling Gemini', async () => {
  const base = {
    mimeType: 'audio/wav',
    audioBase64: Buffer.from('not a wav').toString('base64'),
  };
  await assert.rejects(
    () => finalizeAudio({ payload: { ...base, segmentId: '../bad' }, apiKey: 'test-key', fetchImpl: async () => { throw new Error('must not call'); } }),
    /segmentId/,
  );
  await assert.rejects(
    () => finalizeAudio({ payload: { ...base, segmentId: 'seg-123' }, apiKey: 'test-key', fetchImpl: async () => { throw new Error('must not call'); } }),
    /WAV/,
  );
});
