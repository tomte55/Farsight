// node:http adapter for the account API (vision §4.4). Integration-tested
// against a real ephemeral-port server: body parsing with a size cap, JSON
// handling, routing, per-IP rate limiting, and error mapping. Reuses the
// signaling server's token-bucket DoS pattern (ported to TS).

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
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
    ctx: { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW },
    maxBodyBytes: 1024,
    rateLimit: { capacity: 5, refillPerSec: 0 }, // tiny bucket to exercise 429
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
