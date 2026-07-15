// Connect-from-console (SP2 §4.4): storing a device's account-issued public key.
import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { setDevicePublicKey } from '../src/device-keys.js';

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.cleanup(); });
afterEach(async () => {
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
});

const mkUser = (email: string) =>
  db.prisma.user.create({ data: { email, passwordHash: 'x', emailVerifiedAt: new Date(1) } });

describe('setDevicePublicKey', () => {
  test('stores the public key on the device', async () => {
    const u = await mkUser('k@example.com');
    const d = await db.prisma.device.create({ data: { userId: u.id, name: 'host' } });

    await setDevicePublicKey({ prisma: db.prisma }, { deviceId: d.id, publicKey: 'PUB123' });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.publicKey).toBe('PUB123');
  });

  test('replaces an existing key', async () => {
    const u = await mkUser('k2@example.com');
    const d = await db.prisma.device.create({ data: { userId: u.id, name: 'host', publicKey: 'OLD' } });

    await setDevicePublicKey({ prisma: db.prisma }, { deviceId: d.id, publicKey: 'NEW' });

    const row = await db.prisma.device.findUnique({ where: { id: d.id } });
    expect(row!.publicKey).toBe('NEW');
  });
});
