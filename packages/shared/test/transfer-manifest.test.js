import { expect, test } from 'vitest';
import { sanitizeRelativePath, validateEntry, buildManifest, skipExisting } from '../src/transfer-manifest.js';

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

test('buildManifest validates, sanitizes paths, and totals size/count', () => {
  const m = buildManifest([
    { fileId: 0, path: 'a\\b.txt', size: 10, mtime: 1 },
    { fileId: 1, path: 'c.bin', size: 5, mtime: 2 },
  ]);
  expect(m.entries[0].path).toBe('a/b.txt');
  expect(m.totalBytes).toBe(15);
  expect(m.totalFiles).toBe(2);
});

test('buildManifest throws on empty, invalid entry, or duplicate fileId', () => {
  expect(() => buildManifest([])).toThrow();
  expect(() => buildManifest([{ fileId: 0, path: '../x', size: 1, mtime: 0 }])).toThrow();
  expect(() => buildManifest([
    { fileId: 0, path: 'a', size: 1, mtime: 0 },
    { fileId: 0, path: 'b', size: 1, mtime: 0 },
  ])).toThrow();
});

test('skipExisting is true only when size and mtime both match', () => {
  const e = { fileId: 0, path: 'a', size: 10, mtime: 1720000000000 };
  expect(skipExisting(e, { size: 10, mtime: 1720000000000 })).toBe(true);
  expect(skipExisting(e, { size: 10, mtime: 999 })).toBe(false);
  expect(skipExisting(e, { size: 9, mtime: 1720000000000 })).toBe(false);
  expect(skipExisting(e, null)).toBe(false);
});
