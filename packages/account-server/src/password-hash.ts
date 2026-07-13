// packages/account-server/src/password-hash.ts
// Account password hashing with argon2id (vision §4.4 — OWASP top choice; a
// deliberate deviation from Gusto's bcryptjs). Thin, well-guarded wrapper so
// the rest of the service never touches argon2 options directly.

import argon2 from 'argon2';

// OWASP-aligned argon2id parameters (memory-hard). Kept here as the single
// source of truth; tune with benchmarks on the deploy target later.
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

// Returns false (never throws) on a wrong password OR a malformed/empty stored
// hash, so a corrupt row can't crash the auth path.
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
