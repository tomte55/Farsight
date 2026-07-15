// SP3 transfer-io (spec §6): main-process streamed-to-disk layer. Temp-dir tests.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confineDestPath, freeSpaceBytes, hasFreeSpace } from '../src/transfer-io.js';

const dirs = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'ftio-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

test('confineDestPath keeps safe relative paths under the root', () => {
  const root = tmp();
  const p = confineDestPath(root, 'a/b/c.txt');
  expect(p).toBe(join(root, 'a', 'b', 'c.txt'));
});

test('confineDestPath rejects traversal / absolute / drive-letter escapes', () => {
  const root = tmp();
  expect(() => confineDestPath(root, '../escape.txt')).toThrow();
  expect(() => confineDestPath(root, 'a/../../escape')).toThrow();
  expect(() => confineDestPath(root, '/etc/passwd')).toThrow();
  expect(() => confineDestPath(root, 'C:/Windows')).toThrow();
  expect(() => confineDestPath(root, '')).toThrow();
});

test('freeSpaceBytes is a positive number and hasFreeSpace compares to it', async () => {
  const root = tmp();
  const free = await freeSpaceBytes(root);
  expect(typeof free).toBe('number');
  expect(free).toBeGreaterThan(0);
  expect(await hasFreeSpace(root, 0)).toBe(true);
  expect(await hasFreeSpace(root, free + 1_000_000_000_000)).toBe(false);
});
