import { expect, test } from 'vitest';
import { sanitizeRelativePath, validateEntry } from '../src/transfer-manifest.js';

test('sanitizeRelativePath keeps safe relative trees and normalizes separators', () => {
  expect(sanitizeRelativePath('a/b/c.txt')).toBe('a/b/c.txt');
  expect(sanitizeRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt');
  expect(sanitizeRelativePath('./a/./b.txt')).toBe('a/b.txt');
  expect(sanitizeRelativePath('file.txt')).toBe('file.txt');
});

test('sanitizeRelativePath rejects traversal, absolute, and drive-letter paths', () => {
  expect(sanitizeRelativePath('../secret')).toBeNull();
  expect(sanitizeRelativePath('a/../../b')).toBeNull();
  expect(sanitizeRelativePath('/etc/passwd')).toBeNull();
  expect(sanitizeRelativePath('C:/Windows')).toBeNull();
  expect(sanitizeRelativePath('a/C:stream')).toBeNull();
  expect(sanitizeRelativePath('')).toBeNull();
  expect(sanitizeRelativePath('.')).toBeNull();
  expect(sanitizeRelativePath(42)).toBeNull();
});

test('validateEntry accepts a well-formed entry and rejects malformed ones', () => {
  expect(validateEntry({ fileId: 0, path: 'a/b.txt', size: 10, mtime: 1720000000000 })).toBe(true);
  expect(validateEntry({ fileId: 1, path: 'x', size: 0, mtime: 0 })).toBe(true);
  expect(validateEntry(null)).toBe(false);
  expect(validateEntry({ fileId: -1, path: 'x', size: 1, mtime: 0 })).toBe(false);
  expect(validateEntry({ fileId: 1, path: '../x', size: 1, mtime: 0 })).toBe(false);
  expect(validateEntry({ fileId: 1, path: 'x', size: 1.5, mtime: 0 })).toBe(false);
  expect(validateEntry({ fileId: 1, path: 'x', size: 1, mtime: 'no' })).toBe(false);
});
