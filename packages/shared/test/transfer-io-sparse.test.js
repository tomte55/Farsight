import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSparsePartFile, openSourceReader, finalizeReceivedFile, finalizeReceivedPath, confineDestPath } from '../src/transfer-io.js';
import { createHash } from 'node:crypto';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fs-sparse-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createSparsePartFile', () => {
  it('writes chunks out of order at their offsets and reassembles correctly', async () => {
    const p = await createSparsePartFile({ destRoot: dir, relPath: 'sub/out.bin' });
    await p.writeAt(8, new Uint8Array([9, 9, 9, 9]));   // write the tail first
    await p.writeAt(0, new Uint8Array([1, 2, 3, 4]));
    await p.writeAt(4, new Uint8Array([5, 6, 7, 8]));
    await p.fsync();
    await p.close();
    const bytes = new Uint8Array(await readFile(p.partPath));
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9]);
    expect(p.liveDigest()).toBe(null);
  });

  it('is compatible with finalizeReceivedFile (completion-read verify + rename)', async () => {
    const content = new Uint8Array([10, 20, 30, 40, 50]);
    const p = await createSparsePartFile({ destRoot: dir, relPath: 'f.bin' });
    await p.writeAt(0, content);
    await p.fsync();
    const hash = createHash('sha256').update(content).digest('hex');
    const r = await finalizeReceivedFile({ partFile: p, expectedHash: hash, mtime: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    expect(new Uint8Array(await readFile(p.finalPath))).toEqual(content);
  });
});

describe('finalizeReceivedPath', () => {
  it('a complete .part whose hash matches renames to final and returns ok', async () => {
    const content = new Uint8Array([1, 2, 3, 4, 5]);
    const p = await createSparsePartFile({ destRoot: dir, relPath: 'a.bin' });
    await p.writeAt(0, content);
    await p.fsync();
    await p.close();
    const hash = createHash('sha256').update(content).digest('hex');
    const r = await finalizeReceivedPath({ destRoot: dir, relPath: 'a.bin', expectedHash: hash, mtime: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    expect(new Uint8Array(await readFile(join(dir, 'a.bin')))).toEqual(content);
  });

  it('hash mismatch removes the .part and returns not-ok', async () => {
    const content = new Uint8Array([9, 9, 9]);
    const p = await createSparsePartFile({ destRoot: dir, relPath: 'b.bin' });
    await p.writeAt(0, content);
    await p.fsync();
    await p.close();
    const r = await finalizeReceivedPath({ destRoot: dir, relPath: 'b.bin', expectedHash: 'deadbeef', mtime: 1_700_000_000_000 });
    expect(r.ok).toBe(false);
    const finalPath = confineDestPath(dir, 'b.bin');
    await expect(stat(`${finalPath}.part`)).rejects.toThrow();
  });

  it('no .part but the final already exists (already-finalized resume case) returns ok without re-hashing', async () => {
    await writeFile(join(dir, 'c.bin'), new Uint8Array([7, 7]));
    const r = await finalizeReceivedPath({ destRoot: dir, relPath: 'c.bin', expectedHash: 'irrelevant-not-checked', mtime: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
  });

  it('neither .part nor final exists returns not-ok', async () => {
    const r = await finalizeReceivedPath({ destRoot: dir, relPath: 'nope.bin', expectedHash: 'x', mtime: 1 });
    expect(r.ok).toBe(false);
  });
});

describe('openSourceReader', () => {
  it('reads exactly the requested slice at an offset', async () => {
    const src = join(dir, 'src.bin');
    await writeFile(src, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const r = await openSourceReader(src);
    expect([...(await r.readAt(3, 4))]).toEqual([3, 4, 5, 6]);
    expect([...(await r.readAt(8, 99))]).toEqual([8, 9]); // clamps at EOF
    await r.close();
  });
});
