// node:http adapter for the account API (vision §4.4). Integration-tested
// against a real ephemeral-port server: body parsing with a size cap, JSON
// handling, routing, per-IP rate limiting, and error mapping. Reuses the
// signaling server's token-bucket DoS pattern (ported to TS).

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { createAccountServer } from '../src/http/server.js';

const SECRET = new TextEncoder().encode('server-secret-at-least-32-bytes-longggg');
const NOW = 1_700_000_000_000;

let db: TestDb;
let server: Server;
let base: string;
let sent: AccountEmail[];

beforeAll(async () => {
  db = createTestDb();
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  server = createAccountServer({
    ctx: { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW, diagnostics: { save: () => ({ id: 'stub' }) } },
    maxBodyBytes: 1024,
    rateLimit: { capacity: 10, refillPerSec: 0 }, // small bucket to exercise 429
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.cleanup();
});

afterEach(async () => {
  await db.prisma.user.deleteMany();
  sent.length = 0;
});

// Raw POST so we can also send non-JSON / oversized bodies.
function raw(path: string, bodyText: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
}
const postJson = (path: string, body: unknown) => raw(path, JSON.stringify(body));

// A hand-rolled HTTP/1.1 request so we can declare a Content-Length WITHOUT
// transmitting that many bytes — readBody rejects on the declared length alone
// (before reading any chunk), so this cheaply exercises the size caps. Resolves
// with the numeric status from the response line. Because a too-large length is
// rejected up front, the server never blocks waiting for the (unsent) body.
function rawContentLength(extraHeaders: string[], contentLength: number): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const lines = [
        'POST /diagnostics HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        ...extraHeaders,
        `Content-Length: ${contentLength}`,
      ];
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { resolve(Number(m[1])); sock.destroy(); }
    });
    sock.on('error', reject);
    sock.on('close', () => { if (!/^HTTP\/1\.1 \d/.test(buf)) reject(new Error('no response')); });
  });
}

describe('createAccountServer', () => {
  test('routes a valid request to the handler and returns its JSON', async () => {
    const res = await postJson('/register', { email: 'a@example.com', password: 'a-good-passphrase' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ userId: expect.any(String) });
    expect(sent).toHaveLength(1);
  });

  test('rejects a malformed JSON body with 400', async () => {
    const res = await raw('/register', 'not json at all');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  test('rejects an oversized body with 413', async () => {
    const huge = 'x'.repeat(2048);
    const res = await postJson('/register', { email: 'a@example.com', password: huge });
    expect(res.status).toBe(413);
  });

  test('anonymous /diagnostics keeps the tight default cap → 413 (no widened cap without auth)', async () => {
    // The widened 5 MiB cap must NOT be granted to an unauthenticated request,
    // or an anonymous caller could make us buffer 5 MiB before requireAuth runs.
    // With no Authorization header, a >64 KiB body (well over this server's
    // 1 KiB default) is rejected at the size cap, not read.
    const status = await rawContentLength([], 65 * 1024);
    expect(status).toBe(413);
  });

  test('authenticated /diagnostics gets the widened cap → a 100 KiB body reaches the handler (401), not 413', async () => {
    // With an Authorization header present the cap widens past the 1 KiB
    // default, so a 100 KiB body is read and reaches requireAuth (which 401s
    // the bogus token) — it is NOT rejected as oversized.
    const big = 'x'.repeat(100 * 1024);
    const res = await fetch(`${base}/diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bogus-but-present' },
      body: JSON.stringify({ meta: {}, files: { 'a.log': big } }),
    });
    expect(res.status).toBe(401);
  });

  test('authenticated /diagnostics still enforces the 5 MiB upper bound → 413 just over the cap', async () => {
    // Content-Length one byte over 5 MiB is rejected on the declared length
    // alone (no 5 MiB actually sent), proving the widened cap has a ceiling.
    const status = await rawContentLength(['Authorization: Bearer bogus-but-present'], 5 * 1024 * 1024 + 1);
    expect(status).toBe(413);
  });

  test('returns 404 for an unknown route', async () => {
    const res = await postJson('/nope', {});
    expect(res.status).toBe(404);
  });

  test('rate-limits a burst from one IP with 429', async () => {
    // capacity 5, no refill → the 6th request within the window is throttled.
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      results.push((await postJson('/nope', {})).status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
