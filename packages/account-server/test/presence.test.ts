// S2.5 — presence (vision §4.2), Option D: heartbeat-based, account-server-only.
// A device refreshes its own lastSeenAt + appVersion; the owner lists the fleet
// with a computed online flag. Scoped to the owner (never leaks other accounts /
// the signaling registry). Tested against a temp SQLite DB.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { heartbeat, listFleet, DEFAULT_ONLINE_WINDOW_MS, type PresenceDeps } from '../src/presence.js';

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

function deps(overrides: Partial<PresenceDeps> = {}): PresenceDeps {
  return { prisma: db.prisma, now: NOW, ...overrides };
}
const mkUser = (email: string) =>
  db.prisma.user.create({ data: { email, passwordHash: 'x', emailVerifiedAt: new Date(1) } });
const mkDevice = (userId: string, data: Record<string, unknown>) =>
  db.prisma.device.create({ data: { userId, name: 'd', ...data } });

describe('heartbeat', () => {
  test('refreshes lastSeenAt and updates the reported version', async () => {
    const u = await mkUser('h@example.com');
    const d = await mkDevice(u.id, { lastSeenAt: new Date(NOW - 999_999), appVersion: '1.5.0' });

    await heartbeat(deps(), { deviceId: d.id, version: '1.6.0' });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.lastSeenAt?.getTime()).toBe(NOW);
    expect(row!.appVersion).toBe('1.6.0');
  });

  test('without a version, leaves appVersion unchanged', async () => {
    const u = await mkUser('h2@example.com');
    const d = await mkDevice(u.id, { appVersion: '1.5.0' });

    await heartbeat(deps(), { deviceId: d.id });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.lastSeenAt?.getTime()).toBe(NOW);
    expect(row!.appVersion).toBe('1.5.0');
  });

  test('persists the signalingId (connect-from-console rendezvous)', async () => {
    const u = await mkUser('h3@example.com');
    const d = await mkDevice(u.id, {});

    await heartbeat(deps(), { deviceId: d.id, signalingId: '123456789' });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.signalingId).toBe('123456789');
  });
});

describe('listFleet', () => {
  test("returns the owner's non-revoked devices with a computed online flag", async () => {
    const owner = await mkUser('owner@example.com');
    await mkDevice(owner.id, { name: 'fresh', appVersion: '1.6.0', lastSeenAt: new Date(NOW - 10_000) });
    await mkDevice(owner.id, { name: 'stale', appVersion: '1.4.0', lastSeenAt: new Date(NOW - 300_000) });
    await mkDevice(owner.id, { name: 'never', lastSeenAt: null });
    await mkDevice(owner.id, { name: 'revoked', lastSeenAt: new Date(NOW), revokedAt: new Date(NOW) });

    const other = await mkUser('other@example.com');
    await mkDevice(other.id, { name: 'theirs', lastSeenAt: new Date(NOW) });

    const fleet = await listFleet(deps(), { userId: owner.id });

    expect(fleet.map((d) => [d.name, d.online])).toEqual([
      ['fresh', true],
      ['stale', false],
      ['never', false],
    ]); // revoked excluded, other owner's device excluded
    const fresh = fleet.find((d) => d.name === 'fresh')!;
    expect(fresh.appVersion).toBe('1.6.0');
    expect(fresh.lastSeenAt).toBeInstanceOf(Date);
  });

  test('exposes signalingId + publicKey for connect-from-console', async () => {
    const owner = await mkUser('rz@example.com');
    await mkDevice(owner.id, { name: 'host', lastSeenAt: new Date(NOW), publicKey: 'PUBKEY', signalingId: '234567891' });

    const fleet = await listFleet(deps(), { userId: owner.id });
    expect(fleet[0]!.signalingId).toBe('234567891');
    expect(fleet[0]!.publicKey).toBe('PUBKEY');
  });

  test('respects a custom online window', async () => {
    const owner = await mkUser('win@example.com');
    await mkDevice(owner.id, { name: 'a', lastSeenAt: new Date(NOW - 45_000) });

    expect((await listFleet(deps(), { userId: owner.id }))[0]!.online).toBe(true); // within default 90s
    expect((await listFleet(deps(), { userId: owner.id, onlineWindowMs: 30_000 }))[0]!.online).toBe(false);
  });

  test('the default online window is 90s', () => {
    expect(DEFAULT_ONLINE_WINDOW_MS).toBe(90_000);
  });
});
