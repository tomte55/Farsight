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

import { createPartFile } from '../src/transfer-io.js';
import { statSync, readFileSync } from 'node:fs';

test('createPartFile writes bytes to a .part and tracks a live hash', async () => {
  const root = tmp();
  const pf = await createPartFile({ destRoot: root, relPath: 'out/data.bin', resumeFrom: 0, hashLive: true });
  expect(pf.offset).toBe(0);
  const chunk = Buffer.from('hello world');
  await pf.write(chunk);
  await pf.fsync();
  await pf.close();
  expect(statSync(pf.partPath).size).toBe(chunk.length);
  expect(readFileSync(pf.partPath)).toEqual(chunk);
  expect(pf.liveDigest()).toBe(createHash('sha256').update(chunk).digest('hex'));
});

test('createPartFile resumes append at the existing .part size', async () => {
  const root = tmp();
  const first = await createPartFile({ destRoot: root, relPath: 'r.bin', resumeFrom: 0, hashLive: false });
  await first.write(Buffer.from('AAAA'));
  await first.fsync(); await first.close();
  expect(first.liveDigest()).toBeNull();

  const resumed = await createPartFile({ destRoot: root, relPath: 'r.bin', resumeFrom: 4, hashLive: false });
  expect(resumed.offset).toBe(4);
  await resumed.write(Buffer.from('BBBB'));
  await resumed.close();
  expect(readFileSync(resumed.partPath)).toEqual(Buffer.from('AAAABBBB'));
});

test('createPartFile forces completion-read hashing when resuming (no valid live hash)', async () => {
  const root = tmp();
  const a = await createPartFile({ destRoot: root, relPath: 'resume-hash.bin', resumeFrom: 0, hashLive: true });
  await a.write(Buffer.from('AAAA')); await a.close();
  // Resuming re-opens the writer → the live hash cannot cover the prior bytes,
  // so liveDigest() must be null, forcing finalize to do a completion read.
  const b = await createPartFile({ destRoot: root, relPath: 'resume-hash.bin', resumeFrom: 4, hashLive: true });
  expect(b.offset).toBe(4);
  await b.write(Buffer.from('BBBB')); await b.close();
  expect(b.liveDigest()).toBeNull();
});

test('createPartFile with resumeFrom 0 truncates a stale .part', async () => {
  const root = tmp();
  const a = await createPartFile({ destRoot: root, relPath: 's.bin', resumeFrom: 0, hashLive: false });
  await a.write(Buffer.from('STALE-DATA')); await a.close();
  const b = await createPartFile({ destRoot: root, relPath: 's.bin', resumeFrom: 0, hashLive: false });
  expect(b.offset).toBe(0);
  await b.write(Buffer.from('X')); await b.close();
  expect(readFileSync(b.partPath)).toEqual(Buffer.from('X'));
});

import { finalizeReceivedFile } from '../src/transfer-io.js';
import { existsSync } from 'node:fs';

test('finalizeReceivedFile with a matching live hash renames .part and restores mtime', async () => {
  const root = tmp();
  const pf = await createPartFile({ destRoot: root, relPath: 'ok/file.bin', resumeFrom: 0, hashLive: true });
  const data = Buffer.from('payload-bytes-1234');
  await pf.write(data); await pf.fsync(); await pf.close();
  const mtime = 1_700_000_000_000; // ms
  const r = await finalizeReceivedFile({ partFile: pf, expectedHash: pf.liveDigest(), mtime });
  expect(r.ok).toBe(true);
  expect(existsSync(pf.partPath)).toBe(false);
  expect(existsSync(pf.finalPath)).toBe(true);
  expect(readFileSync(pf.finalPath)).toEqual(data);
  // mtime restored (seconds granularity is enough to assert)
  expect(Math.round(statSync(pf.finalPath).mtimeMs / 1000)).toBe(Math.round(mtime / 1000));
});

test('finalizeReceivedFile falls back to a completion read when there is no live hash', async () => {
  const root = tmp();
  const pf = await createPartFile({ destRoot: root, relPath: 'noh.bin', resumeFrom: 0, hashLive: false });
  const data = Buffer.from('restart-path-bytes');
  await pf.write(data); await pf.close();
  const expected = createHash('sha256').update(data).digest('hex');
  expect(pf.liveDigest()).toBeNull();
  const r = await finalizeReceivedFile({ partFile: pf, expectedHash: expected, mtime: 1_700_000_000_000 });
  expect(r.ok).toBe(true);
  expect(existsSync(pf.finalPath)).toBe(true);
});

test('finalizeReceivedFile discards the .part on a hash mismatch', async () => {
  const root = tmp();
  const pf = await createPartFile({ destRoot: root, relPath: 'bad.bin', resumeFrom: 0, hashLive: true });
  await pf.write(Buffer.from('corrupted')); await pf.close();
  const r = await finalizeReceivedFile({ partFile: pf, expectedHash: 'deadbeef', mtime: 1 });
  expect(r.ok).toBe(false);
  expect(existsSync(pf.partPath)).toBe(false);
  expect(existsSync(pf.finalPath)).toBe(false);
});

import { sendFile } from '../src/transfer-io.js';

test('sendFile hashes the whole file and streams every byte when offset is 0', async () => {
  const root = tmp();
  const f = join(root, 'src.bin');
  const data = Buffer.from('0123456789'.repeat(500)); // 5000 bytes
  writeFileSync(f, data);
  const got = [];
  const { hash } = await sendFile({ sourcePath: f, offset: 0, chunkSize: 512, onChunk: async (b) => { got.push(Buffer.from(b)); } });
  expect(hash).toBe(createHash('sha256').update(data).digest('hex'));
  expect(Buffer.concat(got)).toEqual(data);
});

test('sendFile rejects and tears down the stream when onChunk throws', async () => {
  const root = tmp();
  const f = join(root, 'abort.bin');
  writeFileSync(f, Buffer.alloc(10000));
  await expect(sendFile({
    sourcePath: f, offset: 0, chunkSize: 256, onChunk: async () => { throw new Error('boom'); },
  })).rejects.toThrow('boom');
});

test('sendFile hashes the whole file but only streams bytes from the offset on resume', async () => {
  const root = tmp();
  const f = join(root, 'src2.bin');
  const data = Buffer.from('ABCDEFGHIJ'.repeat(300)); // 3000 bytes
  writeFileSync(f, data);
  const offset = 1234;
  const got = [];
  const { hash } = await sendFile({ sourcePath: f, offset, chunkSize: 256, onChunk: async (b) => { got.push(Buffer.from(b)); } });
  expect(hash).toBe(createHash('sha256').update(data).digest('hex')); // whole-file hash
  expect(Buffer.concat(got)).toEqual(data.subarray(offset)); // only the tail streamed
});
