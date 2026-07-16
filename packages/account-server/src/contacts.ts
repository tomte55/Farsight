// SP3 contacts (design §5.1): the in-app "friends list". Dependency-injected
// business logic mirroring presence.ts/registration.ts — routes in http/api.ts
// build the deps bundle and translate results to HTTP. The Contact model already
// exists in schema.prisma (117-130); this is the first code to use it.
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { normalizeEmail } from './email.js';

export interface ContactsDeps {
  prisma: PrismaClient;
  now: number; // epoch ms
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
