// Authenticated self-management endpoints (vision §4.4): 2FA enroll/disable and
// device revoke, gated by a Bearer access token. Handler-level tests against a
// temp SQLite DB.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { base32Decode, totpCode } from '../src/totp.js';
import { handleRequest, type ApiContext, type ApiRequest } from '../src/http/api.js';

const SECRET = new TextEncoder().encode('authed-secret-at-least-32-bytes-longggg');
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
  await db.prisma.recoveryCode.deleteMany();
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
  await db.prisma.emailVerification.deleteMany();
});

function ctx(): ApiContext {
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  return { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW, diagnostics: { save: () => ({ id: 'stub' }) } };
}
const post = (path: string, body: unknown, token?: string): ApiRequest => ({
  method: 'POST',
  path,
  body,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

// Register + verify + login → a usable access token (+ its deviceId).
async function loginToken(c: ApiContext, email: string): Promise<{ accessToken: string; deviceId: string }> {
  const before = sent.length;
  await handleRequest(c, post('/register', { email, password: 'a-good-passphrase' }));
  const token = sent[before]!.text.match(/token=([^\s&]+)/)![1]!; // this registration's own email
  await handleRequest(c, post('/verify-email', { token }));
  const res = await handleRequest(c, post('/login', { email, password: 'a-good-passphrase', deviceName: 'pc' }));
  return res.body as { accessToken: string; deviceId: string };
}

describe('auth gate', () => {
  test('401 without a Bearer token and with a bogus one', async () => {
    const c = ctx();
    expect((await handleRequest(c, post('/2fa/begin', {}))).status).toBe(401);
    expect((await handleRequest(c, post('/2fa/begin', {}, 'not-a-real-token'))).status).toBe(401);
  });
});

describe('2FA endpoints', () => {
  test('begin → confirm returns recovery codes and activates 2FA', async () => {
    const c = ctx();
    const { accessToken } = await loginToken(c, 'tfa@example.com');

    const begin = await handleRequest(c, post('/2fa/begin', {}, accessToken));
    expect(begin.status).toBe(200);
    const { secret } = begin.body as { secret: string; otpauthUri: string };
    expect((begin.body as { otpauthUri: string }).otpauthUri).toContain('otpauth://totp/');

    const confirm = await handleRequest(c, post('/2fa/confirm', { code: totpCode(base32Decode(secret), NOW) }, accessToken));
    expect(confirm.status).toBe(200);
    expect((confirm.body as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);

    // Login now demands the second factor.
    const bare = await handleRequest(c, post('/login', { email: 'tfa@example.com', password: 'a-good-passphrase', deviceName: 'pc' }));
    expect(bare.status).toBe(401);
    expect(bare.body).toEqual({ error: 'totp_required' });
  });

  test('confirm with a wrong code → 400', async () => {
    const c = ctx();
    const { accessToken } = await loginToken(c, 'tfa2@example.com');
    await handleRequest(c, post('/2fa/begin', {}, accessToken));
    expect((await handleRequest(c, post('/2fa/confirm', { code: '000000' }, accessToken))).status).toBe(400);
  });

  test('disable turns 2FA back off', async () => {
    const c = ctx();
    const { accessToken } = await loginToken(c, 'tfa3@example.com');
    const begin = await handleRequest(c, post('/2fa/begin', {}, accessToken));
    const { secret } = begin.body as { secret: string };
    await handleRequest(c, post('/2fa/confirm', { code: totpCode(base32Decode(secret), NOW) }, accessToken));

    expect((await handleRequest(c, post('/2fa/disable', {}, accessToken))).status).toBe(200);
    const user = await db.prisma.user.findUnique({ where: { email: 'tfa3@example.com' } });
    expect(user!.totpEnabledAt).toBeNull();
  });
});

describe('POST /devices/revoke', () => {
  test('revokes your own device (its token stops working); 404 for a device you do not own', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'owner@example.com');
    const theirs = await loginToken(c, 'other@example.com');

    // Cannot revoke someone else's device.
    expect((await handleRequest(c, post('/devices/revoke', { deviceId: theirs.deviceId }, mine.accessToken))).status).toBe(404);

    // Revoke my own → my access token is now rejected everywhere.
    expect((await handleRequest(c, post('/devices/revoke', { deviceId: mine.deviceId }, mine.accessToken))).status).toBe(200);
    expect((await handleRequest(c, post('/2fa/begin', {}, mine.accessToken))).status).toBe(401);
  });
});
