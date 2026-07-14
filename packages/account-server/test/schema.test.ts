// Integration tests for the account-server persistence layer (Prisma + SQLite,
// vision §4.4). Proves each model round-trips, that key constraints hold, that
// user deletion cascades to owned rows, and that the storage-agnostic
// password-hash + one-time-token logic composes with real persistence.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { hashPassword, verifyPassword } from '../src/password-hash.js';
import { createToken, checkToken } from '../src/one-time-token.js';

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.cleanup();
});

// Fresh state between tests: delete children before parents (FK order).
afterEach(async () => {
  const p = db.prisma;
  await p.contact.deleteMany();
  await p.device.deleteMany();
  await p.emailVerification.deleteMany();
  await p.passwordReset.deleteMany();
  await p.user.deleteMany();
});

describe('User', () => {
  test('persists a user with sane defaults', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'a@example.com', passwordHash: 'x' },
    });

    expect(user.id).toBeTruthy();
    expect(user.email).toBe('a@example.com');
    expect(user.emailVerifiedAt).toBeNull(); // unverified until confirmed
    expect(user.tokenVersion).toBe(0); // global-revocation counter starts at 0
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  test('email is unique', async () => {
    await db.prisma.user.create({ data: { email: 'dup@example.com', passwordHash: 'x' } });
    await expect(
      db.prisma.user.create({ data: { email: 'dup@example.com', passwordHash: 'y' } }),
    ).rejects.toThrow();
  });
});

describe('EmailVerification', () => {
  test('stores a token hash and cascades on user delete', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'verify@example.com', passwordHash: 'x' },
    });
    await db.prisma.emailVerification.create({
      data: { userId: user.id, tokenHash: 'abc123', expiresAt: new Date(Date.now() + 1000) },
    });

    await db.prisma.user.delete({ where: { id: user.id } });

    expect(await db.prisma.emailVerification.count()).toBe(0);
  });

  test('token hash is unique', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'uniq@example.com', passwordHash: 'x' },
    });
    const base = { userId: user.id, expiresAt: new Date(Date.now() + 1000) };
    await db.prisma.emailVerification.create({ data: { ...base, tokenHash: 'same' } });
    await expect(
      db.prisma.emailVerification.create({ data: { ...base, tokenHash: 'same' } }),
    ).rejects.toThrow();
  });
});

describe('PasswordReset', () => {
  test('stores a token hash for a user', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: 'x' },
    });
    const row = await db.prisma.passwordReset.create({
      data: { userId: user.id, tokenHash: 'r-hash', expiresAt: new Date(Date.now() + 1000) },
    });
    expect(row.userId).toBe(user.id);
  });
});

describe('Device', () => {
  test('persists a device with nullable fleet fields defaulting null', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'dev@example.com', passwordHash: 'x' },
    });
    const device = await db.prisma.device.create({
      data: { userId: user.id, name: "Harry's PC" },
    });

    expect(device.name).toBe("Harry's PC");
    expect(device.publicKey).toBeNull(); // set at enrollment (S2.6)
    expect(device.appVersion).toBeNull(); // last-known version (SP1 host version)
    expect(device.lastSeenAt).toBeNull(); // presence (S2.5)
    expect(device.revokedAt).toBeNull(); // revoking a device unlinks a host
  });
});

describe('Contact', () => {
  test('persists a pending invite with a unique code', async () => {
    const requester = await db.prisma.user.create({
      data: { email: 'req@example.com', passwordHash: 'x' },
    });
    const contact = await db.prisma.contact.create({
      data: { requesterId: requester.id, inviteCode: 'INVITE-1' },
    });

    expect(contact.status).toBe('pending'); // pending until accepted
    expect(contact.addresseeId).toBeNull();

    await expect(
      db.prisma.contact.create({ data: { requesterId: requester.id, inviteCode: 'INVITE-1' } }),
    ).rejects.toThrow(); // inviteCode unique
  });
});

describe('composition with pure logic', () => {
  test('a real argon2id hash stored on a user verifies', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    const user = await db.prisma.user.create({
      data: { email: 'compose@example.com', passwordHash },
    });

    expect(await verifyPassword(user.passwordHash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(user.passwordHash, 'wrong')).toBe(false);
  });

  test('a one-time token round-trips through storage and validates', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'token@example.com', passwordHash: 'x' },
    });
    const { token, tokenHash, expiresAt } = createToken({ now: Date.now() });
    await db.prisma.emailVerification.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(expiresAt) },
    });

    const stored = await db.prisma.emailVerification.findUnique({ where: { tokenHash } });
    expect(stored).not.toBeNull();
    expect(checkToken({ token, storedHash: stored!.tokenHash, expiresAt }, Date.now())).toBe('ok');
    expect(checkToken({ token: 'forged', storedHash: stored!.tokenHash, expiresAt }, Date.now())).toBe(
      'mismatch',
    );
  });
});
