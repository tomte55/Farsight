// packages/shared/test/file-transfer.test.js
import { expect, test } from 'vitest';
import {
  CHUNK_SIZE, MAX_FILE_SIZE, metaFrame, endFrame, cancelFrame, parseFrame,
  sanitizeFilename, validateMeta, createReceiver,
} from '../src/file-transfer.js';

test('constants match the protocol design', () => {
  expect(CHUNK_SIZE).toBe(16384);
  expect(MAX_FILE_SIZE).toBe(104857600);
});

test('framing round-trips through parseFrame', () => {
  const meta = metaFrame({ id: 1, name: 'a.txt', size: 10, mime: 'text/plain' });
  expect(parseFrame(meta)).toEqual({ t: 'meta', id: 1, name: 'a.txt', size: 10, mime: 'text/plain' });
  expect(parseFrame(endFrame(1))).toEqual({ t: 'end', id: 1 });
  expect(parseFrame(cancelFrame(1))).toEqual({ t: 'cancel', id: 1 });
});

test('parseFrame is tolerant of bad JSON and unknown shapes', () => {
  expect(parseFrame('not json{')).toBeNull();
  expect(parseFrame('null')).toBeNull();
  expect(parseFrame('42')).toBeNull();
  expect(parseFrame(JSON.stringify({ t: 'nope' }))).toBeNull();
  expect(parseFrame(JSON.stringify({ noType: true }))).toBeNull();
  expect(parseFrame(undefined)).toBeNull();
  expect(parseFrame(123)).toBeNull();
});

test('parseFrame rejects a meta frame with an oversized or malformed payload', () => {
  expect(parseFrame(JSON.stringify({ t: 'meta', id: 1, name: 'x', size: MAX_FILE_SIZE + 1, mime: 'a' }))).toBeNull();
  expect(parseFrame(JSON.stringify({ t: 'meta', id: 1, name: 1, size: 1, mime: 'a' }))).toBeNull();
  expect(parseFrame(JSON.stringify({ t: 'meta', id: 1, name: 'x', size: -1, mime: 'a' }))).toBeNull();
  expect(parseFrame(JSON.stringify({ t: 'meta', id: 1, name: 'x', size: 1, mime: 1 }))).toBeNull();
  expect(parseFrame(JSON.stringify({ t: 'meta', id: 'nope', name: 'x', size: 1, mime: 'a' }))).toBeNull();
  expect(parseFrame(JSON.stringify({ t: 'end', id: 'nope' }))).toBeNull();
});

test('validateMeta accepts a well-formed meta and rejects malformed ones', () => {
  expect(validateMeta({ name: 'a', size: 0, mime: 'text/plain' })).toBe(true);
  expect(validateMeta({ name: 'a', size: MAX_FILE_SIZE, mime: '' })).toBe(true);
  expect(validateMeta(null)).toBe(false);
  expect(validateMeta({ name: 'a', size: MAX_FILE_SIZE + 1, mime: 'a' })).toBe(false);
  expect(validateMeta({ name: 'a', size: 1.5, mime: 'a' })).toBe(false);
  expect(validateMeta({ name: 'a', size: -1, mime: 'a' })).toBe(false);
  expect(validateMeta({ name: 1, size: 1, mime: 'a' })).toBe(false);
  expect(validateMeta({ name: 'a', size: 1, mime: 1 })).toBe(false);
});

test('sanitizeFilename strips path traversal and separators, keeping only the basename', () => {
  expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  expect(sanitizeFilename('a/b\\c.txt')).toBe('c.txt');
  expect(sanitizeFilename('')).toBe('download');
  expect(sanitizeFilename('..')).toBe('download');
  expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  expect(sanitizeFilename('C:\\Users\\me\\secret.docx')).toBe('secret.docx');
  expect(sanitizeFilename(null)).toBe('download');
  expect(sanitizeFilename(undefined)).toBe('download');
  expect(sanitizeFilename(123)).toBe('download');
});

test('sanitizeFilename is idempotent (re-sanitizing an already-clean name is a no-op)', () => {
  const once = sanitizeFilename('../weird/na..me.txt');
  expect(sanitizeFilename(once)).toBe(once);
});

test('createReceiver tracks progress, size, and completion', () => {
  const progresses = [];
  const receiver = createReceiver({ onProgress: (p) => progresses.push(p) });
  receiver.begin({ name: 'file.bin', size: 100, mime: 'application/octet-stream' });
  expect(receiver.size).toBe(100);
  expect(receiver.received).toBe(0);
  expect(receiver.isComplete()).toBe(false);
  receiver.pushChunkBytes(40);
  expect(receiver.received).toBe(40);
  expect(progresses[0]).toBeCloseTo(0.4);
  expect(receiver.isComplete()).toBe(false);
  receiver.pushChunkBytes(60);
  expect(receiver.received).toBe(100);
  expect(progresses[1]).toBeCloseTo(1);
  expect(receiver.isComplete()).toBe(true);
});

test('createReceiver.begin sanitizes the filename and exposes name/mime', () => {
  const receiver = createReceiver({});
  receiver.begin({ name: '../../etc/passwd', size: 1, mime: 'text/plain' });
  expect(receiver.name).toBe('passwd');
  expect(receiver.mime).toBe('text/plain');
});

test('createReceiver.begin rejects an oversized meta', () => {
  const receiver = createReceiver({});
  expect(() => receiver.begin({ name: 'x', size: MAX_FILE_SIZE + 1, mime: 'a' })).toThrow();
});

test('createReceiver.end() forces completion even if fewer bytes arrived than declared', () => {
  const receiver = createReceiver({});
  receiver.begin({ name: 'a', size: 1000, mime: 'a' });
  receiver.pushChunkBytes(10);
  expect(receiver.isComplete()).toBe(false);
  receiver.end();
  expect(receiver.isComplete()).toBe(true);
});

test('createReceiver handles a zero-byte file as immediately complete', () => {
  const receiver = createReceiver({});
  receiver.begin({ name: 'empty.txt', size: 0, mime: 'text/plain' });
  expect(receiver.isComplete()).toBe(true);
});
