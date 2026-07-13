import { expect, test } from 'vitest';
import { parseVersion, compareVersions, isOlder, isNewer } from '../src/version.js';

test('parseVersion accepts x.y.z with optional v prefix and trailing pre-release/build', () => {
  expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  expect(parseVersion('v1.4.1')).toEqual({ major: 1, minor: 4, patch: 1 });
  expect(parseVersion('1.4.1-beta.2')).toEqual({ major: 1, minor: 4, patch: 1 });
  expect(parseVersion(' 2.0.0 ')).toEqual({ major: 2, minor: 0, patch: 0 });
});

test('parseVersion returns null for garbage / missing input', () => {
  expect(parseVersion('')).toBeNull();
  expect(parseVersion('not-a-version')).toBeNull();
  expect(parseVersion('1.2')).toBeNull();
  expect(parseVersion(undefined)).toBeNull();
  expect(parseVersion(null)).toBeNull();
  expect(parseVersion(123)).toBeNull();
});

test('compareVersions orders by major, then minor, then patch', () => {
  expect(compareVersions('1.4.1', '1.4.1')).toBe(0);
  expect(compareVersions('1.3.1', '1.4.1')).toBe(-1);
  expect(compareVersions('1.4.1', '1.3.9')).toBe(1);
  expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  expect(compareVersions('1.4.0', '1.4.1')).toBe(-1);
});

test('compareVersions returns null when either side is unparseable (unknown, not a claim)', () => {
  expect(compareVersions('1.4.1', undefined)).toBeNull();
  expect(compareVersions(undefined, '1.4.1')).toBeNull();
  expect(compareVersions('garbage', '1.4.1')).toBeNull();
});

test('isOlder / isNewer are strict and null-safe', () => {
  expect(isOlder('1.3.1', '1.4.1')).toBe(true);
  expect(isOlder('1.4.1', '1.4.1')).toBe(false);
  expect(isOlder('1.5.0', '1.4.1')).toBe(false);
  expect(isNewer('1.5.0', '1.4.1')).toBe(true);
  // unknown comparisons are never "older"/"newer"
  expect(isOlder('1.3.1', undefined)).toBe(false);
  expect(isNewer(undefined, '1.4.1')).toBe(false);
});
