// POST /diagnostics (vision §4.4 verbose diagnostic logging): authenticated
// upload of a diagnostics bundle. The route itself only validates shape and
// delegates persistence to the injected diagnostics store (Task 8); this test
// covers the handler's auth gate + validation + wiring, not the store's disk
// behaviour (see diagnostics-store.test.ts for that).

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { handleRequest, type ApiContext, type ApiRequest } from '../src/http/api.js';

const SECRET = new TextEncoder().encode('diagnostics-secret-at-least-32-bytes-long');
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
  await db.prisma.user.deleteMany();
  await db.prisma.emailVerification.deleteMany();
});

function ctx(save = vi.fn(() => ({ id: 'DIAG1' }))): ApiContext {
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  return {
    prisma: db.prisma,
    email,
    secret: SECRET,
    baseUrl: 'https://auth.example',
    now: () => NOW,
    diagnostics: { save },
  };
}
const post = (path: string, body: unknown, token?: string): ApiRequest => ({
  method: 'POST',
  path,
  body,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

// Register + verify + login → a usable access token (copied from http-authed.test.ts).
async function loginToken(c: ApiContext, email: string): Promise<{ accessToken: string; deviceId: string }> {
  const before = sent.length;
  await handleRequest(c, post('/register', { email, password: 'a-good-passphrase' }));
  const token = sent[before]!.text.match(/token=([^\s&]+)/)![1]!;
  await handleRequest(c, post('/verify-email', { token }));
  const res = await handleRequest(c, post('/login', { email, password: 'a-good-passphrase', deviceName: 'pc' }));
  return res.body as { accessToken: string; deviceId: string };
}

describe('POST /diagnostics', () => {
  test('rejects unauthenticated upload', async () => {
    const res = await handleRequest(ctx(), post('/diagnostics', { meta: {}, files: {} }));
    expect(res.status).toBe(401);
  });

  test('rejects a bogus bearer token', async () => {
    const res = await handleRequest(ctx(), post('/diagnostics', { meta: {}, files: {} }, 'not-a-real-token'));
    expect(res.status).toBe(401);
  });

  test('authenticated upload saves the bundle and returns 201 + id', async () => {
    const save = vi.fn(() => ({ id: 'DIAG1' }));
    const c = ctx(save);
    const { accessToken, deviceId: _deviceId } = await loginToken(c, 'diag@example.com');
    const user = await db.prisma.user.findUnique({ where: { email: 'diag@example.com' } });

    const files = { 'main.log': 'hello world' };
    const meta = { app: 'host', version: '1.9.7' };
    const res = await handleRequest(c, post('/diagnostics', { meta, files }, accessToken));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'DIAG1' });
    expect(save).toHaveBeenCalledWith({ userId: user!.id, meta, files });
  });

  test('authenticated upload with missing files → 400', async () => {
    const save = vi.fn(() => ({ id: 'DIAG1' }));
    const c = ctx(save);
    const { accessToken } = await loginToken(c, 'diag2@example.com');

    const res = await handleRequest(c, post('/diagnostics', { meta: {} }, accessToken));

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  test('rejects files with a non-string value → 400', async () => {
    const save = vi.fn(() => ({ id: 'DIAG1' }));
    const c = ctx(save);
    const { accessToken } = await loginToken(c, 'diag4@example.com');

    const res = await handleRequest(c, post('/diagnostics', { meta: {}, files: { a: 123 } }, accessToken));

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  test('defaults meta to {} when omitted', async () => {
    const save = vi.fn(() => ({ id: 'DIAG1' }));
    const c = ctx(save);
    const { accessToken } = await loginToken(c, 'diag3@example.com');
    const user = await db.prisma.user.findUnique({ where: { email: 'diag3@example.com' } });

    const res = await handleRequest(c, post('/diagnostics', { files: { 'a.log': 'x' } }, accessToken));

    expect(res.status).toBe(201);
    expect(save).toHaveBeenCalledWith({ userId: user!.id, meta: {}, files: { 'a.log': 'x' } });
  });
});
