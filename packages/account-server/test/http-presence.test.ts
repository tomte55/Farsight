// S2.5 — presence endpoints over HTTP (vision §4.2): POST /devices/heartbeat
// (a device reports its own liveness/version) and GET /devices (the owner lists
// the fleet with online flags). Bearer-gated, owner-scoped. Handler-level tests.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { handleRequest, type ApiContext, type ApiRequest } from '../src/http/api.js';

const SECRET = new TextEncoder().encode('presence-secret-at-least-32-bytes-longgg');
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

function ctx(): ApiContext {
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  return { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW };
}
const req = (method: string, path: string, body: unknown, token?: string): ApiRequest => ({
  method,
  path,
  body,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

async function loginToken(c: ApiContext, email: string): Promise<{ accessToken: string; deviceId: string }> {
  const before = sent.length;
  await handleRequest(c, req('POST', '/register', { email, password: 'a-good-passphrase' }));
  const token = sent[before]!.text.match(/token=([^\s&]+)/)![1]!;
  await handleRequest(c, req('POST', '/verify-email', { token }));
  const res = await handleRequest(c, req('POST', '/login', { email, password: 'a-good-passphrase', deviceName: 'pc' }));
  return res.body as { accessToken: string; deviceId: string };
}

describe('auth gate', () => {
  test('401 without a token', async () => {
    const c = ctx();
    expect((await handleRequest(c, req('GET', '/devices', undefined))).status).toBe(401);
    expect((await handleRequest(c, req('POST', '/devices/heartbeat', {}))).status).toBe(401);
  });
});

describe('GET /devices', () => {
  test('lists the caller-owned fleet with online flags; excludes other accounts', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'me@example.com');
    await loginToken(c, 'other@example.com'); // a second account with its own device

    const res = await handleRequest(c, req('GET', '/devices', undefined, mine.accessToken));
    expect(res.status).toBe(200);
    const { devices } = res.body as { devices: Array<{ id: string; online: boolean; name: string }> };
    expect(devices).toHaveLength(1); // only my own device
    expect(devices[0]!.id).toBe(mine.deviceId);
    expect(devices[0]!.online).toBe(true); // authenticating just refreshed lastSeenAt
  });
});

describe('POST /devices/heartbeat', () => {
  test('updates the reported version, visible in the fleet listing', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'hb@example.com');

    expect((await handleRequest(c, req('POST', '/devices/heartbeat', { version: '1.6.0' }, mine.accessToken))).status).toBe(200);

    const res = await handleRequest(c, req('GET', '/devices', undefined, mine.accessToken));
    const { devices } = res.body as { devices: Array<{ appVersion: string | null }> };
    expect(devices[0]!.appVersion).toBe('1.6.0');
  });

  test('persists the signalingId, visible in the fleet listing (rendezvous)', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'hbrz@example.com');

    await handleRequest(c, req('POST', '/devices/heartbeat', { version: '1.7.0', signalingId: '345678912' }, mine.accessToken));

    const res = await handleRequest(c, req('GET', '/devices', undefined, mine.accessToken));
    const { devices } = res.body as { devices: Array<{ signalingId: string | null }> };
    expect(devices[0]!.signalingId).toBe('345678912');
  });
});

describe('POST /devices/update (remote update directive)', () => {
  test('401 without a token', async () => {
    const c = ctx();
    expect((await handleRequest(c, req('POST', '/devices/update', { deviceId: 'x', targetVersion: '1.8.0' }))).status).toBe(401);
  });

  test('owner sets a target version, visible in the fleet + the heartbeat response', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'ru@example.com');

    expect((await handleRequest(c, req('POST', '/devices/update', { deviceId: mine.deviceId, targetVersion: '1.8.0' }, mine.accessToken))).status).toBe(200);

    const list = await handleRequest(c, req('GET', '/devices', undefined, mine.accessToken));
    expect((list.body as { devices: Array<{ targetVersion: string | null }> }).devices[0]!.targetVersion).toBe('1.8.0');

    const beat = await handleRequest(c, req('POST', '/devices/heartbeat', { version: '1.7.0' }, mine.accessToken));
    expect((beat.body as { targetVersion: string | null }).targetVersion).toBe('1.8.0');
  });

  test("404 for another account's device (no cross-account writes)", async () => {
    const c = ctx();
    const mine = await loginToken(c, 'ro@example.com');
    const other = await loginToken(c, 'ro2@example.com');
    const res = await handleRequest(c, req('POST', '/devices/update', { deviceId: other.deviceId, targetVersion: '1.8.0' }, mine.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('POST /devices/key', () => {
  test('401 without a token', async () => {
    const c = ctx();
    expect((await handleRequest(c, req('POST', '/devices/key', { publicKey: 'P' }))).status).toBe(401);
  });

  test('400 without a publicKey', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'key400@example.com');
    expect((await handleRequest(c, req('POST', '/devices/key', {}, mine.accessToken))).status).toBe(400);
  });

  test('stores the caller device public key, visible in the fleet listing', async () => {
    const c = ctx();
    const mine = await loginToken(c, 'keyok@example.com');

    expect((await handleRequest(c, req('POST', '/devices/key', { publicKey: 'PUBWIRED' }, mine.accessToken))).status).toBe(200);

    const res = await handleRequest(c, req('GET', '/devices', undefined, mine.accessToken));
    const { devices } = res.body as { devices: Array<{ id: string; publicKey: string | null }> };
    expect(devices[0]!.id).toBe(mine.deviceId);
    expect(devices[0]!.publicKey).toBe('PUBWIRED');
  });
});
