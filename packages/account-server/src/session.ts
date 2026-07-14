// S2.3 — session layer (vision §4.4). Composes the pure token layer with the DB:
// login authenticates credentials and mints a Device (the fleet unit) + an
// access/refresh token pair; authenticate/rotate enforce token-versioning
// (global revocation) and per-device revocation, and refresh presence
// (Device.lastSeenAt — feeds S2.5). The refresh-token-in-safeStorage binding is
// a separate main-process adapter; this layer is server-side and DB-backed.

import type { PrismaClient } from '@prisma/client';
import { verifyPassword } from './password-hash.js';
import { normalizeEmail } from './email.js';
import { verifyTwoFactor } from './two-factor.js';
import {
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
  type TokenClaims,
  type TokenType,
} from './tokens.js';

export interface SessionDeps {
  prisma: PrismaClient;
  secret: Uint8Array;
  now: number; // epoch ms
}

export type LoginResult =
  | { ok: true; accessToken: string; refreshToken: string; deviceId: string }
  | { ok: false; reason: 'bad_credentials' | 'email_unverified' | 'totp_required' | 'totp_invalid' };

export type AuthResult =
  | { ok: true; userId: string; deviceId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' };

export type RotateResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' };

export async function login(
  deps: SessionDeps,
  input: { email: string; password: string; deviceName: string; code?: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const user = await deps.prisma.user.findUnique({ where: { email } });
  // Same response for unknown email and wrong password — no enumeration.
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
    return { ok: false, reason: 'bad_credentials' };
  }
  if (!user.emailVerifiedAt) return { ok: false, reason: 'email_unverified' };

  // Second factor, only when the account has opted in (§4.4: optional 2FA).
  if (user.totpEnabledAt) {
    if (!input.code) return { ok: false, reason: 'totp_required' };
    const tf = await verifyTwoFactor({ prisma: deps.prisma, now: deps.now }, user.id, input.code);
    if (tf !== 'ok') return { ok: false, reason: 'totp_invalid' };
  }

  const device = await deps.prisma.device.create({
    data: { userId: user.id, name: input.deviceName, lastSeenAt: new Date(deps.now) },
  });

  const subject = { sub: user.id, deviceId: device.id, tv: user.tokenVersion };
  const config = { secret: deps.secret, now: deps.now };
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(config, subject),
    issueRefreshToken(config, subject),
  ]);
  return { ok: true, accessToken, refreshToken, deviceId: device.id };
}

// Verify a token's signature/expiry (pure), then enforce the DB-backed checks:
// the user still exists, its tokenVersion matches (not globally revoked), and
// the device is still linked (not revoked). Touches presence on success.
async function resolveClaims(
  deps: SessionDeps,
  token: string,
  expectedType: TokenType,
): Promise<{ ok: true; claims: TokenClaims } | { ok: false; reason: 'invalid' | 'expired' | 'revoked' }> {
  const verified = await verifyToken(token, {
    secret: deps.secret,
    now: deps.now,
    expectedType,
  });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason === 'expired' ? 'expired' : 'invalid' };
  }
  const { claims } = verified;

  const user = await deps.prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user || user.tokenVersion !== claims.tv) return { ok: false, reason: 'revoked' };

  const device = await deps.prisma.device.findUnique({ where: { id: claims.deviceId } });
  if (!device || device.userId !== user.id || device.revokedAt) {
    return { ok: false, reason: 'revoked' };
  }

  await deps.prisma.device.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(deps.now) },
  });
  return { ok: true, claims };
}

export async function authenticate(deps: SessionDeps, accessToken: string): Promise<AuthResult> {
  const resolved = await resolveClaims(deps, accessToken, 'access');
  if (!resolved.ok) return resolved;
  return { ok: true, userId: resolved.claims.sub, deviceId: resolved.claims.deviceId };
}

export async function rotateSession(deps: SessionDeps, refreshToken: string): Promise<RotateResult> {
  const resolved = await resolveClaims(deps, refreshToken, 'refresh');
  if (!resolved.ok) return resolved;
  const { sub, deviceId, tv } = resolved.claims;
  const accessToken = await issueAccessToken(
    { secret: deps.secret, now: deps.now },
    { sub, deviceId, tv },
  );
  return { ok: true, accessToken };
}

// Unlink a host / kill a lost device — invalidates all its tokens immediately.
export async function revokeDevice(deps: SessionDeps, input: { deviceId: string }): Promise<void> {
  await deps.prisma.device.update({
    where: { id: input.deviceId },
    data: { revokedAt: new Date(deps.now) },
  });
}
