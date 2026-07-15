// node:http adapter — browser-facing concerns: the URL query string must reach
// handlers (the verify/reset emails carry ?token=…), and an HTML response must be
// served as text/html with its raw body (not JSON-encoded). GET /reset only reads
// the query + renders, so this needs no DB.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { EmailTransport } from '../src/email.js';
import type { ApiContext } from '../src/http/api.js';
import { createAccountServer } from '../src/http/server.js';

const SECRET = new TextEncoder().encode('web-secret-at-least-32-bytes-longgggggggg');
let server: Server;
let base: string;

beforeAll(async () => {
  const email: EmailTransport = { send: async () => {} };
  // GET /reset never touches prisma; a stub ctx keeps this DB-free.
  const ctx = { prisma: {} as never, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => 1 } as unknown as ApiContext;
  server = createAccountServer({ ctx, rateLimit: { capacity: 100, refillPerSec: 100 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('adapter: query string + HTML responses', () => {
  test('parses the ?token= query and serves an HTML page', async () => {
    const res = await fetch(`${base}/reset?token=abc123XYZ_-`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('abc123XYZ_-');            // the query token reached the handler
    expect(body).toContain('/confirm-password-reset'); // rendered as real HTML, not JSON
    expect(body).not.toMatch(/^\s*\{/);                // not a JSON envelope
  });

  test('a JSON route still serves application/json', async () => {
    const res = await fetch(`${base}/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
