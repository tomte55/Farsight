import { expect, test } from 'vitest';
import { formatHostId, normalizeHostId, normalizePassword, passwordCandidates } from '../src/credentials-format.js';

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

test('passwordCandidates yields a single candidate when input already equals its normalized form', () => {
  // New host, typed exactly as shown → no fallback, no wasted retry.
  expect(passwordCandidates('k7m9pq')).toEqual(['k7m9pq']);
});

test('passwordCandidates keeps the raw value as a fallback whenever it differs (case or separators)', () => {
  // The raw fallback is only ever *tried* after the normalized form fails
  // (on bad_password), so an extra harmless candidate here costs nothing on
  // the happy path.
  expect(passwordCandidates('K7M9PQ')).toEqual(['k7m9pq', 'K7M9PQ']);
});

test('passwordCandidates adds the raw typed value as a compat fallback (old dashed hosts)', () => {
  // Pre-v1.4 host registered the dashed literal shown on screen; the normalized
  // form (de-dashed, lowercased) is tried first, the raw typed value second.
  expect(passwordCandidates('AB-CD-EF')).toEqual(['abcdef', 'AB-CD-EF']);
  expect(passwordCandidates('23-45-67')).toEqual(['234567', '23-45-67']);
});

test('passwordCandidates trims outer whitespace and drops empties', () => {
  expect(passwordCandidates('  AB-CD-EF  ')).toEqual(['abcdef', 'AB-CD-EF']);
  expect(passwordCandidates('   ')).toEqual([]);
  expect(passwordCandidates('')).toEqual([]);
  expect(passwordCandidates(null)).toEqual([]);
});

test('normalize helpers are idempotent', () => {
  expect(normalizeHostId(normalizeHostId('947 188 129'))).toBe('947188129');
  expect(normalizePassword(normalizePassword('K7M9PQ'))).toBe('k7m9pq');
});
