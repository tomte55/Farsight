// packages/account-server/src/one-time-token.ts
// Storage-agnostic one-time tokens for email verification & password reset
// (vision §4.4). The RAW token is emailed to the user; only its SHA-256 hash is
// stored, so a DB leak cannot forge valid links. Single-use + resend-invalidation
// are enforced by the caller/storage (delete-or-replace the row on consume); this
// module owns generation, hashing, and the TTL + constant-time match decision.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type TokenCheck = 'ok' | 'expired' | 'mismatch';

export interface CreatedToken {
  token: string; // raw value to email (never stored)
  tokenHash: string; // SHA-256 hex to persist
  expiresAt: number; // epoch ms
}

// URL-safe, high-entropy (32 bytes → 43 base64url chars).
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createToken({ now, ttlMs = DEFAULT_TTL_MS }: { now: number; ttlMs?: number }): CreatedToken {
  const token = randomToken();
  return { token, tokenHash: hashToken(token), expiresAt: now + ttlMs };
}

// Compare the presented token (hashed) against the stored hash in constant time,
// then apply the (inclusive) expiry. Never throws on empty/garbage input.
export function checkToken(
  { token, storedHash, expiresAt }: { token: string; storedHash: string; expiresAt: number },
  now: number,
): TokenCheck {
  const presented = token ? hashToken(token) : '';
  if (!presented || !storedHash || presented.length !== storedHash.length) return 'mismatch';
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(storedHash))) return 'mismatch';
  if (now > expiresAt) return 'expired';
  return 'ok';
}
