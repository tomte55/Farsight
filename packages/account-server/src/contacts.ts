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
  // direction) is idempotent and never creates a second edge.
  const existing = await deps.prisma.contact.findFirst({
    where: {
      OR: [
        { requesterId: input.requesterId, addresseeId: addressee.id },
        { requesterId: addressee.id, addresseeId: input.requesterId },
      ],
    },
  });
  if (existing) return { ok: true, contactId: existing.id };

  const contact = await deps.prisma.contact.create({
    data: {
      requesterId: input.requesterId,
      addresseeId: addressee.id,
      inviteCode: randomBytes(16).toString('hex'),
      status: 'pending',
    },
  });
  return { ok: true, contactId: contact.id };
}
