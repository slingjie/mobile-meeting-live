import { readFile } from 'node:fs/promises';
import { WebSocket } from 'undici';

const endpoint = process.env.MEETING_WS_URL;
const audioPath = process.argv[2];

if (!endpoint || !audioPath) {
  console.error('Usage: MEETING_WS_URL=wss://<preview-host>/ws node scripts/verify-ws.mjs <16kHz-mono-PCM-or-WAV-file>');
  process.exit(2);
}

function wavData(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return buffer;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk.');
}

const pcm = wavData(await readFile(audioPath));
const socket = new WebSocket(endpoint);
socket.binaryType = 'arraybuffer';
let setupComplete = false;
let transcription = '';
let translation = '';
let received = 0;
let finished = false;

const timeout = setTimeout(() => finish(new Error('Timed out waiting for transcription and translation.')), 45000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try { socket.close(); } catch {}
  if (error) {
    console.error(`FAIL: ${error.message} setupComplete=${setupComplete} messages=${received} transcription=${JSON.stringify(transcription)} translation=${JSON.stringify(translation)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: setupComplete + inputTranscription + outputTranscription (${transcription} -> ${translation})`);
  }
}

function sendAudioInChunks() {
  const chunkBytes = 3200; // 100ms of 16kHz, 16-bit mono PCM
  let offset = 0;
  const interval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return clearInterval(interval);
    if (offset >= pcm.length) {
      clearInterval(interval);
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      return;
    }
    const chunk = pcm.subarray(offset, offset + chunkBytes);
    offset += chunk.length;
    socket.send(JSON.stringify({ realtimeInput: {
      audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
    } }));
  }, 100);
}

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    setup: {
      model: 'models/gemini-3.5-live-translate-preview',
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: { targetLanguageCode: 'zh-CN', echoTargetLanguage: true }
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  }));
});

socket.addEventListener('message', (event) => {
  received += 1;
  const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
  const message = JSON.parse(text);
  if (message.setupComplete && !setupComplete) {
    setupComplete = true;
    sendAudioInChunks();
  }
  if (message.serverContent?.inputTranscription?.text) {
    transcription += message.serverContent.inputTranscription.text;
  }
  if (message.serverContent?.outputTranscription?.text) {
    translation += message.serverContent.outputTranscription.text;
  }
  if (transcription && translation) {
    finish();
  }
});

socket.addEventListener('error', () => finish(new Error('WebSocket error.')));
socket.addEventListener('close', () => {
  if (!transcription && !process.exitCode) finish(new Error('WebSocket closed before transcription.'));
});
