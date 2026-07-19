// packages/shared/test/host-id.test.js
import { expect, test } from 'vitest';
import { generateHostId, isValidHostId, generateSessionId } from '../src/host-id.js';

test('generateHostId produces a valid 9-digit id', () => {
  for (let i = 0; i < 100; i++) {
    const id = generateHostId();
    expect(id).toMatch(/^[1-9]\d{8}$/);
    expect(isValidHostId(id)).toBe(true);
  }
});

test('generateSessionId produces a 128-bit (32 hex char) token, distinct each call', () => {
  // Transfer sessionIds are bearer capabilities: ATTACH grants the session to
  // whoever presents the id, with no targetId check. A 9-digit host id (~30 bits)
  // is brute-forceable; this must be 128 bits so it can't be guessed. Distinctness
  // across 100 draws is a cheap CSPRNG/entropy sanity check.
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(seen.has(id)).toBe(false);
    seen.add(id);
    expect(isValidHostId(id)).toBe(false); // never mistakable for a host id
  }
});

test('isValidHostId rejects bad inputs', () => {
  expect(isValidHostId('012345678')).toBe(false); // leading zero
  expect(isValidHostId('12345')).toBe(false);      // too short
  expect(isValidHostId('12345678a')).toBe(false);   // non-digit
  expect(isValidHostId(123456789)).toBe(false);     // not a string
});
