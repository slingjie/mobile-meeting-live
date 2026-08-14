import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { finalizeAudio } from './functions/finalize.js';

// 若设置了 HTTP(S)_PROXY / ALL_PROXY（如本机 Clash 7890），
// 让内置 fetch 走代理，否则直连 Google API 会被墙。
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[proxy] fetch 已启用环境代理');
  } catch (error) {
    console.warn('[proxy] 启用代理失败，将直连:', error.message);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

async function loadEnvFile() {
  try {
    const text = await fs.readFile(path.join(__dirname, '.env'), 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

await loadEnvFile();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const apiKey = process.env.GEMINI_API_KEY;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 4_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new RangeError('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function createEphemeralToken() {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server.');

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      uses: 1,
      expireTime,
      newSessionExpireTime
    })
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${body}`);

  const data = JSON.parse(body);
  if (!data.name) throw new Error('Gemini did not return an ephemeral token.');
  return {
    token: data.name,
    expireTime: data.expireTime || expireTime
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, provider: 'gemini', hasApiKey: Boolean(apiKey) }), 'application/json; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      try {
        const token = await createEphemeralToken();
        return send(res, 200, JSON.stringify(token), 'application/json; charset=utf-8');
      } catch (error) {
        console.error(error);
        return send(res, 500, error.message || 'Failed to create Gemini ephemeral token.');
      }
    }

    if (req.method === 'POST' && url.pathname === '/finalize') {
      try {
        const payload = await readJsonBody(req);
        const result = await finalizeAudio({
          payload,
          apiKey,
          model: process.env.FINAL_TRANSCRIPT_MODEL || 'gemini-3.1-flash-lite',
        });
        return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
      } catch (error) {
        const clientError = error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError;
        if (!clientError) console.error(error);
        return send(
          res,
          clientError ? 400 : 502,
          JSON.stringify({ error: clientError ? error.message : 'Final transcription failed' }),
          'application/json; charset=utf-8',
        );
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed');
    }

    let requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    requestPath = decodeURIComponent(requestPath);
    const resolved = path.resolve(publicDir, `.${requestPath}`);
    if (!resolved.startsWith(publicDir + path.sep)) return send(res, 403, 'Forbidden');

    try {
      const data = await fs.readFile(resolved);
      const type = mimeTypes[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return res.end(data);
    } catch {
      return send(res, 404, 'Not Found');
    }
  } catch (error) {
    console.error(error);
    return send(res, 500, 'Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`Mobile Meeting Live (Gemini) running on http://${host}:${port}`);
});
