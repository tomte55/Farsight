import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { addContact } from '../src/contacts.js';

const NOW = 1_700_000_000_000;
let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.cleanup(); });
afterEach(async () => {
  await db.prisma.contact.deleteMany();
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
});

const deps = () => ({ prisma: db.prisma, now: NOW });

async function mkUser(email: string): Promise<string> {
  const u = await db.prisma.user.create({ data: { email, passwordHash: 'x' } });
  return u.id;
}

describe('addContact', () => {
  test('creates a pending edge resolved by (normalized) email', async () => {
    const me = await mkUser('me@example.com');
    const them = await mkUser('dad@example.com');
    const res = await addContact(deps(), { requesterId: me, email: 'DAD@Example.com ' });
    expect(res).toEqual({ ok: true, contactId: expect.any(String) });
    const row = await db.prisma.contact.findUnique({ where: { id: (res as any).contactId } });
    expect(row?.requesterId).toBe(me);
    expect(row?.addresseeId).toBe(them);
    expect(row?.status).toBe('pending');
    expect(row?.inviteCode.length).toBeGreaterThan(0);
  });

  test('unknown email → no_such_user (no row created)', async () => {
    const me = await mkUser('me@example.com');
    const res = await addContact(deps(), { requesterId: me, email: 'ghost@example.com' });
    expect(res).toEqual({ ok: false, reason: 'no_such_user' });
    expect(await db.prisma.contact.count()).toBe(0);
  });

  test('adding yourself → self', async () => {
    const me = await mkUser('me@example.com');
    const res = await addContact(deps(), { requesterId: me, email: 'me@example.com' });
    expect(res).toEqual({ ok: false, reason: 'self' });
  });

  test('idempotent — re-adding returns the existing edge, in either direction', async () => {
    const me = await mkUser('me@example.com');
    const them = await mkUser('dad@example.com');
    const first = await addContact(deps(), { requesterId: me, email: 'dad@example.com' });
    const again = await addContact(deps(), { requesterId: me, email: 'dad@example.com' });
    expect((again as any).contactId).toBe((first as any).contactId);
    // reverse direction also dedups to the same edge
    const reverse = await addContact(deps(), { requesterId: them, email: 'me@example.com' });
    expect((reverse as any).contactId).toBe((first as any).contactId);
    expect(await db.prisma.contact.count()).toBe(1);
  });
});
