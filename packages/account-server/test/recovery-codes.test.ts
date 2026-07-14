// S2.4 — recovery codes, pure layer (vision §4.4). One-time backup codes for
// when an authenticator is lost. Only SHA-256 hashes are stored; codes are
// matched case-/format-insensitively and in constant time; single-use is the
// caller's job (remove the matched hash).

import { describe, expect, test } from 'vitest';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../src/recovery-codes.js';

describe('generateRecoveryCodes', () => {
  test('returns N unique codes with matching sha-256 hashes', () => {
    const { codes, hashes } = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10); // unique
    for (let i = 0; i < codes.length; i++) {
      expect(hashes[i]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes[i]).toBe(hashRecoveryCode(codes[i]!));
    }
  });
});

describe('verifyRecoveryCode', () => {
  test('finds the index of a valid code and is insensitive to case/format', () => {
    const { codes, hashes } = generateRecoveryCodes(5);
    const target = codes[2]!;
    expect(verifyRecoveryCode(target, hashes)).toBe(2);

    const messy = ` ${target.toLowerCase().replace(/-/g, ' ')} `;
    expect(verifyRecoveryCode(messy, hashes)).toBe(2);
  });

  test('returns -1 for an unknown or malformed code', () => {
    const { hashes } = generateRecoveryCodes(5);
    expect(verifyRecoveryCode('not-a-real-code', hashes)).toBe(-1);
    expect(verifyRecoveryCode('', hashes)).toBe(-1);
    expect(verifyRecoveryCode('ABCDE-FGHIJ', [])).toBe(-1);
  });
});
