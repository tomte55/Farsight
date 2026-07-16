import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { addContact, acceptContact, declineContact, listContacts } from '../src/contacts.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';

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

  test('sends a notification email to the addressee on a NEW edge only', async () => {
    const outbox: AccountEmail[] = [];
    const email: EmailTransport = { send: async (e) => void outbox.push(e) };
    const me = await mkUser('me@example.com');
    await mkUser('dad@example.com');
    const d = { prisma: db.prisma, now: NOW, email, baseUrl: 'https://auth.example', inviterEmail: 'me@example.com' };

    await addContact(d, { requesterId: me, email: 'dad@example.com' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe('dad@example.com');
    expect(outbox[0]!.text).toContain('me@example.com');

    // idempotent re-add does NOT re-send
    await addContact(d, { requesterId: me, email: 'dad@example.com' });
    expect(outbox).toHaveLength(1);
  });

  test('a failing email transport does not fail the add', async () => {
    const email: EmailTransport = { send: async () => { throw new Error('smtp down'); } };
    const me = await mkUser('me@example.com');
    await mkUser('dad@example.com');
    const res = await addContact(
      { prisma: db.prisma, now: NOW, email, baseUrl: 'https://auth.example', inviterEmail: 'me@example.com' },
      { requesterId: me, email: 'dad@example.com' },
    );
    expect(res.ok).toBe(true);
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

describe('listContacts', () => {
  test('accepted contact exposes its online devices; pending exposes no devices', async () => {
    const me = await mkUser('me@example.com');
    const dad = await mkUser('dad@example.com');
    // dad has one online device (heartbeat = now) with a signalingId + publicKey
    await db.prisma.device.create({
      data: { userId: dad, name: 'dad-pc', signalingId: 'sig-DAD', publicKey: 'PK-DAD', lastSeenAt: new Date(NOW) },
    });
    const added = await addContact(deps(), { requesterId: me, email: 'dad@example.com' });

    // While pending: dad sees an incoming request; me sees an outgoing one; no devices leak.
    const meView1 = await listContacts(deps(), { userId: me });
    const dadView1 = await listContacts(deps(), { userId: dad });
    expect(meView1.accepted).toEqual([]);
    expect(meView1.outgoing).toEqual([{ contactId: (added as any).contactId, email: 'dad@example.com' }]);
    expect(dadView1.incoming).toEqual([{ contactId: (added as any).contactId, email: 'me@example.com' }]);
    expect(dadView1.accepted).toEqual([]);

    // After dad accepts: me sees dad's device with presence.
    await acceptContact(deps(), { userId: dad, contactId: (added as any).contactId });
    const meView2 = await listContacts(deps(), { userId: me });
    expect(meView2.accepted).toEqual([{
      contactUserId: dad, email: 'dad@example.com', deviceId: expect.any(String),
      name: 'dad-pc', signalingId: 'sig-DAD', publicKey: 'PK-DAD', online: true,
    }]);
    expect(meView2.incoming).toEqual([]);
    expect(meView2.outgoing).toEqual([]);
  });

  test('a stale device (no recent heartbeat) is listed offline', async () => {
    const me = await mkUser('me@example.com');
    const dad = await mkUser('dad@example.com');
    await db.prisma.device.create({
      data: { userId: dad, name: 'dad-pc', signalingId: 'sig', lastSeenAt: new Date(NOW - 200_000) },
    });
    const added = await addContact(deps(), { requesterId: me, email: 'dad@example.com' });
    await acceptContact(deps(), { userId: dad, contactId: (added as any).contactId });
    const view = await listContacts(deps(), { userId: me });
    expect(view.accepted[0]!.online).toBe(false);
  });

  test('does not leak a third party\'s edges or devices', async () => {
    const me = await mkUser('me@example.com');
    const a = await mkUser('a@example.com');
    const b = await mkUser('b@example.com');
    await db.prisma.device.create({ data: { userId: b, name: 'b-pc', lastSeenAt: new Date(NOW) } });
    const ab = await addContact(deps(), { requesterId: a, email: 'b@example.com' });
    await acceptContact(deps(), { userId: b, contactId: (ab as any).contactId });
    const view = await listContacts(deps(), { userId: me });
    expect(view).toEqual({ accepted: [], incoming: [], outgoing: [] });
  });
});
