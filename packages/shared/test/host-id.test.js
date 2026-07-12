// packages/shared/test/host-id.test.js
import { expect, test } from 'vitest';
import { generateHostId, isValidHostId } from '../src/host-id.js';

test('generateHostId produces a valid 9-digit id', () => {
  for (let i = 0; i < 100; i++) {
    const id = generateHostId();
    expect(id).toMatch(/^[1-9]\d{8}$/);
    expect(isValidHostId(id)).toBe(true);
  }
});

test('isValidHostId rejects bad inputs', () => {
  expect(isValidHostId('012345678')).toBe(false); // leading zero
  expect(isValidHostId('12345')).toBe(false);      // too short
  expect(isValidHostId('12345678a')).toBe(false);   // non-digit
  expect(isValidHostId(123456789)).toBe(false);     // not a string
});
