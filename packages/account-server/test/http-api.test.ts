// S2.x — thin HTTP layer over the account flows (vision §4.4). Handlers are
// decoupled from node:http (ApiRequest → ApiResponse) so they're unit-tested
// without sockets, against a temp SQLite DB + a recording email transport. The
// node http adapter + rate-limiting is a separate brick.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { handleRequest, type ApiContext } from '../src/http/api.js';

const SECRET = new TextEncoder().encode('http-secret-at-least-32-bytes-longgggggg');
const NOW = 1_700_000_000_000;

let db: TestDb;
let sent: AccountEmail[];

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(async () => {
  await db.prisma.device.deleteMany();
  await db.prisma.emailVerification.deleteMany();
  await db.prisma.passwordReset.deleteMany();
  await db.prisma.user.deleteMany();
});

function ctx(): ApiContext {
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  return { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW, diagnostics: { save: () => ({ id: 'stub' }) } };
}
function tokenFrom(email: AccountEmail): string {
  return email.text.match(/token=([^\s&]+)/)![1]!;
}
const post = (path: string, body: unknown) => ({ method: 'POST', path, body });

async function registerAndVerify(c: ApiContext, email: string, password: string) {
  await handleRequest(c, post('/register', { email, password }));
  const token = tokenFrom(sent[0]!);
  await handleRequest(c, post('/verify-email', { token }));
}

describe('POST /register', () => {
  test('creates an account and emails a verification token', async () => {
    const c = ctx();
    const res = await handleRequest(c, post('/register', { email: 'a@example.com', password: 'a-good-passphrase' }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ userId: expect.any(String) });
    expect(sent).toHaveLength(1);
  });

  test('409 on a duplicate, 400 on a weak password, 400 on a malformed body', async () => {
    const c = ctx();
    await handleRequest(c, post('/register', { email: 'dup@example.com', password: 'a-good-passphrase' }));

    expect((await handleRequest(c, post('/register', { email: 'dup@example.com', password: 'another-good' }))).status).toBe(409);
    expect((await handleRequest(c, post('/register', { email: 'w@example.com', password: 'short' }))).status).toBe(400);
    expect((await handleRequest(c, post('/register', { email: 'w@example.com' }))).status).toBe(400);
  });
});

describe('POST /verify-email', () => {
  test('verifies with the emailed token, 400 on a bad token', async () => {
    const c = ctx();
    await handleRequest(c, post('/register', { email: 'v@example.com', password: 'a-good-passphrase' }));
    const ok = await handleRequest(c, post('/verify-email', { token: tokenFrom(sent[0]!) }));
    expect(ok.status).toBe(200);

    expect((await handleRequest(c, post('/verify-email', { token: 'nope' }))).status).toBe(400);
  });
});

describe('enumeration-safe endpoints always return 200', () => {
  test('resend-verification + request-password-reset never reveal existence', async () => {
    const c = ctx();
    expect((await handleRequest(c, post('/resend-verification', { email: 'ghost@example.com' }))).status).toBe(200);
    expect((await handleRequest(c, post('/request-password-reset', { email: 'ghost@example.com' }))).status).toBe(200);
    expect(sent).toHaveLength(0); // no account → no mail, but still 200
  });
});

describe('POST /confirm-password-reset', () => {
  test('resets with the emailed token, 400 on a bad token', async () => {
    const c = ctx();
    await registerAndVerify(c, 'r@example.com', 'a-good-passphrase');
    sent.length = 0;
    await handleRequest(c, post('/request-password-reset', { email: 'r@example.com' }));
    const token = tokenFrom(sent[0]!);

    expect((await handleRequest(c, post('/confirm-password-reset', { token, newPassword: 'a-fresh-passphrase' }))).status).toBe(200);
    expect((await handleRequest(c, post('/confirm-password-reset', { token: 'nope', newPassword: 'a-fresh-passphrase' }))).status).toBe(400);
  });
});

describe('POST /login', () => {
  test('200 with tokens for valid verified credentials', async () => {
    const c = ctx();
    await registerAndVerify(c, 'l@example.com', 'a-good-passphrase');
    const res = await handleRequest(c, post('/login', { email: 'l@example.com', password: 'a-good-passphrase', deviceName: 'pc' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      deviceId: expect.any(String),
    });
  });

  test('401 on wrong password, 403 on unverified email', async () => {
    const c = ctx();
    await registerAndVerify(c, 'l2@example.com', 'a-good-passphrase');
    expect((await handleRequest(c, post('/login', { email: 'l2@example.com', password: 'wrong', deviceName: 'pc' }))).status).toBe(401);

    await handleRequest(c, post('/register', { email: 'unv@example.com', password: 'a-good-passphrase' }));
    expect((await handleRequest(c, post('/login', { email: 'unv@example.com', password: 'a-good-passphrase', deviceName: 'pc' }))).status).toBe(403);
  });
});

describe('POST /token/refresh', () => {
  test('mints a new access token from a refresh token, 401 on garbage', async () => {
    const c = ctx();
    await registerAndVerify(c, 't@example.com', 'a-good-passphrase');
    const login = await handleRequest(c, post('/login', { email: 't@example.com', password: 'a-good-passphrase', deviceName: 'pc' }));
    const { refreshToken } = login.body as { refreshToken: string };

    const res = await handleRequest(c, post('/token/refresh', { refreshToken }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: expect.any(String) });

    expect((await handleRequest(c, post('/token/refresh', { refreshToken: 'garbage' }))).status).toBe(401);
  });
});

describe('routing', () => {
  test('404 for an unknown route', async () => {
    const c = ctx();
    expect((await handleRequest(c, post('/nope', {}))).status).toBe(404);
    expect((await handleRequest(c, { method: 'GET', path: '/register', body: undefined })).status).toBe(404);
  });
});
