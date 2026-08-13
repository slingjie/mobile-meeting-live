// Cloudflare Pages Function — WebSocket 代理
// 浏览器 → pages.dev/ws → (Cloudflare 服务器) → Google Gemini Live WSS
// 解决国内网络无法直连 Google WSS 的问题；GEMINI_API_KEY 不出 Cloudflare。

const GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

async function createEphemeralToken(apiKey) {
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${body}`);
  const data = JSON.parse(body);
  if (!data.name) throw new Error('Gemini did not return an ephemeral token.');
  return data.name;
}

export async function onRequestGet(context) {
  const apiKey = context.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response('GEMINI_API_KEY is not configured on the server.', { status: 500 });
  }

  let token;
  try {
    token = await createEphemeralToken(apiKey);
  } catch (error) {
    return new Response(`Token failed: ${error.message}`, { status: 500 });
  }

  // 升级浏览器请求为 WebSocket
  const pair = new WebSocketPair();
  const [client, server] = pair;
  server.accept();

  // 连接 Google 上游（Cloudflare 边缘出网，可访问 Google）
  const upstreamUrl = `${GEMINI_WS}?access_token=${encodeURIComponent(token)}`;
  const upstream = new WebSocket(upstreamUrl);

  // 竞态防护：浏览器 open 后可能立即发 setup，此时上游还在 CONNECTING。
  // 先把消息排队，等上游 open 后再补发。
  const pending = [];
  let upstreamOpen = false;

  upstream.addEventListener('open', () => {
    upstreamOpen = true;
    while (pending.length) {
      const msg = pending.shift();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
    }
  });
  upstream.addEventListener('error', () => {
    if (server.readyState === WebSocket.OPEN) server.close(1011, 'upstream error');
  });

  // 双向转发（server→upstream 带排队）
  server.addEventListener('message', (event) => {
    const data = event.data;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      pending.push(data);
    }
  });
  upstream.addEventListener('message', async (event) => {
    if (server.readyState !== WebSocket.OPEN) return;
    let data = event.data;
    // 尽量保持文本帧：Gemini 的 JSON 消息是文本，直接字符串转发。
    // 只有真正的二进制（音频响应）才转 ArrayBuffer。
    if (typeof data === 'object' && data !== null) {
      if (typeof data.text === 'function' && !(data instanceof ArrayBuffer)) {
        // Blob 或类似对象：先尝试文本
        try {
          const text = await data.text();
          if (text && text.trimStart().startsWith('{')) {
            data = text; // JSON 消息按文本转发
          } else {
            data = await data.arrayBuffer();
          }
        } catch {
          data = String(data);
        }
      } else if (typeof data.arrayBuffer === 'function') {
        data = await data.arrayBuffer();
      } else {
        data = String(data);
      }
    }
    server.send(data);
  });

  server.addEventListener('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
  upstream.addEventListener('close', () => {
    if (server.readyState === WebSocket.OPEN) server.close();
  });
  upstream.addEventListener('error', () => {
    if (server.readyState === WebSocket.OPEN) server.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}
