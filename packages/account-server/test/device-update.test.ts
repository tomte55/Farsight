// Remote update directive (SP2 S2.7): set/clear a device's target version.
import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { setTargetVersion } from '../src/device-update.js';

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.cleanup(); });
afterEach(async () => {
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
});

const mkUser = (email: string) =>
  db.prisma.user.create({ data: { email, passwordHash: 'x', emailVerifiedAt: new Date(1) } });

describe('setTargetVersion', () => {
  test('sets a pending target version', async () => {
    const u = await mkUser('u@example.com');
    const d = await db.prisma.device.create({ data: { userId: u.id, name: 'host' } });

    await setTargetVersion({ prisma: db.prisma }, { deviceId: d.id, targetVersion: '1.8.0' });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.targetVersion).toBe('1.8.0');
  });

  test('clears the target version with null', async () => {
    const u = await mkUser('u2@example.com');
    const d = await db.prisma.device.create({ data: { userId: u.id, name: 'host', targetVersion: '1.8.0' } });

    await setTargetVersion({ prisma: db.prisma }, { deviceId: d.id, targetVersion: null });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.targetVersion).toBe(null);
  });
});
