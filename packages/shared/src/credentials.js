// packages/shared/src/credentials.js
// Persistent-credential hashing for optional unattended access. Off by default;
// this is the vetted primitive only (no UI wiring yet). Runs in Node/main —
// argon2 is native and must not be imported into the sandboxed renderer.
import argon2 from 'argon2';

export function hashCredential(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyCredential(hash, plain) {
  try { return await argon2.verify(hash, plain); }
  catch { return false; }
}
