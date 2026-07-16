import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { addContact, acceptContact, declineContact } from '../src/contacts.js';

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

  test('pairKey unique constraint backstops the dedup (DB rejects a duplicate pair)', async () => {
    const me = await mkUser('me@example.com');
    const them = await mkUser('dad@example.com');
    await addContact(deps(), { requesterId: me, email: 'dad@example.com' });
    const pairKey = [me, them].sort().join(':');
    await expect(
      db.prisma.contact.create({
        data: { requesterId: me, addresseeId: them, inviteCode: 'other', pairKey },
      }),
    ).rejects.toThrow();
  });
});

describe('acceptContact / declineContact', () => {
  async function pending(reqEmail: string, addrEmail: string) {
    const requesterId = await mkUser(reqEmail);
    const addresseeId = await mkUser(addrEmail);
    const res = await addContact(deps(), { requesterId, email: addrEmail });
    return { requesterId, addresseeId, contactId: (res as any).contactId };
  }

  test('the addressee accepts a pending edge', async () => {
    const { addresseeId, contactId } = await pending('me@example.com', 'dad@example.com');
    const res = await acceptContact(deps(), { userId: addresseeId, contactId });
    expect(res).toEqual({ ok: true });
    const row = await db.prisma.contact.findUnique({ where: { id: contactId } });
    expect(row?.status).toBe('accepted');
    expect(row?.respondedAt).not.toBeNull();
  });

  test('accept is idempotent for the addressee', async () => {
    const { addresseeId, contactId } = await pending('me@example.com', 'dad@example.com');
    await acceptContact(deps(), { userId: addresseeId, contactId });
    expect(await acceptContact(deps(), { userId: addresseeId, contactId })).toEqual({ ok: true });
  });

  test('the requester (not the addressee) cannot accept → not_found', async () => {
    const { requesterId, contactId } = await pending('me@example.com', 'dad@example.com');
    expect(await acceptContact(deps(), { userId: requesterId, contactId }))
      .toEqual({ ok: false, reason: 'not_found' });
    expect((await db.prisma.contact.findUnique({ where: { id: contactId } }))?.status).toBe('pending');
  });

  test('a stranger cannot accept → not_found', async () => {
    const { contactId } = await pending('me@example.com', 'dad@example.com');
    const stranger = await mkUser('evil@example.com');
    expect(await acceptContact(deps(), { userId: stranger, contactId }))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  test('the addressee declines → row removed', async () => {
    const { addresseeId, contactId } = await pending('me@example.com', 'dad@example.com');
    expect(await declineContact(deps(), { userId: addresseeId, contactId })).toEqual({ ok: true });
    expect(await db.prisma.contact.findUnique({ where: { id: contactId } })).toBeNull();
  });

  test('decline by a non-addressee → not_found, row intact', async () => {
    const { requesterId, contactId } = await pending('me@example.com', 'dad@example.com');
    expect(await declineContact(deps(), { userId: requesterId, contactId }))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(await db.prisma.contact.findUnique({ where: { id: contactId } })).not.toBeNull();
  });

  test('declining an already-accepted edge → not_found, row intact', async () => {
    const { addresseeId, contactId } = await pending('me@example.com', 'dad@example.com');
    await acceptContact(deps(), { userId: addresseeId, contactId });
    expect(await declineContact(deps(), { userId: addresseeId, contactId }))
      .toEqual({ ok: false, reason: 'not_found' });
    const row = await db.prisma.contact.findUnique({ where: { id: contactId } });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('accepted');
  });

  test('decline is safe to call twice (double-submit) — second call → not_found, no throw', async () => {
    const { addresseeId, contactId } = await pending('me@example.com', 'dad@example.com');
    expect(await declineContact(deps(), { userId: addresseeId, contactId })).toEqual({ ok: true });
    expect(await declineContact(deps(), { userId: addresseeId, contactId }))
      .toEqual({ ok: false, reason: 'not_found' });
  });
});
