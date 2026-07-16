// SP3 contacts (design §5.1): the in-app "friends list". Dependency-injected
// business logic mirroring presence.ts/registration.ts — routes in http/api.ts
// build the deps bundle and translate results to HTTP. The Contact model already
// exists in schema.prisma (117-130); this is the first code to use it.
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { normalizeEmail } from './email.js';
import type { EmailTransport } from './email.js';
import { DEFAULT_ONLINE_WINDOW_MS } from './presence.js';

export interface ContactsDeps {
  prisma: PrismaClient;
  now: number; // epoch ms
  email?: EmailTransport;
  baseUrl?: string;
  inviterEmail?: string; // shown to the addressee in the nudge
}

export async function addContact(
  deps: ContactsDeps,
  input: { requesterId: string; email: string },
): Promise<{ ok: true; contactId: string } | { ok: false; reason: 'no_such_user' | 'self' }> {
  const email = normalizeEmail(input.email);
  const addressee = await deps.prisma.user.findUnique({ where: { email } });
  if (!addressee) return { ok: false, reason: 'no_such_user' };
  if (addressee.id === input.requesterId) return { ok: false, reason: 'self' };

  // Dedup on the unordered pair {requesterId, addresseeId} so re-adding (in either
  // direction) is idempotent and never creates a second edge. `pairKey` sorts the
  // two ids so both directions collide to the same canonical string, and is backed
  // by a DB-level unique constraint (schema.prisma) so a concurrent double-submit
  // can't race past this pre-check and create a duplicate row.
  const pairKey = [input.requesterId, addressee.id].sort().join(':');
  const existing = await deps.prisma.contact.findUnique({ where: { pairKey } });
  if (existing) return { ok: true, contactId: existing.id };

  try {
    const contact = await deps.prisma.contact.create({
      data: {
        requesterId: input.requesterId,
        addresseeId: addressee.id,
        inviteCode: randomBytes(16).toString('hex'),
        pairKey,
        status: 'pending',
        createdAt: new Date(deps.now),
      },
    });
    if (deps.email && deps.baseUrl) {
      try {
        await deps.email.send({
          to: addressee.email,
          subject: 'Someone added you as a Farsight contact',
          text: `${deps.inviterEmail ?? 'A Farsight user'} wants to connect with you on Farsight.\n`
            + `Open the Farsight app → Contacts to accept the request.`,
        });
      } catch { /* best-effort nudge — never fail the add on a mail error */ }
    }
    return { ok: true, contactId: contact.id };
  } catch (err: any) {
    // Race backstop: another concurrent add for the same pair won the unique
    // constraint on pairKey between our pre-check and this create. Return the
    // winner's edge instead of failing the request.
    if (err?.code === 'P2002') {
      const winner = await deps.prisma.contact.findUnique({ where: { pairKey } });
      if (winner) return { ok: true, contactId: winner.id };
    }
    throw err;
  }
}

export async function acceptContact(
  deps: ContactsDeps,
  input: { userId: string; contactId: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  // Atomic transition: only the addressee of a still-pending edge flips it to accepted.
  const res = await deps.prisma.contact.updateMany({
    where: { id: input.contactId, addresseeId: input.userId, status: 'pending' },
    data: { status: 'accepted', respondedAt: new Date(deps.now) },
  });
  if (res.count === 1) return { ok: true };
  // Idempotent: an addressee re-accepting an already-accepted edge is a no-op success.
  const row = await deps.prisma.contact.findUnique({ where: { id: input.contactId } });
  if (row && row.addresseeId === input.userId && row.status === 'accepted') return { ok: true };
  return { ok: false, reason: 'not_found' };
}

export async function declineContact(
  deps: ContactsDeps,
  input: { userId: string; contactId: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  // Atomic: only the addressee of a still-pending edge can decline; deleteMany never
  // throws on 0 matches (no P2025 on a double-submit), unlike delete().
  const res = await deps.prisma.contact.deleteMany({
    where: { id: input.contactId, addresseeId: input.userId, status: 'pending' },
  });
  return res.count === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

export interface ContactDevice {
  contactUserId: string;
  email: string;
  deviceId: string;
  name: string;
  signalingId: string | null;
  publicKey: string | null;
  online: boolean;
}

export interface PendingContact {
  contactId: string;
  email: string;
}

export interface ContactsView {
  accepted: ContactDevice[];
  incoming: PendingContact[];
  outgoing: PendingContact[];
}

export async function listContacts(
  deps: ContactsDeps,
  input: { userId: string; onlineWindowMs?: number },
): Promise<ContactsView> {
  const windowMs = input.onlineWindowMs ?? DEFAULT_ONLINE_WINDOW_MS;
  const edges = await deps.prisma.contact.findMany({
    where: { OR: [{ requesterId: input.userId }, { addresseeId: input.userId }] },
    include: { requester: true, addressee: true },
  });

  const accepted: ContactDevice[] = [];
  const incoming: PendingContact[] = [];
  const outgoing: PendingContact[] = [];

  for (const e of edges) {
    const iAmRequester = e.requesterId === input.userId;
    const other = iAmRequester ? e.addressee : e.requester;
    if (!other) continue; // addressee is non-null in this design, but guard anyway

    if (e.status === 'accepted') {
      const devices = await deps.prisma.device.findMany({
        where: { userId: other.id, revokedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      for (const d of devices) {
        accepted.push({
          contactUserId: other.id,
          email: other.email,
          deviceId: d.id,
          name: d.name,
          signalingId: d.signalingId,
          publicKey: d.publicKey,
          online: d.lastSeenAt !== null && deps.now - d.lastSeenAt.getTime() <= windowMs,
        });
      }
    } else if (e.status === 'pending') {
      // I am the addressee → it's an incoming request I can accept; else outgoing.
      if (e.addresseeId === input.userId) incoming.push({ contactId: e.id, email: other.email });
      else outgoing.push({ contactId: e.id, email: other.email });
    }
  }

  return { accepted, incoming, outgoing };
}
