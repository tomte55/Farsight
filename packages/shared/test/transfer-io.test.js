// SP3 transfer-io (spec §6): main-process streamed-to-disk layer. Temp-dir tests.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confineDestPath } from '../src/transfer-io.js';

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

import { hashFile } from '../src/transfer-io.js';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('hashFile returns the hex SHA-256 of the file contents', async () => {
  const root = tmp();
  const f = join(root, 'blob.bin');
  const data = Buffer.from('the quick brown fox'.repeat(1000));
  writeFileSync(f, data);
  const expected = createHash('sha256').update(data).digest('hex');
  expect(await hashFile(f)).toBe(expected);
});

test('hashFile of an empty file is the SHA-256 of empty input', async () => {
  const root = tmp();
  const f = join(root, 'empty.bin');
  writeFileSync(f, Buffer.alloc(0));
  expect(await hashFile(f)).toBe(createHash('sha256').digest('hex'));
});

import { walkSource } from '../src/transfer-io.js';
import { mkdirSync } from 'node:fs';

test('walkSource turns a single file into a one-entry manifest source', async () => {
  const root = tmp();
  const f = join(root, 'report.pdf');
  writeFileSync(f, Buffer.alloc(1234));
  const { entries, sources } = await walkSource([{ path: f }]);
  expect(entries.length).toBe(1);
  expect(entries[0].path).toBe('report.pdf');
  expect(entries[0].size).toBe(1234);
  expect(Number.isInteger(entries[0].mtime)).toBe(true);
  expect(sources.get(entries[0].fileId)).toBe(f);
});

test('walkSource recurses a directory with posix relative paths under the dir name', async () => {
  const root = tmp();
  const src = join(root, 'game');
  mkdirSync(join(src, 'data'), { recursive: true });
  writeFileSync(join(src, 'a.txt'), Buffer.alloc(10));
  writeFileSync(join(src, 'data', 'b.bin'), Buffer.alloc(20));
  const { entries, sources } = await walkSource([{ path: src }]);
  const paths = entries.map((e) => e.path).sort();
  expect(paths).toEqual(['game/a.txt', 'game/data/b.bin']);
  // Every entry maps back to a real absolute source path.
  for (const e of entries) expect(typeof sources.get(e.fileId)).toBe('string');
  // fileIds are unique and sequential from 0.
  expect(new Set(entries.map((e) => e.fileId)).size).toBe(entries.length);
});

// createPartFile/sendFile (single-flow-only) were removed in Phase 2 Task 6 (F-C1/C2
// dead code) along with hasFreeSpace/freeSpaceBytes/publishFullyReceivedFile.
// finalizeReceivedFile survives (it's still exercised as a verifyAndFinalize strategy
// by the multi-flow receiver in transfer-io-sparse.test.js and
// transfer-multiflow-service-loopback.test.js) — paired here with the coverage path's
// createSparsePartFile instead of the deleted createPartFile.
import { createSparsePartFile, finalizeReceivedFile } from '../src/transfer-io.js';
import { statSync, readFileSync, existsSync } from 'node:fs';

test('finalizeReceivedFile verifies via completion read, renames .part and restores mtime', async () => {
  const root = tmp();
  const pf = await createSparsePartFile({ destRoot: root, relPath: 'ok/file.bin' });
  const data = Buffer.from('payload-bytes-1234');
  await pf.writeAt(0, data); await pf.fsync(); await pf.close();
  const expected = createHash('sha256').update(data).digest('hex');
  const mtime = 1_700_000_000_000; // ms
  const r = await finalizeReceivedFile({ partFile: pf, expectedHash: expected, mtime });
  expect(r.ok).toBe(true);
  expect(existsSync(pf.partPath)).toBe(false);
  expect(existsSync(pf.finalPath)).toBe(true);
  expect(readFileSync(pf.finalPath)).toEqual(data);
  // mtime restored (seconds granularity is enough to assert)
  expect(Math.round(statSync(pf.finalPath).mtimeMs / 1000)).toBe(Math.round(mtime / 1000));
});

test('finalizeReceivedFile discards the .part on a hash mismatch', async () => {
  const root = tmp();
  const pf = await createSparsePartFile({ destRoot: root, relPath: 'bad.bin' });
  await pf.writeAt(0, Buffer.from('corrupted')); await pf.close();
  const r = await finalizeReceivedFile({ partFile: pf, expectedHash: 'deadbeef', mtime: 1 });
  expect(r.ok).toBe(false);
  expect(existsSync(pf.partPath)).toBe(false);
  expect(existsSync(pf.finalPath)).toBe(false);
});
