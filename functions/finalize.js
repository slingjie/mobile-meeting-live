import { verifyFinalizeTicket } from './_lib/finalize-ticket.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MAX_AUDIO_BASE64_CHARS = 3_000_000;
const MAX_REQUEST_BYTES = 4_000_000;
const UPSTREAM_TIMEOUT_MS = 15_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function compactContext(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-5).map(item => ({
    source: String(item?.source || '').slice(0, 500),
    translation: String(item?.translation || '').slice(0, 500),
  }));
}

function buildInstruction(payload) {
  const context = compactContext(payload.previousContext);
  return `You are a strict multilingual meeting transcription editor.\n\n` +
    `The audio may contain Vietnamese, Mandarin Chinese, English, or rapid code-switching. ` +
    `Transcribe the COMPLETE audio verbatim in its original language, then translate it faithfully into Simplified Chinese.\n\n` +
    `Rules:\n` +
    `1. Audio is authoritative. The live draft and context are hints only.\n` +
    `2. Preserve every number, unit, name, project, company, model, voltage and capacity exactly.\n` +
    `3. Do not invent missing words or silently repair unclear speech. Use [听不清] in source and translation when needed.\n` +
    `4. Vietnamese relationship words and pronouns can be ambiguous; do not guess gender or kinship without evidence.\n` +
    `5. Use natural Chinese while preserving meaning. Remove only meaningless fillers; do not summarize.\n` +
    `6. Split the audio into utterances at actual speaker changes or semantic sentence boundaries. Keep short replies such as \"Ừ\", \"Được\" and \"Đúng rồi\" as separate utterances when they are separate turns.\n` +
    `7. Speaker labels are local to this audio segment only. Use S1, S2, ... only when the voice change is audible; otherwise use unknown. Do not identify speakers by name and do not infer speakers from wording alone.\n` +
    `8. Estimate monotonic startMs/endMs offsets from the beginning of this audio clip. These are approximate utterance-level boundaries, not word timestamps.\n` +
    `9. Every offset must stay within the provided audio duration.\n` +
    `10. Relevant terminology may include photovoltaic, battery energy storage, EPC, grid connection, EMS, PCS, BMS, SCADA, commissioning, acceptance, fire protection, kV, MW and MWh.\n\n` +
    `Audio duration: ${payload.audioDurationMs}ms\n` +
    `Live draft: ${JSON.stringify(String(payload.draftSource || '').slice(0, 1000))}\n` +
    `Previous finalized context: ${JSON.stringify(context)}`;
}

export async function readJsonBody(request, maxBytes = MAX_REQUEST_BYTES) {
  if (!request.body) throw new TypeError('Invalid JSON body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError('Request body is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new TypeError('Invalid JSON body');
  }
}

export function parsePcmWavInfo(audioBase64) {
  let binary;
  try {
    binary = atob(audioBase64);
  } catch {
    throw new TypeError('audioBase64 is invalid');
  }
  if (binary.length < 44 || binary.slice(0, 4) !== 'RIFF' || binary.slice(8, 12) !== 'WAVE') {
    throw new TypeError('audio must contain a WAV header');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.byteLength) throw new TypeError('WAV chunk is truncated');
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: view.getUint16(dataOffset, true),
        channels: view.getUint16(dataOffset + 2, true),
        sampleRate: view.getUint32(dataOffset + 4, true),
        bitsPerSample: view.getUint16(dataOffset + 14, true),
      };
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  if (!format || dataBytes === null || format.audioFormat !== 1
    || format.channels < 1 || format.sampleRate < 1
    || format.bitsPerSample < 8 || format.bitsPerSample % 8 !== 0) {
    throw new TypeError('audio must contain PCM WAV data');
  }
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  const audioDurationMs = Math.max(1, Math.round(dataBytes / bytesPerSecond * 1000));
  return { ...format, dataBytes, audioDurationMs };
}

function validatePayload(payload) {
  if (typeof payload?.segmentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.segmentId)) {
    throw new TypeError('segmentId is invalid');
  }
  if (payload.mimeType !== 'audio/wav') throw new TypeError('mimeType must be audio/wav');
  if (typeof payload.audioBase64 !== 'string' || !payload.audioBase64) {
    throw new TypeError('audioBase64 is required');
  }
  if (payload.audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
    throw new RangeError('audio segment is too large');
  }
  if (payload.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.audioBase64)) {
    throw new TypeError('audioBase64 is invalid');
  }
  return parsePcmWavInfo(payload.audioBase64);
}

export async function finalizeAudio({ payload, apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const wavInfo = validatePayload(payload);
  const normalizedPayload = { ...payload, audioDurationMs: wavInfo.audioDurationMs };

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: buildInstruction(normalizedPayload) },
        { inlineData: { mimeType: payload.mimeType, data: payload.audioBase64 } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          utterances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                startMs: { type: 'integer' },
                endMs: { type: 'integer' },
                speaker: { type: 'string', enum: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'unknown'] },
                source: { type: 'string' },
                translation: { type: 'string' },
                uncertain: { type: 'boolean' },
              },
              required: ['startMs', 'endMs', 'speaker', 'source', 'translation', 'uncertain'],
            },
          },
          language: { type: 'string' },
          uncertain: { type: 'boolean' },
        },
        required: ['utterances', 'language', 'uncertain'],
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Gemini final transcription failed (${response.status}): ${detail}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini final transcription returned no text');
  const parsed = JSON.parse(text);
  const rawUtterances = Array.isArray(parsed.utterances) ? parsed.utterances.slice(0, 50) : [];
  const utterances = rawUtterances
    .map(item => {
      const source = String(item?.source || '').trim();
      const translation = String(item?.translation || '').trim();
      if (!source && !translation) return null;
      const rawStart = Number(item?.startMs);
      const rawEnd = Number(item?.endMs);
      let startMs = Number.isFinite(rawStart) ? Math.max(0, Math.round(rawStart)) : 0;
      startMs = Math.min(wavInfo.audioDurationMs, startMs);
      let endMs = Number.isFinite(rawEnd) ? Math.max(startMs, Math.round(rawEnd)) : startMs;
      endMs = Math.min(wavInfo.audioDurationMs, endMs);
      if (endMs <= startMs) {
        startMs = Math.max(0, Math.min(startMs, wavInfo.audioDurationMs - 1));
        endMs = Math.min(wavInfo.audioDurationMs, startMs + 1);
      }
      const speaker = /^S[1-6]$/.test(String(item?.speaker || '')) ? String(item.speaker) : 'unknown';
      return {
        startMs,
        endMs,
        speaker,
        speakerEstimated: true,
        source,
        translation,
        uncertain: Boolean(item?.uncertain),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((item, index) => ({ ...item, id: `${payload.segmentId}-u${index + 1}` }));
  if (!utterances.length) {
    throw new Error('Gemini final transcription returned incomplete JSON');
  }

  return {
    schemaVersion: 2,
    segmentId: payload.segmentId,
    audioDurationMs: wavInfo.audioDurationMs,
    timingAttribution: 'model_estimated',
    utterances,
    source: utterances.map(item => item.source).filter(Boolean).join('\n'),
    translation: utterances.map(item => item.translation).filter(Boolean).join('\n'),
    language: String(parsed.language || '').trim(),
    uncertain: Boolean(parsed.uncertain) || utterances.some(item => item.uncertain),
    diarization: 'estimated',
    speakerScope: 'segment',
    model,
  };
}

export async function onRequestPost(context) {
  const requestOrigin = context.request.headers.get('origin');
  const expectedOrigin = new URL(context.request.url).origin;
  if (requestOrigin !== expectedOrigin) return jsonResponse({ error: 'Forbidden origin' }, 403);
  const contentLength = Number(context.request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) return jsonResponse({ error: 'Request body is too large' }, 413);

  try {
    await verifyFinalizeTicket({
      ticket: context.request.headers.get('x-finalize-ticket'),
      secret: context.env.FINALIZE_TICKET_SECRET || context.env.GEMINI_API_KEY,
      origin: expectedOrigin,
    });
  } catch {
    return jsonResponse({ error: 'Valid Live session ticket required' }, 401);
  }

  try {
    const payload = await readJsonBody(context.request, MAX_REQUEST_BYTES);
    const result = await finalizeAudio({
      payload,
      apiKey: context.env.GEMINI_API_KEY,
      model: context.env.FINAL_TRANSCRIPT_MODEL || DEFAULT_MODEL,
    });
    return jsonResponse(result);
  } catch (error) {
    const tooLarge = error instanceof RangeError && /too large/i.test(error.message);
    const clientError = error instanceof TypeError || error instanceof RangeError;
    if (!clientError) console.error('Final transcription failed', error);
    const status = tooLarge ? 413 : (clientError ? 400 : 502);
    return jsonResponse({ error: clientError ? error.message : 'Final transcription failed' }, status);
  }
}

export function onRequest() {
  return jsonResponse({ error: 'Method not allowed' }, 405);
}
