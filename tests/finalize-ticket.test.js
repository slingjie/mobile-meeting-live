import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinalizeTicket, verifyFinalizeTicket } from '../functions/_lib/finalize-ticket.js';

test('creates a short-lived ticket bound to the application origin', async () => {
  const ticket = await createFinalizeTicket({
    secret: 'test-secret',
    origin: 'https://example.test',
    now: 1000,
    ttlMs: 120000,
    nonce: 'fixed-nonce',
  });

  const claims = await verifyFinalizeTicket({
    ticket,
    secret: 'test-secret',
    origin: 'https://example.test',
    now: 2000,
  });
  assert.equal(claims.origin, 'https://example.test');
  assert.equal(claims.exp, 121000);
});

test('rejects expired, wrong-origin and tampered tickets', async () => {
  const ticket = await createFinalizeTicket({
    secret: 'test-secret',
    origin: 'https://example.test',
    now: 1000,
    ttlMs: 1000,
    nonce: 'fixed-nonce',
  });

  await assert.rejects(() => verifyFinalizeTicket({ ticket, secret: 'test-secret', origin: 'https://example.test', now: 2001 }), /expired/);
  await assert.rejects(() => verifyFinalizeTicket({ ticket, secret: 'test-secret', origin: 'https://other.test', now: 1500 }), /origin/);
  await assert.rejects(() => verifyFinalizeTicket({ ticket: `${ticket}x`, secret: 'test-secret', origin: 'https://example.test', now: 1500 }), /signature|ticket/);
});
