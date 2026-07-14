// S2.3 — session layer (vision §4.4). Composes the pure token layer with the DB:
// login authenticates credentials and mints a Device (the fleet unit) + tokens;
// authenticate/rotate enforce token-versioning (global revocation) and
// per-device revocation, and refresh presence (lastSeenAt). Tested against a
// temp SQLite DB.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { hashPassword } from '../src/password-hash.js';
import { ACCESS_TTL_MS } from '../src/tokens.js';
import {
  login,
  authenticate,
  rotateSession,
  revokeDevice,
  type SessionDeps,
} from '../src/session.js';

const SECRET = new TextEncoder().encode('session-secret-at-least-32-bytes-longgg');
const NOW = 1_700_000_000_000;

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(async () => {
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
});

function deps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return { prisma: db.prisma, secret: SECRET, now: NOW, ...overrides };
}

async function makeUser(email: string, password: string, verified = true) {
  return db.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      emailVerifiedAt: verified ? new Date(1) : null,
    },
  });
}

describe('login', () => {
  test('mints a device + tokens that authenticate, and records presence', async () => {
    await makeUser('l@example.com', 'a-good-passphrase');
    const res = await login(deps(), {
      email: 'L@Example.com',
      password: 'a-good-passphrase',
      deviceName: "Harry's laptop",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const device = await db.prisma.device.findUnique({ where: { id: res.deviceId } });
    expect(device).not.toBeNull();
    expect(device!.name).toBe("Harry's laptop");
    expect(device!.lastSeenAt?.getTime()).toBe(NOW);

    const auth = await authenticate(deps(), res.accessToken);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.deviceId).toBe(res.deviceId);
  });

  test('rejects a wrong password without creating a device', async () => {
    await makeUser('w@example.com', 'a-good-passphrase');
    const res = await login(deps(), { email: 'w@example.com', password: 'nope', deviceName: 'x' });
    expect(res).toEqual({ ok: false, reason: 'bad_credentials' });
    expect(await db.prisma.device.count()).toBe(0);
  });

  test('reports bad_credentials (not existence) for an unknown email', async () => {
    const res = await login(deps(), { email: 'ghost@example.com', password: 'whatever12ab', deviceName: 'x' });
    expect(res).toEqual({ ok: false, reason: 'bad_credentials' });
  });

  test('refuses login until the email is verified', async () => {
    await makeUser('unv@example.com', 'a-good-passphrase', false);
    const res = await login(deps(), {
      email: 'unv@example.com',
      password: 'a-good-passphrase',
      deviceName: 'x',
    });
    expect(res).toEqual({ ok: false, reason: 'email_unverified' });
    expect(await db.prisma.device.count()).toBe(0);
  });
});

describe('authenticate', () => {
  test('rejects an expired access token', async () => {
    await makeUser('e@example.com', 'a-good-passphrase');
    const res = await login(deps(), { email: 'e@example.com', password: 'a-good-passphrase', deviceName: 'x' });
    if (!res.ok) throw new Error('login failed');

    const auth = await authenticate(deps({ now: NOW + ACCESS_TTL_MS + 1000 }), res.accessToken);
    expect(auth).toEqual({ ok: false, reason: 'expired' });
  });

  test('is revoked after a tokenVersion bump (sign-out-everywhere)', async () => {
    const user = await makeUser('tv@example.com', 'a-good-passphrase');
    const res = await login(deps(), { email: 'tv@example.com', password: 'a-good-passphrase', deviceName: 'x' });
    if (!res.ok) throw new Error('login failed');

    await db.prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });

    expect(await authenticate(deps(), res.accessToken)).toEqual({ ok: false, reason: 'revoked' });
  });

  test('updates device presence (lastSeenAt) on each use', async () => {
    await makeUser('p@example.com', 'a-good-passphrase');
    const res = await login(deps(), { email: 'p@example.com', password: 'a-good-passphrase', deviceName: 'x' });
    if (!res.ok) throw new Error('login failed');

    const later = NOW + 60_000;
    await authenticate(deps({ now: later }), res.accessToken);
    const device = await db.prisma.device.findUnique({ where: { id: res.deviceId } });
    expect(device!.lastSeenAt?.getTime()).toBe(later);
  });
});

describe('revokeDevice', () => {
  test('kills both the access and refresh tokens of that device', async () => {
    await makeUser('r@example.com', 'a-good-passphrase');
    const res = await login(deps(), { email: 'r@example.com', password: 'a-good-passphrase', deviceName: 'x' });
    if (!res.ok) throw new Error('login failed');

    await revokeDevice(deps(), { deviceId: res.deviceId });

    expect(await authenticate(deps(), res.accessToken)).toEqual({ ok: false, reason: 'revoked' });
    expect(await rotateSession(deps(), res.refreshToken)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('rotateSession', () => {
  test('mints a fresh working access token from a valid refresh token', async () => {
    await makeUser('rot@example.com', 'a-good-passphrase');
    const res = await login(deps(), { email: 'rot@example.com', password: 'a-good-passphrase', deviceName: 'x' });
    if (!res.ok) throw new Error('login failed');

    // After the access token has expired, the refresh token still rotates.
    const later = NOW + ACCESS_TTL_MS + 1000;
    const rotated = await rotateSession(deps({ now: later }), res.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const auth = await authenticate(deps({ now: later }), rotated.accessToken);
    expect(auth.ok).toBe(true);
  });
});
