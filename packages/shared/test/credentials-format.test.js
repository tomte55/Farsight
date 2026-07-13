import { expect, test } from 'vitest';
import { formatHostId, normalizeHostId, normalizePassword } from '../src/credentials-format.js';

test('formatHostId groups 9 digits 3-3-3 with spaces', () => {
  expect(formatHostId('947188129')).toBe('947 188 129');
});

test('formatHostId tolerates incidental separators in its input', () => {
  expect(formatHostId('947 188 129')).toBe('947 188 129');
  expect(formatHostId('947-188-129')).toBe('947 188 129');
});

test('normalizeHostId strips everything but digits', () => {
  expect(normalizeHostId('947 188 129')).toBe('947188129');
  expect(normalizeHostId(' 947-188-129 ')).toBe('947188129');
  expect(normalizeHostId(null)).toBe('');
});

test('normalizePassword lowercases and strips separators/whitespace', () => {
  expect(normalizePassword('K7M9PQ')).toBe('k7m9pq');
  expect(normalizePassword(' k7m 9pq ')).toBe('k7m9pq');
  expect(normalizePassword('k7m-9pq')).toBe('k7m9pq');
});

test('normalize helpers are idempotent', () => {
  expect(normalizeHostId(normalizeHostId('947 188 129'))).toBe('947188129');
  expect(normalizePassword(normalizePassword('K7M9PQ'))).toBe('k7m9pq');
});
