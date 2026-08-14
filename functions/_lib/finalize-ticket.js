const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function importKey(secret) {
  if (!secret) throw new TypeError('finalize ticket secret is required');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createFinalizeTicket({ secret, origin, now = Date.now(), ttlMs = 120000, nonce } = {}) {
  if (!origin) throw new TypeError('ticket origin is required');
  const claims = {
    origin,
    iat: now,
    exp: now + ttlMs,
    nonce: nonce || crypto.randomUUID(),
  };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await importKey(secret), encoder.encode(payload)));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifyFinalizeTicket({ ticket, secret, origin, now = Date.now() } = {}) {
  if (typeof ticket !== 'string') throw new TypeError('finalize ticket is required');
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra) throw new TypeError('invalid finalize ticket');

  const valid = await crypto.subtle.verify(
    'HMAC',
    await importKey(secret),
    base64UrlToBytes(signature),
    encoder.encode(payload),
  );
  if (!valid) throw new TypeError('invalid finalize ticket signature');

  let claims;
  try {
    claims = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
  } catch {
    throw new TypeError('invalid finalize ticket payload');
  }
  if (claims.origin !== origin) throw new TypeError('finalize ticket origin mismatch');
  if (!Number.isFinite(claims.exp) || now > claims.exp) throw new TypeError('finalize ticket expired');
  return claims;
}
