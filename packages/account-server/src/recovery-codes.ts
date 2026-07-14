// S2.4 — recovery codes, pure layer (vision §4.4). One-time backup codes for a
// lost authenticator. Only the SHA-256 hash of each code is stored; the raw
// codes are shown to the user once at 2FA setup. Codes are matched case- and
// format-insensitively (users retype them) and in constant time. Single-use is
// enforced by the caller removing the matched hash.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32, no ambiguous 0/1/8/9
const CODE_LEN = 10; // 10 chars → 50 bits of entropy per code

// Canonical form for hashing/compare: keep only alphanumerics, uppercase. So
// "abcde-fghij", "ABCDE FGHIJ" and "ABCDEFGHIJ" all hash identically.
function canonical(code: string): string {
  return code.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(canonical(code)).digest('hex');
}

function formatCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`; // XXXXX-XXXXX, easier to read/type
}

export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const bytes = randomBytes(CODE_LEN);
    let raw = '';
    for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
    if (seen.has(raw)) continue; // vanishingly unlikely, but keep them unique
    seen.add(raw);
    codes.push(formatCode(raw));
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

// Returns the index of the matching stored hash, or -1. Compares against every
// hash (no early exit) so timing doesn't reveal which code matched.
export function verifyRecoveryCode(code: string, hashes: string[]): number {
  const presented = Buffer.from(hashRecoveryCode(code));
  let found = -1;
  for (let i = 0; i < hashes.length; i++) {
    const stored = Buffer.from(hashes[i]!);
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      found = i;
    }
  }
  return found;
}
