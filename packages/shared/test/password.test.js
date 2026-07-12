// packages/shared/test/password.test.js
import { expect, test } from 'vitest';
import { generateSessionPassword, constantTimeEqual } from '../src/password.js';

test('password has expected shape and unambiguous alphabet', () => {
  for (let i = 0; i < 50; i++) {
    const p = generateSessionPassword();
    expect(p).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);
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
