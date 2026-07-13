import { describe, it, expect } from 'vitest';
import { createToken, hashToken, checkToken, DEFAULT_TTL_MS } from '../src/one-time-token.js';

// Storage-agnostic one-time tokens for email verification / password reset
// (vision §4.4: one-time, 24h TTL, single-use, invalidated on resend). The RAW
// token is what gets emailed; only its HASH is ever stored, so a DB leak can't
// mint valid links. `now` is injected for deterministic tests.
const T0 = 1_000_000_000_000; // fixed epoch ms

describe('one-time-token', () => {
  it('createToken returns a raw token plus its storable hash and an expiry', () => {
    const { token, tokenHash, expiresAt } = createToken({ now: T0 });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(32); // high-entropy, URL-safe
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenHash).toBe(hashToken(token)); // hash matches the raw token
    expect(tokenHash).not.toBe(token); // never store the raw value
    expect(expiresAt).toBe(T0 + DEFAULT_TTL_MS);
  });

  it('each token is unique', () => {
    const a = createToken({ now: T0 });
    const b = createToken({ now: T0 });
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('honors a custom ttl', () => {
    const { expiresAt } = createToken({ now: T0, ttlMs: 60_000 });
    expect(expiresAt).toBe(T0 + 60_000);
  });

  it('checkToken accepts the right token before expiry', () => {
    const { token, tokenHash, expiresAt } = createToken({ now: T0 });
    expect(checkToken({ token, storedHash: tokenHash, expiresAt }, T0 + 1000)).toBe('ok');
  });

  it('checkToken rejects a wrong token as a mismatch (constant-time compare)', () => {
    const { tokenHash, expiresAt } = createToken({ now: T0 });
    expect(checkToken({ token: 'some-other-token', storedHash: tokenHash, expiresAt }, T0 + 1000)).toBe('mismatch');
  });

  it('checkToken rejects an expired token even if it matches', () => {
    const { token, tokenHash, expiresAt } = createToken({ now: T0 });
    expect(checkToken({ token, storedHash: tokenHash, expiresAt }, expiresAt + 1)).toBe('expired');
    // exactly at expiry is still valid (inclusive)
    expect(checkToken({ token, storedHash: tokenHash, expiresAt }, expiresAt)).toBe('ok');
  });

  it('checkToken is defensive against empty/garbage stored state', () => {
    expect(checkToken({ token: 'x', storedHash: '', expiresAt: T0 }, T0)).toBe('mismatch');
    expect(checkToken({ token: '', storedHash: 'abc', expiresAt: T0 }, T0)).toBe('mismatch');
  });
});
