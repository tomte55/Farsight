// S2.2 — password-reset flows (vision §4.4). Same one-time-token mechanism as
// email verification. A successful reset rotates the password, bumps
// tokenVersion (global session revocation), proves email control (verifies a
// still-unverified account), and is single-use.

import { validatePassword } from './password-policy.js';
import { hashPassword } from './password-hash.js';
import { createToken, hashToken, checkToken } from './one-time-token.js';
import { normalizeEmail } from './email.js';
import type { FlowDeps } from './flow-context.js';

export type { FlowDeps } from './flow-context.js';

export type ResetConfirmResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' | 'weak_password' };

// Issue (or re-issue) a reset token, invalidating any prior outstanding one.
async function issueReset(deps: FlowDeps, userId: string, to: string): Promise<void> {
  await deps.prisma.passwordReset.deleteMany({ where: { userId } });
  const { token, tokenHash, expiresAt } = createToken({ now: deps.now });
  await deps.prisma.passwordReset.create({
    data: { userId, tokenHash, expiresAt: new Date(expiresAt) },
  });
  await deps.email.send({
    to,
    subject: 'Reset your Farsight password',
    text: `Reset your password:\n${deps.baseUrl}/reset?token=${token}`,
  });
}

// No-op (without leaking existence) for an unknown email; the HTTP layer must
// return an identical response either way.
export async function requestPasswordReset(
  deps: FlowDeps,
  input: { email: string },
): Promise<'sent' | 'noop'> {
  const email = normalizeEmail(input.email);
  const user = await deps.prisma.user.findUnique({ where: { email } });
  if (!user) return 'noop';

  await issueReset(deps, user.id, email);
  return 'sent';
}

export async function confirmPasswordReset(
  deps: FlowDeps,
  input: { token: string; newPassword: string },
): Promise<ResetConfirmResult> {
  const row = await deps.prisma.passwordReset.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });
  if (!row) return { ok: false, reason: 'invalid' };

  const check = checkToken(
    { token: input.token, storedHash: row.tokenHash, expiresAt: row.expiresAt.getTime() },
    deps.now,
  );
  if (check === 'expired') {
    await deps.prisma.passwordReset.delete({ where: { id: row.id } });
    return { ok: false, reason: 'expired' };
  }
  if (check !== 'ok') return { ok: false, reason: 'invalid' };

  // Validate the new password BEFORE consuming the token, so a weak choice
  // doesn't burn the link — the user can retry with the same email.
  const policy = validatePassword(input.newPassword);
  if (!policy.ok) return { ok: false, reason: 'weak_password' };

  const user = await deps.prisma.user.findUnique({ where: { id: row.userId } });
  if (!user) return { ok: false, reason: 'invalid' }; // orphaned token (shouldn't happen — FK cascade)

  const passwordHash = await hashPassword(input.newPassword);
  await deps.prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      tokenVersion: { increment: 1 }, // revoke every outstanding session
      // A completed reset proves control of the inbox → verify if not already.
      ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date(deps.now) }),
    },
  });
  // Single-use: drop this token and any other outstanding reset for the user.
  await deps.prisma.passwordReset.deleteMany({ where: { userId: user.id } });
  return { ok: true };
}
