import { PcmChunker } from './lib/pcm-chunker.js';
import { PcmSegmentRecorder, pcm16ToWav } from './lib/audio-segment.js';
import { SegmentStore } from './lib/segment-store.js';
import { LiveSegmentQueue } from './lib/live-segment-queue.js';
import { VadState } from './lib/vad-state.js';
import { waitForMeetingDrain } from './lib/async-utils.js';
import { normalizeTranscriptMode, shouldRequestFinal } from './lib/transcription-mode.js';
import { applyFinalResult } from './lib/final-result.js';
import { formatSpeakerLabel } from './lib/speaker-label.js';
import { AdaptiveEnergyVad } from './lib/adaptive-energy-vad.js';
import { maxSegmentBytes, pcmBytesForMs, pcmDurationMs, PRE_ROLL_MS, VAD_WARMUP_MS } from './lib/segment-policy.js';
import { shouldDisableExport } from './lib/export-state.js';
import { PcmEnergyFramer } from './lib/pcm-energy-framer.js';
import { LiveBoundaryTracker } from './lib/live-boundary-tracker.js';
import { normalizeAudioCaptureMode, getAudioConstraints, formatTrackSettings } from './lib/audio-capture-mode.js';
import { SampleLedger } from './lib/sample-ledger.js';

const els = {
  title: document.querySelector('#meetingTitle'),
  badge: document.querySelector('#connectionBadge'),
  dot: document.querySelector('#recordDot'),
  state: document.querySelector('#recordState'),
  timer: document.querySelector('#timer'),
  panel: document.querySelector('#transcriptPanel'),
  list: document.querySelector('#transcriptList'),
  partial: document.querySelector('#partialLine'),
  empty: document.querySelector('#emptyState'),
  start: document.querySelector('#startBtn'),
  pause: document.querySelector('#pauseBtn'),
  stop: document.querySelector('#stopBtn'),
  exportMd: document.querySelector('#exportMdBtn'),
  exportTxt: document.querySelector('#exportTxtBtn'),
  clear: document.querySelector('#clearBtn'),
  mode: document.querySelector('#transcriptMode'),
  captureMode: document.querySelector('#audioCaptureMode'),
  participants: document.querySelector('#participants'),
  hotwords: document.querySelector('#hotwords'),
  trackSettingsBadge: document.querySelector('#trackSettingsBadge'),
  ledgerWarning: document.querySelector('#ledgerWarning'),
  privacy: document.querySelector('#privacyNote'),
};

const STORAGE_KEY = 'meeting-live:gemini:last-session:v1';
// 实时翻译模型：输入语音 → 输出中文翻译（音频+文本）
const MODEL = 'gemini-3.5-live-translate-preview';
const TARGET_LANG = 'zh-CN'; // 目标语言：中文
// 通过 Cloudflare Pages Function 代理（浏览器 → pages.dev/ws → Google），
// 国内网络无需直连 Google WSS；token 由服务端生成并注入。
const GEMINI_WS = '/ws';
const FINALIZE_ENDPOINT = '/finalize';
const RECONNECT_MS = 9 * 60 * 1000;
const PCM_CHUNK_BYTES = 3200; // 100ms @ 16kHz, 16-bit mono
const FINALIZE_TIMEOUT_MS = 20_000;

let ws = null;
let micStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let zeroGain = null;
let timerId = null;
let reconnectId = null;
let startedAt = null;
let elapsedBeforePause = 0;
let pausedAt = null;
let isPaused = false;
let isRunning = false;
let isConnecting = false;
let segmentStore = new SegmentStore();
let entries = [];
let sequence = 0;
let currentTurnText = '';
let currentTurnTranslation = '';
let activeSegmentId = null;
const liveSegmentQueue = new LiveSegmentQueue();
const liveBoundaryTracker = new LiveBoundaryTracker();
const liveSegmentTimers = new Map();
let finalizingCount = 0;
let finalizeTicket = '';
const pcmChunker = new PcmChunker(PCM_CHUNK_BYTES);
const segmentRecorder = new PcmSegmentRecorder({
  preRollBytes: pcmBytesForMs({ milliseconds: PRE_ROLL_MS, sampleRate: 16_000, bytesPerSample: 2 }),
  maxSegmentBytes: maxSegmentBytes({ sampleRate: 16_000, bytesPerSample: 2 }), // 最长15秒
});
const sampleLedger = new SampleLedger({ sampleRate: 16_000 });
let sessionSerial = 0;

function clockAt(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(timestamp));
}

function nowClock() {
  return clockAt();
}

function syncEntries() {
  entries = segmentStore.toEntries();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function currentElapsed() {
  if (!startedAt) return elapsedBeforePause;
  if (isPaused && pausedAt) return pausedAt - startedAt - elapsedBeforePause;
  return Date.now() - startedAt - elapsedBeforePause;
}

function updateTimer() {
  els.timer.textContent = formatDuration(currentElapsed());
}

function setConnection(text, state = 'idle') {
  els.badge.textContent = text;
  els.badge.className = `badge ${state}`;
}

function updateModeUi() {
  const mode = normalizeTranscriptMode(els.mode?.value);
  if (els.mode) els.mode.value = mode;
  if (els.privacy) {
    els.privacy.textContent = mode === 'accurate'
      ? '实时音频发送至 Gemini Live API；完整语音段会二次上传校对，并附带最近5条已确认原文/译文作为上下文；发言人标签仅为段内模型估计，结果文本保存在本机浏览器。'
      : '仅实时模式：音频只发送至 Gemini Live API，不进行第二次语音段上传；文本保存在本机浏览器。';
  }
}

function setUiState(mode) {
  const running = mode === 'running';
  const paused = mode === 'paused';
  const stopped = mode === 'stopped';

  document.body.className = `state-${mode || 'idle'}`;

  els.start.disabled = running || paused || isConnecting;
  els.pause.disabled = !(running || paused);
  els.stop.disabled = !(running || paused);
  if (els.mode) els.mode.disabled = running || paused || isConnecting;
  els.pause.textContent = paused ? '▶ 继续' : '⏸ 暂停';
  const exportBlocked = shouldDisableExport({ entryCount: entries.length, finalizingCount });
  els.exportMd.disabled = exportBlocked;
  els.exportTxt.disabled = exportBlocked;

  els.dot.className = 'record-pulse-dot';
  if (running) {
    els.dot.classList.add('live');
    els.state.textContent = '正在录音';
  } else if (paused) {
    els.dot.classList.add('paused');
    els.state.textContent = '已暂停';
  } else if (stopped) {
    els.state.textContent = '会议已结束';
  } else {
    els.state.textContent = '准备就绪';
  }
}

function renderEntries() {
  els.list.innerHTML = '';
  els.empty.classList.toggle('hidden', entries.length > 0 || currentTurnText.trim());

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `transcript-item ${entry.status || 'final'}`;

    const time = document.createElement('div');
    time.className = 'transcript-time';
    time.textContent = entry.time;

    const text = document.createElement('div');
    text.className = 'transcript-text';
    const speakerLabel = formatSpeakerLabel(entry);
    if (speakerLabel) {
      const speaker = document.createElement('div');
      speaker.className = 'transcript-speaker';
      speaker.textContent = speakerLabel;
      text.appendChild(speaker);
    }
    const source = document.createElement('div');
    source.className = 'transcript-source';
    source.textContent = entry.text || (entry.status === 'refining' ? '正在生成准确终稿…' : '[未识别]');
    const status = document.createElement('span');
    status.className = `transcript-status ${entry.status || 'final'}`;
    status.textContent = entry.status === 'refining' ? '校对中' : entry.status === 'failed' ? '实时稿' : '已校对';
    source.appendChild(status);
    text.appendChild(source);
    if (entry.translation) {
      const trans = document.createElement('div');
      trans.className = 'transcript-translation';
      trans.textContent = '🌐 ' + entry.translation;
      text.appendChild(trans);
    }

    row.append(time, text);
    els.list.appendChild(row);
  }

  const partialText = currentTurnText.trim();
  const partialTrans = currentTurnTranslation.trim();
  els.partial.innerHTML = '';
  if (partialText) {
    const p = document.createElement('div');
    p.className = 'partial-original';
    p.textContent = partialText;
    els.partial.appendChild(p);
  }
  if (partialTrans) {
    const t = document.createElement('div');
    t.className = 'partial-translation';
    t.textContent = '🌐 ' + partialTrans;
    els.partial.appendChild(t);
  }
  els.partial.classList.toggle('hidden', !partialText && !partialTrans);
  const exportBlocked = shouldDisableExport({ entryCount: entries.length, finalizingCount });
  els.exportMd.disabled = exportBlocked;
  els.exportTxt.disabled = exportBlocked;
  requestAnimationFrame(() => { els.panel.scrollTop = els.panel.scrollHeight; });
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    title: els.title?.value || '',
    captureMode: normalizeAudioCaptureMode(els.captureMode?.value),
    participants: els.participants?.value || '',
    hotwords: els.hotwords?.value || '',
    mode: normalizeTranscriptMode(els.mode?.value),
    entries,
    savedAt: new Date().toISOString()
  }));
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.title === 'string' && els.title) els.title.value = data.title;
    if (els.captureMode) els.captureMode.value = normalizeAudioCaptureMode(data.captureMode);
    if (typeof data.participants === 'string' && els.participants) els.participants.value = data.participants;
    if (typeof data.hotwords === 'string' && els.hotwords) els.hotwords.value = data.hotwords;
    if (els.mode) els.mode.value = normalizeTranscriptMode(data.mode);
    updateModeUi();
    if (Array.isArray(data.entries)) {
      segmentStore.importEntries(data.entries);
      syncEntries();
    }
    sequence = entries.length;
    renderEntries();
  } catch (e) {
    console.warn('Could not restore local transcript', e);
  }
}

function mergeTranscript(prev, next) {
  const a = (prev || '').trim();
  const b = (next || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  if (a.endsWith(b)) return a;
  return `${a}${/^[,，。.!！？?\s]/.test(b) ? '' : ' '}${b}`;
}

function clearLiveTimer(id) {
  const timer = liveSegmentTimers.get(id);
  if (timer) clearTimeout(timer);
  liveSegmentTimers.delete(id);
}

function expireLiveSegment(id) {
  clearLiveTimer(id);
  return liveSegmentQueue.expire(id);
}

function enqueueLiveSegment(id, session) {
  liveSegmentQueue.enqueue(id, session);
  clearLiveTimer(id);
  liveSegmentTimers.set(id, setTimeout(() => expireLiveSegment(id), 2500));
}

function completeLiveSegment(session) {
  const id = liveSegmentQueue.complete(session);
  if (id) clearLiveTimer(id);
  return id;
}

function clearLiveSession(session) {
  const ids = liveSegmentQueue.clearSession(session);
  for (const id of ids) clearLiveTimer(id);
  liveBoundaryTracker.clear(session);
}

function clearAllLiveSegments() {
  for (const id of liveSegmentQueue.clear()) clearLiveTimer(id);
  liveBoundaryTracker.clear();
}

function appendCurrentDraftToSegment(id) {
  const source = currentTurnText.trim();
  const translation = currentTurnTranslation.trim();
  currentTurnText = '';
  currentTurnTranslation = '';
  if (source || translation) segmentStore.appendDraft(id, { source, translation });
  syncEntries();
  persist();
  renderEntries();
}

function commitCurrentTurn() {
  const text = currentTurnText.trim();
  const translation = currentTurnTranslation.trim();
  if (!text && !translation) {
    renderEntries();
    return;
  }

  // 正在录音时只显示草稿，等VAD结束后再用同一segment落条。
  if (activeSegmentId) {
    renderEntries();
    return;
  }

  const liveTarget = liveSegmentQueue.target(sessionSerial);
  if (liveTarget && segmentStore.get(liveTarget)) {
    appendCurrentDraftToSegment(liveTarget);
    return;
  }

  // 没有对应音频段时保留实时稿，但明确标记为未经过二次校对。
  const id = `live-${Date.now()}-${sequence++}`;
  segmentStore.create({ id, time: nowClock(), startedAt: Date.now() });
  segmentStore.appendDraft(id, { source: text, translation });
  segmentStore.markFailed(id, 'No captured audio segment');
  currentTurnText = '';
  currentTurnTranslation = '';
  syncEntries();
  persist();
  renderEntries();
}

// 没有对应已封段segment的Live增量，保留短暂窗口后降级为“实时稿”。
let orphanCommitTimer = null;
function scheduleOrphanCommit() {
  if (orphanCommitTimer) clearTimeout(orphanCommitTimer);
  orphanCommitTimer = setTimeout(() => {
    if (!isRunning || activeSegmentId || liveSegmentQueue.target(sessionSerial)) return;
    if (currentTurnText.trim() || currentTurnTranslation.trim()) commitCurrentTurn();
  }, 2500);
}

function handleGeminiMessage(message, serial = sessionSerial) {
  if (message.sessionControl?.finalizeTicket) {
    finalizeTicket = message.sessionControl.finalizeTicket;
    return;
  }
  if (message.setupComplete) {
    setConnection('已连接', 'live');
    return;
  }

  const content = message.serverContent;
  if (!content) return;
  const source = content.inputTranscription?.text || '';
  const translation = content.outputTranscription?.text || '';
  const liveTarget = liveSegmentQueue.target(serial);

  if ((source || translation) && liveTarget && segmentStore.get(liveTarget)) {
    segmentStore.appendDraft(liveTarget, { source, translation });
    syncEntries();
    persist();
    renderEntries();
  } else {
    if (source) currentTurnText = mergeTranscript(currentTurnText, source);
    if (translation) currentTurnTranslation = mergeTranscript(currentTurnTranslation, translation);
    if (source || translation) {
      renderEntries();
      scheduleOrphanCommit();
    }
  }

  if (content.turnComplete) {
    liveBoundaryTracker.completed(serial);
    if (liveTarget) completeLiveSegment(serial);
    else commitCurrentTurn();
  }
}

function bytesToBase64(uint8) {
  // 用循环拼接，避免 String.fromCharCode(...大数组) 在移动端栈溢出
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    const slice = uint8.subarray(i, i + chunk);
    let part = '';
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]);
    binary += part;
  }
  return btoa(binary);
}

function sendPcmChunk(pcm) {
  if (!pcm?.byteLength || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: bytesToBase64(pcm),
        mimeType: 'audio/pcm;rate=16000'
      }
    }
  }));
  sentPackets += 1;
  sentBytes += pcm.byteLength;
  renderDiagnostics();
}

function startAccurateSegment(startedAt) {
  if (activeSegmentId) return;
  const id = `seg-${startedAt}-${sequence++}`;
  const preRollMs = pcmDurationMs({
    bytes: segmentRecorder.bufferedPreRollBytes,
    sampleRate: 16_000,
    bytesPerSample: 2,
  });
  const clipStartedAt = Math.max(0, startedAt - Math.round(preRollMs));
  activeSegmentId = id;
  segmentRecorder.start({ id, startedAt: clipStartedAt });
}

function previousFinalContext(segmentId) {
  return segmentStore.toEntries()
    .filter(entry => entry.id !== segmentId && entry.status === 'final' && entry.text)
    .slice(-5)
    .map(entry => ({ source: entry.text, translation: entry.translation }));
}

async function requestFinalTranscript(recorded) {
  const store = segmentStore;
  const segment = store.get(recorded.id);
  if (!segment) return;
  const wav = pcm16ToWav(recorded.pcm, 16000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FINALIZE_TIMEOUT_MS);
  finalizingCount += 1;
  renderDiagnostics();

  try {
    const headers = { 'content-type': 'application/json' };
    if (finalizeTicket) headers['x-finalize-ticket'] = finalizeTicket;
    const response = await fetch(FINALIZE_ENDPOINT, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        segmentId: recorded.id,
        audioBase64: bytesToBase64(wav),
        mimeType: 'audio/wav',
        draftSource: segment.sourceDraft,
        previousContext: previousFinalContext(recorded.id),
        meetingTitle: els.title?.value || '',
        participants: els.participants?.value || '',
        hotwords: els.hotwords?.value || '',
      }),
    });
    if (!response.ok) throw new Error(`终稿接口返回 ${response.status}`);
    const result = await response.json();
    if (result.segmentId !== recorded.id) throw new Error('终稿segmentId不匹配');
    applyFinalResult(store, recorded.id, result);
  } catch (error) {
    console.warn('Accurate final transcript failed', recorded.id, error);
    store.markFailed(recorded.id, error.name === 'AbortError' ? '终稿请求超时' : error.message);
  } finally {
    clearTimeout(timeout);
    finalizingCount = Math.max(0, finalizingCount - 1);
    if (store === segmentStore) {
      syncEntries();
      persist();
      renderEntries();
    }
    renderDiagnostics();
  }
}

function discardAccurateSegment(endedAt = Date.now()) {
  if (!activeSegmentId) return;
  activeSegmentId = null;
  segmentRecorder.finish({ endedAt });
}

function closeAccurateSegment(endedAt = Date.now()) {
  if (!activeSegmentId) return null;
  const id = activeSegmentId;
  activeSegmentId = null;
  const recorded = segmentRecorder.finish({ endedAt });
  if (!recorded) return null;

  segmentStore.create({ id, time: clockAt(recorded.startedAt), startedAt: recorded.startedAt });
  segmentStore.appendDraft(id, {
    source: currentTurnText,
    translation: currentTurnTranslation,
  });
  currentTurnText = '';
  currentTurnTranslation = '';
  enqueueLiveSegment(id, sessionSerial);
  const accurateMode = shouldRequestFinal(els.mode?.value);
  if (!accurateMode) segmentStore.markFailed(id, 'Live-only mode');
  syncEntries();
  persist();
  renderEntries();
  if (accurateMode) requestFinalTranscript(recorded);
  return recorded;
}

// 前端 VAD：检测静音停顿，自动发送 audioStreamEnd 触发 Gemini 返回转录
const VAD_SILENCE_MS = 900;   // 会议静音900ms再形成终稿，保护连续发言与短暂停顿
const VAD_MIN_SPEECH_MS = 150; // 累计150ms有效语音帧，确保短应答（如"Dạ"、"对"）不被漏录
const vadState = new VadState({ silenceMs: VAD_SILENCE_MS, minVoicedMs: VAD_MIN_SPEECH_MS });
const energyVad = new AdaptiveEnergyVad({ warmupMs: VAD_WARMUP_MS, historyMs: 12_000, recomputeIntervalMs: 250 });
const energyFramer = new PcmEnergyFramer({ frameBytes: 1600, frameMs: 50 });

function detectAndSendStreamEnd(pcm, isPaused) {
  if (isPaused || !ws || ws.readyState !== WebSocket.OPEN) return;

  for (const frame of energyFramer.push(pcm)) {
    const now = Date.now();
    const classified = energyVad.classify({
      energy: frame.energy,
      frameMs: frame.frameMs,
      active: vadState.speaking,
    });
    const result = vadState.observe({ speaking: classified.speaking, now, frameMs: frame.frameMs });

    if (result.started) startAccurateSegment(now);
    if (!result.ended) continue;

    if (result.accepted) {
      // 同一语音段：先封存音频并创建segment，再通知Live输出草稿。
      closeAccurateSegment(now);
      sendAudioStreamEnd();
    } else {
      discardAccurateSegment(now);
    }
  }
}
let micLevel = 0;
let sentPackets = 0;
let sentBytes = 0;
let recvMessages = 0;

function updateMicLevel(pcm) {
  // 用 Int16 采样估算音量（0~100）
  const view = new Int16Array(pcm.buffer || pcm, pcm.byteOffset || 0, Math.floor(pcm.byteLength / 2));
  let peak = 0;
  const step = Math.max(1, Math.floor(view.length / 64));
  for (let i = 0; i < view.length; i += step) {
    const v = Math.abs(view[i]);
    if (v > peak) peak = v;
  }
  micLevel = Math.min(100, Math.round((peak / 32767) * 100));
  const el = document.getElementById('micLevel');
  if (el) {
    el.style.width = micLevel + '%';
    el.textContent = micLevel > 0 ? String(micLevel) : '';
  }
}

function renderDiagnostics() {
  const el = document.getElementById('diagInfo');
  if (el) {
    el.textContent = `音频↑${sentPackets}包/${(sentBytes / 1024).toFixed(1)}KB · 服务端消息↓${recvMessages} · 终稿处理中${finalizingCount}`;
  }
  if (els.ledgerWarning) {
    const telemetry = sampleLedger.getTelemetry();
    if (telemetry.hasWarning) {
      els.ledgerWarning.textContent = telemetry.warningText;
      els.ledgerWarning.classList.remove('hidden');
    } else {
      els.ledgerWarning.classList.add('hidden');
    }
  }
  const exportBlocked = shouldDisableExport({ entryCount: entries.length, finalizingCount });
  els.exportMd.disabled = exportBlocked;
  els.exportTxt.disabled = exportBlocked;
}

async function fetchToken() {
  // 代理模式下由服务端 /ws 自动获取 token，前端不再单独请求。
  // 保留该函数仅用于兼容 /token 端点（本地直连模式）。
  if (GEMINI_WS.startsWith('/')) return { token: '' };
  const response = await fetch('/token', { method: 'POST' });
  if (!response.ok) throw new Error(`Token failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function sendAudioStreamEnd() {
  const remainder = pcmChunker.flush();
  if (remainder.byteLength) sendPcmChunk(remainder);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    liveBoundaryTracker.sent(sessionSerial);
  }
  scheduleOrphanCommit();
}

function forceAudioBoundary({ notifyLive = true, endedAt = Date.now() } = {}) {
  if (activeSegmentId) closeAccurateSegment(endedAt);
  if (notifyLive) sendAudioStreamEnd();
  else pcmChunker.reset();
  vadState.reset();
  energyVad.reset();
  energyFramer.reset();
}

async function decodeGeminiFrame(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (data && typeof data.arrayBuffer === 'function') {
    return new TextDecoder().decode(await data.arrayBuffer());
  }
  throw new TypeError(`Unsupported Gemini WebSocket frame: ${Object.prototype.toString.call(data)}`);
}

async function connectGemini({ reconnect = false } = {}) {
  if (!isRunning && reconnect) return;
  if (isConnecting) return;
  isConnecting = true;
  setConnection(reconnect ? '自动续接中…' : '连接中…');
  setUiState(isPaused ? 'paused' : (isRunning ? 'running' : 'idle'));

  const serial = ++sessionSerial;
  finalizeTicket = '';

  try {
    const { token } = await fetchToken();
    const wsUrl = GEMINI_WS.startsWith('/')
      ? GEMINI_WS  // 代理模式：浏览器 → pages.dev/ws，token 服务端注入
      : `${GEMINI_WS}?access_token=${encodeURIComponent(token)}`;  // 本地直连模式
    const socket = new WebSocket(wsUrl);
    // 显式要求二进制帧为 ArrayBuffer，避免 Safari 默认 Blob 的异步读取路径。
    socket.binaryType = 'arraybuffer';
    ws = socket;

    // 必须在发送 setup 之前注册，避免移动网络下 setupComplete 到达过快而丢失。
    socket.addEventListener('message', async (event) => {
      try {
        const decoded = await decodeGeminiFrame(event.data);
        if (serial !== sessionSerial || socket !== ws) return;
        recvMessages += 1;
        renderDiagnostics();
        handleGeminiMessage(JSON.parse(decoded), serial);
      } catch (error) {
        console.warn('Bad Gemini message', error);
      }
    });

    socket.addEventListener('close', () => {
      if (serial !== sessionSerial || !isRunning) return;
      // 断线期间的音频不会送达上游，因此把旧会话原子封段并从新会话隔离。
      forceAudioBoundary({ notifyLive: false });
      clearLiveSession(serial);
      if (ws === socket) ws = null;
      const reconnectGuard = ++sessionSerial;
      setConnection('连接断开', 'error');
      window.setTimeout(() => {
        if (isRunning && reconnectGuard === sessionSerial) connectGemini({ reconnect: true }).catch(console.error);
      }, 1200);
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Gemini WebSocket connection timeout.')), 12000);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        socket.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              translationConfig: { targetLanguageCode: TARGET_LANG, echoTargetLanguage: true }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                prefixPaddingMs: 250,
                silenceDurationMs: 650
              }
            },
            systemInstruction: {
              parts: [{
                text: 'You are a silent meeting translation listener. Do not speak, answer, summarize, or interrupt. Listen to Chinese, Vietnamese, and English technical project meetings and translate them into Chinese. CRITICAL: Strictly distinguish English from Vietnamese. Do not mistake English greetings or words ("Hello", "Hi", "Testing", "OK", "Can you hear me") for Vietnamese ("Alo", "Chào"). Transcribe English speech strictly in English, Vietnamese in Vietnamese, and Chinese in Chinese. Pay special attention to photovoltaic power, battery energy storage systems, EPC, grid connection, EMS, PCS, BMS, SCADA, 10kV, 35kV, 110kV, floating PV, fire protection, commissioning, acceptance, contracts, responsibilities, schedules, risks, and engineering decisions. Only the input audio transcription and output translation are used by the application.'
              }]
            }
          }
        }));
        resolve();
      }, { once: true });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Gemini WebSocket connection failed.'));
      }, { once: true });
    });

    if (reconnectId) clearTimeout(reconnectId);
    reconnectId = window.setTimeout(async () => {
      if (!isRunning) return;
      const oldSession = sessionSerial;
      forceAudioBoundary();
      clearLiveSession(oldSession);
      sessionSerial += 1;
      try { ws?.close(); } catch {}
      ws = null;
      await connectGemini({ reconnect: true });
    }, RECONNECT_MS);

    setConnection('已连接', 'live');
  } finally {
    isConnecting = false;
    setUiState(isPaused ? 'paused' : (isRunning ? 'running' : 'idle'));
  }
}

async function startAudioCapture() {
  const mode = normalizeAudioCaptureMode(els.captureMode?.value);
  const constraints = getAudioConstraints(mode);
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: constraints
  });

  const track = micStream.getAudioTracks()[0];
  const settings = track?.getSettings();
  if (els.trackSettingsBadge) {
    els.trackSettingsBadge.textContent = formatTrackSettings(settings, mode);
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass();
  await audioContext.audioWorklet.addModule('/pcm-processor.js');
  await audioContext.resume();

  sourceNode = audioContext.createMediaStreamSource(micStream);
  processorNode = new AudioWorkletNode(audioContext, 'pcm16-downsampler', {
    processorOptions: { targetSampleRate: 16000 }
  });
  zeroGain = audioContext.createGain();
  zeroGain.gain.value = 0;

  processorNode.port.onmessage = (event) => {
    if (!isRunning || isPaused || !ws || ws.readyState !== WebSocket.OPEN) return;
    const pcm = new Uint8Array(event.data);
    sampleLedger.addBytes(pcm.byteLength);
    const recordingState = segmentRecorder.push(pcm);
    updateMicLevel(event.data);
    for (const chunk of pcmChunker.push(pcm)) sendPcmChunk(chunk);
    if (recordingState.full && activeSegmentId) {
      closeAccurateSegment(Date.now());
      sendAudioStreamEnd();
      vadState.reset();
      energyFramer.reset(); // 保留整场底噪历史，只丢弃跨segment的未完成分析帧
      return;
    }
    detectAndSendStreamEnd(event.data, isPaused);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(zeroGain);
  zeroGain.connect(audioContext.destination);
  document.getElementById('micMeter')?.classList.remove('hidden');
}

async function startMeeting() {
  if (isRunning || isConnecting) return;
  isRunning = true;
  isPaused = false;
  pcmChunker.reset();
  segmentRecorder.reset();
  activeSegmentId = null;
  clearAllLiveSegments();
  if (orphanCommitTimer) clearTimeout(orphanCommitTimer);
  orphanCommitTimer = null;
  vadState.reset();
  energyVad.reset();
  energyFramer.reset();
  sentPackets = 0;
  sentBytes = 0;
  recvMessages = 0;
  startedAt = Date.now();
  sampleLedger.start(startedAt);
  if (els.ledgerWarning) els.ledgerWarning.classList.add('hidden');
  elapsedBeforePause = 0;
  pausedAt = null;
  setUiState('running');
  setConnection('准备麦克风…');

  try {
    await startAudioCapture();
    await connectGemini();
    timerId = window.setInterval(updateTimer, 500);
    updateTimer();
    persist();
  } catch (error) {
    console.error(error);
    isRunning = false;
    setConnection('启动失败', 'error');
    setUiState('idle');
    await cleanupConnection();
    alert(`无法开始转录：${error.message}\n\n请确认：\n1. 页面通过 HTTPS 打开（localhost 除外）\n2. 已允许麦克风权限\n3. 服务端 GEMINI_API_KEY 正确且已启用 Gemini API`);
  }
}

async function togglePause() {
  if (!isRunning || !micStream) return;

  if (!isPaused) {
    isPaused = true;
    pausedAt = Date.now();
    forceAudioBoundary({ endedAt: pausedAt });
    micStream.getAudioTracks().forEach(t => { t.enabled = false; });
    setUiState('paused');
  } else {
    if (pausedAt) elapsedBeforePause += Date.now() - pausedAt;
    pausedAt = null;
    isPaused = false;
    micStream.getAudioTracks().forEach(t => { t.enabled = true; });
    await audioContext?.resume();
    setUiState('running');
  }
  updateTimer();
}

async function cleanupConnection() {
  if (orphanCommitTimer) clearTimeout(orphanCommitTimer);
  orphanCommitTimer = null;
  if (timerId) clearInterval(timerId);
  if (reconnectId) clearTimeout(reconnectId);
  timerId = null;
  reconnectId = null;
  sessionSerial += 1;

  try { ws?.close(); } catch {}
  ws = null;
  pcmChunker.reset();
  segmentRecorder.reset();
  activeSegmentId = null;
  vadState.reset();
  energyVad.reset();
  energyFramer.reset();
  clearAllLiveSegments();

  try { sourceNode?.disconnect(); } catch {}
  try { processorNode?.disconnect(); } catch {}
  try { zeroGain?.disconnect(); } catch {}
  processorNode = null;
  sourceNode = null;
  zeroGain = null;

  if (micStream) micStream.getTracks().forEach(track => track.stop());
  micStream = null;

  if (audioContext) {
    try { await audioContext.close(); } catch {}
  }
  audioContext = null;
}

async function stopMeeting() {
  if (!isRunning) return;
  updateTimer();
  isPaused = true;
  micStream?.getAudioTracks().forEach(track => { track.enabled = false; });
  const drainSession = sessionSerial;
  forceAudioBoundary();
  setConnection('正在收尾并等待终稿…');
  await waitForMeetingDrain({
    hasLivePending: () => Boolean(liveSegmentQueue.target(drainSession))
      || liveBoundaryTracker.hasPending(drainSession),
    hasFinalPending: () => finalizingCount > 0,
    liveTimeoutMs: 3500,
    finalTimeoutMs: FINALIZE_TIMEOUT_MS + 1000,
  });
  commitCurrentTurn();
  isRunning = false;
  await cleanupConnection();
  persist();
  setConnection('已结束');
  setUiState('stopped');
}

function safeFilename() {
  const title = (els.title.value || 'meeting').trim().replace(/[\\/:*?"<>|]+/g, '-');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${title}-${stamp}`;
}

function buildMarkdown() {
  const title = (els.title.value || '会议记录').trim();
  const lines = [`# ${title}`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '', '## 实时记录', ''];
  for (const item of entries) {
    const speaker = formatSpeakerLabel(item);
    lines.push(`**${item.time}${speaker ? ` · ${speaker}` : ''}**`, '', item.text || '[未识别]');
    if (item.translation) lines.push('', `🌐 ${item.translation}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildText() {
  const title = (els.title.value || '会议记录').trim();
  return [title, `导出时间：${new Date().toLocaleString('zh-CN')}`, '', ...entries.map(item => {
    const speaker = formatSpeakerLabel(item);
    return `[${item.time}]${speaker ? ` [${speaker}]` : ''} ${item.text}${item.translation ? `\n🌐 ${item.translation}` : ''}`;
  })].join('\n');
}

function download(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearTranscript() {
  if (isRunning) return alert('请先结束当前会议。');
  if (entries.length && !confirm('确定清空本机保存的会议记录？')) return;
  segmentStore = new SegmentStore();
  entries = [];
  sequence = 0;
  currentTurnText = '';
  currentTurnTranslation = '';
  localStorage.removeItem(STORAGE_KEY);
  els.title.value = '';
  els.timer.textContent = '00:00:00';
  startedAt = null;
  elapsedBeforePause = 0;
  renderEntries();
  setUiState('idle');
  setConnection('未连接');
}

els.start.addEventListener('click', startMeeting);
els.pause.addEventListener('click', togglePause);
els.stop.addEventListener('click', stopMeeting);
els.exportMd.addEventListener('click', () => download(buildMarkdown(), `${safeFilename()}.md`, 'text/markdown'));
els.exportTxt.addEventListener('click', () => download(buildText(), `${safeFilename()}.txt`, 'text/plain'));
els.clear.addEventListener('click', clearTranscript);
els.title?.addEventListener('input', persist);
els.participants?.addEventListener('input', persist);
els.hotwords?.addEventListener('input', persist);
els.captureMode?.addEventListener('change', persist);
els.mode?.addEventListener('change', () => {
  updateModeUi();
  persist();
});

window.addEventListener('beforeunload', () => {
  persist();
  cleanupConnection();
});

restore();
updateModeUi();
setUiState('idle');
