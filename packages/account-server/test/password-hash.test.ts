import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password-hash.js';

// argon2id per vision §4.4 (deliberate deviation from Gusto's bcryptjs). These
// are the real KDF calls, so allow generous time for the native hash.
describe('password-hash (argon2id)', () => {
  it('hashes to an argon2id PHC string, never the plaintext', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery');
  }, 10000);

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password entirely')).toBe(false);
  }, 10000);

  it('salts: the same password hashes differently each time', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(b, 'correct horse battery')).toBe(true);
  }, 15000);

  it('verify never throws on a malformed stored hash — returns false', async () => {
    expect(await verifyPassword('not-a-real-hash', 'whatever')).toBe(false);
    expect(await verifyPassword('', 'whatever')).toBe(false);
  }, 10000);
});
