// S2.4 — 2FA enrollment/verify flows (vision §4.4). 2FA is optional per account
// and never required for management. Enrollment is two-step: begin stages a
// secret, confirm activates it once the user proves possession with a valid
// code (and mints one-time recovery codes). verifyTwoFactor (used at login)
// accepts a current TOTP code OR a single-use recovery code.

import type { PrismaClient } from '@prisma/client';
import { generateTotpSecret, verifyTotp } from './totp.js';
import { generateRecoveryCodes, verifyRecoveryCode } from './recovery-codes.js';

export interface TwoFactorDeps {
  prisma: PrismaClient;
  now: number;
}

const ISSUER = 'Farsight';

function otpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Stage a fresh TOTP secret for a user (replacing any half-finished enrollment).
// 2FA is NOT active until confirmTotpEnrollment succeeds.
export async function beginTotpEnrollment(
  deps: TwoFactorDeps,
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateTotpSecret();
  const user = await deps.prisma.user.update({
    where: { id: userId },
    data: { totpSecret: secret, totpEnabledAt: null },
  });
  return { secret, otpauthUri: otpauthUri(user.email, secret) };
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'no_pending' | 'invalid_code' | 'already_enabled' };

// Activate 2FA once the user proves possession of the staged secret. Mints and
// returns one-time recovery codes (shown once; only their hashes are stored).
export async function confirmTotpEnrollment(
  deps: TwoFactorDeps,
  userId: string,
  code: string,
): Promise<ConfirmResult> {
  const user = await deps.prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpSecret) return { ok: false, reason: 'no_pending' };
  if (user.totpEnabledAt) return { ok: false, reason: 'already_enabled' };
  if (!verifyTotp(user.totpSecret, code, deps.now)) return { ok: false, reason: 'invalid_code' };

  const { codes, hashes } = generateRecoveryCodes(10);
  await deps.prisma.user.update({
    where: { id: userId },
    data: {
      totpEnabledAt: new Date(deps.now),
      recoveryCodes: {
        deleteMany: {}, // clear any stale codes from a prior enrollment
        create: hashes.map((codeHash) => ({ codeHash })),
      },
    },
  });
  return { ok: true, recoveryCodes: codes };
}

// Turn 2FA off entirely: clear the secret, the enabled flag, and all codes.
export async function disableTotp(deps: TwoFactorDeps, userId: string): Promise<void> {
  await deps.prisma.recoveryCode.deleteMany({ where: { userId } });
  await deps.prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null, totpEnabledAt: null },
  });
}

export type TwoFactorCheck = 'ok' | 'invalid';

// Verify a login's second factor: a current TOTP code, or a single-use recovery
// code (consumed on match). Assumes the caller already confirmed 2FA is enabled.
export async function verifyTwoFactor(
  deps: TwoFactorDeps,
  userId: string,
  code: string,
): Promise<TwoFactorCheck> {
  const user = await deps.prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpEnabledAt || !user.totpSecret) return 'invalid';

  if (verifyTotp(user.totpSecret, code, deps.now)) return 'ok';

  const unused = await deps.prisma.recoveryCode.findMany({
    where: { userId, usedAt: null },
  });
  const idx = verifyRecoveryCode(code, unused.map((r) => r.codeHash));
  if (idx === -1) return 'invalid';

  await deps.prisma.recoveryCode.update({
    where: { id: unused[idx]!.id },
    data: { usedAt: new Date(deps.now) },
  });
  return 'ok';
}
