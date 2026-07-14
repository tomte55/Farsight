// S2.4 — TOTP (RFC 6238), pure layer (vision §4.4). 2FA is optional per account
// and never required for management; this is the verification primitive. The
// core is proven against RFC 6238 Appendix B's published test vectors, then the
// account-facing 6-digit/SHA-1 verify (with a skew window) is tested on top.

import { describe, expect, test } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
} from '../src/totp.js';

describe('RFC 6238 Appendix B test vectors (SHA-1, 8 digits)', () => {
  const secret = new TextEncoder().encode('12345678901234567890'); // RFC seed
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of cases) {
    test(`t=${seconds}s → ${expected}`, () => {
      expect(totpCode(secret, seconds * 1000, { digits: 8, stepMs: 30_000 })).toBe(expected);
    });
  }
});

describe('base32', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 42, 7]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('generateTotpSecret', () => {
  test('produces a decodable, non-trivial, unique secret', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(base32Decode(a).length).toBeGreaterThanOrEqual(16); // ≥128 bits
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const decoded = base32Decode(secret);
  const T = 1_700_000_000_000;

  test('accepts the current code', () => {
    const code = totpCode(decoded, T);
    expect(verifyTotp(secret, code, T)).toBe(true);
  });

  test('accepts a code one step off (clock skew, window=1)', () => {
    const prevStepCode = totpCode(decoded, T);
    expect(verifyTotp(secret, prevStepCode, T + 30_000, { window: 1 })).toBe(true);
  });

  test('rejects a code outside the window', () => {
    const oldCode = totpCode(decoded, T);
    expect(verifyTotp(secret, oldCode, T + 60_000, { window: 1 })).toBe(false);
  });

  test('rejects a wrong or malformed code without throwing', () => {
    expect(verifyTotp(secret, '000000', T)).toBe(false);
    expect(verifyTotp(secret, 'nope', T)).toBe(false);
    expect(verifyTotp(secret, '', T)).toBe(false);
  });
});
