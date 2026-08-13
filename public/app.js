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
};

const STORAGE_KEY = 'meeting-live:gemini:last-session:v1';
// 实时翻译模型：输入语音 → 输出中文翻译（音频+文本）
const MODEL = 'gemini-3.5-live-translate-preview';
const TARGET_LANG = 'zh-CN'; // 目标语言：中文
// 通过 Cloudflare Pages Function 代理（浏览器 → pages.dev/ws → Google），
// 国内网络无需直连 Google WSS；token 由服务端生成并注入。
const GEMINI_WS = '/ws';
const RECONNECT_MS = 9 * 60 * 1000;

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
let entries = [];
let sequence = 0;
let currentTurnText = '';
let currentTurnTranslation = '';
let sessionSerial = 0;

function nowClock() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
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

function setUiState(mode) {
  const running = mode === 'running';
  const paused = mode === 'paused';
  const stopped = mode === 'stopped';

  els.start.disabled = running || paused || isConnecting;
  els.pause.disabled = !(running || paused);
  els.stop.disabled = !(running || paused);
  els.pause.textContent = paused ? '继续' : '暂停';
  els.exportMd.disabled = entries.length === 0;
  els.exportTxt.disabled = entries.length === 0;

  els.dot.className = 'record-dot';
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
    row.className = 'transcript-item';

    const time = document.createElement('div');
    time.className = 'transcript-time';
    time.textContent = entry.time;

    const text = document.createElement('div');
    text.className = 'transcript-text';
    text.textContent = entry.text;
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
  els.exportMd.disabled = entries.length === 0;
  els.exportTxt.disabled = entries.length === 0;
  requestAnimationFrame(() => { els.panel.scrollTop = els.panel.scrollHeight; });
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    title: els.title.value,
    entries,
    savedAt: new Date().toISOString()
  }));
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.title === 'string') els.title.value = data.title;
    if (Array.isArray(data.entries)) entries = data.entries;
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

function commitCurrentTurn() {
  const text = currentTurnText.trim();
  const translation = currentTurnTranslation.trim();
  currentTurnText = '';
  currentTurnTranslation = '';
  if (!text) {
    renderEntries();
    return;
  }

  const previous = entries.at(-1)?.text || '';
  if (previous === text) {
    renderEntries();
    return;
  }

  entries.push({ id: `g-${Date.now()}-${sequence}`, seq: sequence++, time: nowClock(), text, translation });
  persist();
  renderEntries();
}

function handleGeminiMessage(message) {
  if (message.setupComplete) {
    setConnection('已连接', 'live');
    return;
  }

  const content = message.serverContent;
  if (!content) return;

  if (content.inputTranscription?.text) {
    currentTurnText = mergeTranscript(currentTurnText, content.inputTranscription.text);
    renderEntries();
  }

  if (content.outputTranscription?.text) {
    currentTurnTranslation = mergeTranscript(currentTurnTranslation, content.outputTranscription.text);
    renderEntries();
  }

  if (content.turnComplete) commitCurrentTurn();
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

// 前端 VAD：检测静音停顿，自动发送 audioStreamEnd 触发 Gemini 返回转录
const VAD_SILENCE_MS = 700;   // 静音持续 700ms 视为句子结束
const VAD_MIN_SPEECH_MS = 200; // 至少 200ms 语音才值得切句
let vadSpeaking = false;
let vadSpeechStart = 0;
let vadSilenceStart = 0;
let vadLastPacket = 0;

function detectAndSendStreamEnd(pcm, isPaused) {
  if (isPaused || !ws || ws.readyState !== WebSocket.OPEN) return;

  const view = new Int16Array(pcm.buffer || pcm, pcm.byteOffset || 0, Math.floor(pcm.byteLength / 2));
  let energy = 0;
  for (let i = 0; i < view.length; i++) {
    const v = Math.abs(view[i]);
    energy += v;
  }
  energy /= Math.max(1, view.length);

  const now = Date.now();
  const THRESHOLD = 400; // 16bit 振幅阈值，低于视为静音（环境噪声通常 <100）
  const speaking = energy >= THRESHOLD;

  if (speaking && !vadSpeaking) {
    vadSpeaking = true;
    vadSpeechStart = now;
    vadSilenceStart = 0;
  } else if (!speaking && vadSpeaking) {
    if (!vadSilenceStart) vadSilenceStart = now;
    if (now - vadSilenceStart >= VAD_SILENCE_MS) {
      if (now - vadSpeechStart >= VAD_MIN_SPEECH_MS) {
        // 一句说完：发 streamEnd 让 Gemini 输出转录
        sendAudioStreamEnd();
      }
      vadSpeaking = false;
      vadSilenceStart = 0;
    }
  } else if (speaking) {
    vadSilenceStart = 0;
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
  if (!el) return;
  el.textContent = `音频↑${sentPackets}包/${(sentBytes / 1024).toFixed(1)}KB · 服务端消息↓${recvMessages}`;
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
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }
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
      recvMessages += 1;
      renderDiagnostics();
      try {
        handleGeminiMessage(JSON.parse(await decodeGeminiFrame(event.data)));
      } catch (error) {
        console.warn('Bad Gemini message', error);
      }
    });

    socket.addEventListener('close', () => {
      if (serial !== sessionSerial || !isRunning) return;
      setConnection('连接断开', 'error');
      window.setTimeout(() => {
        if (isRunning && serial === sessionSerial) connectGemini({ reconnect: true }).catch(console.error);
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
                text: 'You are a silent meeting translation listener. Do not speak, answer, summarize, or interrupt. Listen to Chinese, Vietnamese, and English technical project meetings and translate them into Chinese. Pay special attention to photovoltaic power, battery energy storage systems, EPC, grid connection, EMS, PCS, BMS, SCADA, 10kV, 35kV, 110kV, floating PV, fire protection, commissioning, acceptance, contracts, responsibilities, schedules, risks, and engineering decisions. Only the input audio transcription and output translation are used by the application.'
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
      commitCurrentTurn();
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
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    }
  });

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
    updateMicLevel(event.data);
    detectAndSendStreamEnd(event.data, isPaused);
    sentPackets += 1;
    sentBytes += pcm.byteLength;
    renderDiagnostics();
    const msg = JSON.stringify({
      realtimeInput: {
        audio: {
          data: bytesToBase64(pcm),
          mimeType: 'audio/pcm;rate=16000'
        }
      }
    });
    ws.send(msg);
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
  startedAt = Date.now();
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
    sendAudioStreamEnd();
    micStream.getAudioTracks().forEach(t => { t.enabled = false; });
    commitCurrentTurn();
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
  if (timerId) clearInterval(timerId);
  if (reconnectId) clearTimeout(reconnectId);
  timerId = null;
  reconnectId = null;
  sessionSerial += 1;

  try { sendAudioStreamEnd(); } catch {}
  try { ws?.close(); } catch {}
  ws = null;

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
  commitCurrentTurn();
  isRunning = false;
  isPaused = false;
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
  for (const item of entries) lines.push(`**${item.time}**`, '', item.text, '');
  return lines.join('\n');
}

function buildText() {
  const title = (els.title.value || '会议记录').trim();
  return [title, `导出时间：${new Date().toLocaleString('zh-CN')}`, '', ...entries.map(item => `[${item.time}] ${item.text}${item.translation ? `\n🌐 ${item.translation}` : ''}`)].join('\n');
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
  entries = [];
  sequence = 0;
  currentTurnText = '';
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
els.title.addEventListener('input', persist);

window.addEventListener('beforeunload', () => {
  persist();
  cleanupConnection();
});

restore();
setUiState('idle');
