// packages/shared/test/password.test.js
import { expect, test } from 'vitest';
import { generateSessionPassword, constantTimeEqual } from '../src/password.js';

test('password is 6 chars from the unambiguous alphabet, no separators', () => {
  for (let i = 0; i < 50; i++) {
    const p = generateSessionPassword();
    expect(p).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
  }
});

test('passwords are not trivially repeated', () => {
  const a = generateSessionPassword();
  const b = generateSessionPassword();
  expect(a).not.toBe(b);
});

test('constantTimeEqual matches equal strings and rejects others', () => {
  expect(constantTimeEqual('abc', 'abc')).toBe(true);
  expect(constantTimeEqual('abc', 'abd')).toBe(false);
  expect(constantTimeEqual('abc', 'abcd')).toBe(false);
});
