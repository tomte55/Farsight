// S2.4 — TOTP (RFC 6238), pure layer (vision §4.4). 2FA is optional per account
// and never required for management. SHA-1 / 6-digit / 30s step to match
// standard authenticator apps (Google Authenticator, etc.). Implemented against
// the RFC directly (proven by the Appendix B test vectors) — no dependency, in
// keeping with a minimal internet-facing surface. Codes are compared in
// constant time across a small skew window.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STEP_MS = 30_000;
export const DIGITS = 6;

// RFC 4648 base32 (no padding) — the encoding authenticator apps expect for the
// shared secret.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

// 20 random bytes (160 bits) → 32 base32 chars, the RFC-recommended SHA-1 size.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// HOTP/TOTP core: HMAC-SHA1 over the counter, dynamic-truncate, mod 10^digits.
export function totpCode(
  secret: Uint8Array,
  timeMs: number,
  opts: { digits?: number; stepMs?: number; t0Ms?: number } = {},
): string {
  const digits = opts.digits ?? DIGITS;
  const stepMs = opts.stepMs ?? STEP_MS;
  const counter = Math.floor((timeMs - (opts.t0Ms ?? 0)) / stepMs);

  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (JS bitwise is 32-bit, so split hi/lo).
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', Buffer.from(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

// Verify a presented code against the expected codes in [t-window, t+window]
// steps (default ±1, ~±30s of clock skew). Constant-time compare; never throws.
export function verifyTotp(
  secretBase32: string,
  code: string,
  timeMs: number,
  opts: { window?: number; digits?: number; stepMs?: number } = {},
): boolean {
  const digits = opts.digits ?? DIGITS;
  if (!/^\d+$/.test(code) || code.length !== digits) return false;

  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }

  const stepMs = opts.stepMs ?? STEP_MS;
  const window = opts.window ?? 1;
  const presented = Buffer.from(code);
  let match = false;
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(totpCode(secret, timeMs + i * stepMs, { digits, stepMs }));
    // Compare every candidate (no early exit) to avoid leaking which step hit.
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      match = true;
    }
  }
  return match;
}
