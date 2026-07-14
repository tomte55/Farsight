// S2.3 — desktop token model, pure layer (vision §4.4). No cookie sessions:
// login yields a short-lived access JWT + a long-lived refresh JWT (the refresh
// token is later stored in Electron safeStorage/DPAPI — a main-process adapter,
// not here). Both are HS256, signed with a server secret, and carry the account
// (sub), the device, and the tokenVersion at issue (tv). Bumping a user's
// tokenVersion (password change / sign-out-everywhere) invalidates every
// outstanding token — the DB-backed tv + device-revocation checks live in the
// session layer; this module owns signing, expiry, and claim shape only.

import { SignJWT, jwtVerify, errors } from 'jose';

const ALG = 'HS256';

export const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type TokenType = 'access' | 'refresh';

export interface TokenSubject {
  sub: string; // userId
  deviceId: string;
  tv: number; // user's tokenVersion at issue time
}

export interface TokenClaims extends TokenSubject {
  type: TokenType;
}

export interface TokenConfig {
  secret: Uint8Array; // HMAC key (≥32 bytes)
  now: number; // epoch ms — injected for deterministic expiry
  accessTtlMs?: number;
  refreshTtlMs?: number;
}

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: 'invalid' | 'expired' | 'wrong_type' };

async function sign(
  config: TokenConfig,
  subject: TokenSubject,
  type: TokenType,
  ttlMs: number,
): Promise<string> {
  const iat = Math.floor(config.now / 1000);
  const exp = Math.floor((config.now + ttlMs) / 1000);
  return new SignJWT({ deviceId: subject.deviceId, tv: subject.tv, type })
    .setProtectedHeader({ alg: ALG })
    .setSubject(subject.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(config.secret);
}

export function issueAccessToken(config: TokenConfig, subject: TokenSubject): Promise<string> {
  return sign(config, subject, 'access', config.accessTtlMs ?? ACCESS_TTL_MS);
}

export function issueRefreshToken(config: TokenConfig, subject: TokenSubject): Promise<string> {
  return sign(config, subject, 'refresh', config.refreshTtlMs ?? REFRESH_TTL_MS);
}

export async function verifyToken(
  token: string,
  opts: { secret: Uint8Array; now: number; expectedType: TokenType },
): Promise<VerifyResult> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, opts.secret, {
      algorithms: [ALG],
      currentDate: new Date(opts.now),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }

  const { sub, deviceId, tv, type } = payload as Record<string, unknown>;
  if (
    typeof sub !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof tv !== 'number' ||
    (type !== 'access' && type !== 'refresh')
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (type !== opts.expectedType) return { ok: false, reason: 'wrong_type' };

  return { ok: true, claims: { sub, deviceId, tv, type } };
}
