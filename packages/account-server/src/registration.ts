// S2.2 — registration + email-verification flows (vision §4.4). Dependency-
// injected (Prisma client + email transport + a clock) so the whole flow is
// unit-testable against a temp SQLite DB. The raw one-time token leaves only by
// email; the DB stores its hash (see one-time-token.ts).

import { validatePassword } from './password-policy.js';
import { hashPassword } from './password-hash.js';
import { createToken, hashToken, checkToken } from './one-time-token.js';
import { normalizeEmail } from './email.js';
import type { FlowDeps } from './flow-context.js';

export type { FlowDeps } from './flow-context.js';

export type RegisterResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'weak_password' | 'email_taken' };

export type VerifyResult = 'ok' | 'invalid' | 'expired';

// Issue (or re-issue) an email-verification token for a user, invalidating any
// prior outstanding one (resend semantics), and email the raw token.
async function issueVerification(deps: FlowDeps, userId: string, to: string): Promise<void> {
  await deps.prisma.emailVerification.deleteMany({ where: { userId } });
  const { token, tokenHash, expiresAt } = createToken({ now: deps.now });
  await deps.prisma.emailVerification.create({
    data: { userId, tokenHash, expiresAt: new Date(expiresAt) },
  });
  await deps.email.send({
    to,
    subject: 'Verify your Farsight account',
    text: `Confirm your email:\n${deps.baseUrl}/verify?token=${token}`,
  });
}

export async function registerUser(
  deps: FlowDeps,
  input: { email: string; password: string },
): Promise<RegisterResult> {
  const policy = validatePassword(input.password);
  if (!policy.ok) return { ok: false, reason: 'weak_password' };

  const email = normalizeEmail(input.email);
  const existing = await deps.prisma.user.findUnique({ where: { email } });
  if (existing) return { ok: false, reason: 'email_taken' };

  const passwordHash = await hashPassword(input.password);
  const user = await deps.prisma.user.create({ data: { email, passwordHash } });

  await issueVerification(deps, user.id, email);
  return { ok: true, userId: user.id };
}

export async function verifyEmail(deps: FlowDeps, input: { token: string }): Promise<VerifyResult> {
  const row = await deps.prisma.emailVerification.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });
  if (!row) return 'invalid';

  const check = checkToken(
    { token: input.token, storedHash: row.tokenHash, expiresAt: row.expiresAt.getTime() },
    deps.now,
  );
  if (check === 'expired') {
    await deps.prisma.emailVerification.delete({ where: { id: row.id } });
    return 'expired';
  }
  if (check !== 'ok') return 'invalid';

  await deps.prisma.user.update({
    where: { id: row.userId },
    data: { emailVerifiedAt: new Date(deps.now) },
  });
  await deps.prisma.emailVerification.delete({ where: { id: row.id } });
  return 'ok';
}

// Resend a verification email. No-op (without leaking existence) if the email is
// unknown or already verified; the HTTP layer must return an identical response
// either way.
export async function resendVerification(
  deps: FlowDeps,
  input: { email: string },
): Promise<'sent' | 'noop'> {
  const email = normalizeEmail(input.email);
  const user = await deps.prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerifiedAt) return 'noop';

  await issueVerification(deps, user.id, email);
  return 'sent';
}
