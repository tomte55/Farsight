import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSparsePartFile, openSourceReader, finalizeReceivedPath, confineDestPath } from '../src/transfer-io.js';
import { createHash } from 'node:crypto';

// A passthrough mock of node:fs/promises' `stat` that lets a couple of
// sentinel-named tests inject a non-ENOENT failure (e.g. a Windows AV-scanner
// transient lock), while every other stat call in this file (mkdtemp, rm,
// readFile, writeFile, and every other test's stat) goes to the real fs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stat: async (path, ...rest) => {
      const p = String(path);
      if (p.includes('trigger-eperm-part') && p.endsWith('.part')) {
        const err = new Error('EPERM: operation not permitted, stat');
        err.code = 'EPERM';
        throw err;
      }
      if (p.includes('trigger-eperm-final') && !p.endsWith('.part')) {
        const err = new Error('EPERM: operation not permitted, stat');
        err.code = 'EPERM';
        throw err;
      }
      return actual.stat(path, ...rest);
    },
  };
});

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

  it('preallocates the .part to the final size so out-of-order writes do not keep extending it', async () => {
    const p = await createSparsePartFile({ destRoot: dir, relPath: 'pre.bin', size: 1000 });
    expect((await stat(p.partPath)).size).toBe(1000); // full size reserved before a byte is written
    await p.close();
  });

  it('grows a resumed .part up to the final size, preserving already-received bytes', async () => {
    const p1 = await createSparsePartFile({ destRoot: dir, relPath: 'resume.bin' });
    await p1.writeAt(0, new Uint8Array([1, 2, 3, 4]));
    await p1.close();
    const p2 = await createSparsePartFile({ destRoot: dir, relPath: 'resume.bin', size: 16 });
    expect((await stat(p2.partPath)).size).toBe(16);
    await p2.close();
    const bytes = new Uint8Array(await readFile(p2.partPath));
    expect([...bytes.slice(0, 4)]).toEqual([1, 2, 3, 4]); // resumed bytes intact
  });

  it('never shrinks a resumed .part that already holds more bytes than a (stale) size hint', async () => {
    const p1 = await createSparsePartFile({ destRoot: dir, relPath: 'grow.bin' });
    await p1.writeAt(0, new Uint8Array(20)); // 20 bytes on disk
    await p1.close();
    const p2 = await createSparsePartFile({ destRoot: dir, relPath: 'grow.bin', size: 8 });
    expect((await stat(p2.partPath)).size).toBe(20); // NOT truncated to 8 — that would destroy received bytes
    await p2.close();
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

  it('a non-ENOENT error statting the .part propagates instead of being treated as absent', async () => {
    await expect(
      finalizeReceivedPath({ destRoot: dir, relPath: 'trigger-eperm-part.bin', expectedHash: 'x', mtime: 1 })
    ).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('a non-ENOENT error statting the final (with no .part present) propagates instead of returning not-ok', async () => {
    await expect(
      finalizeReceivedPath({ destRoot: dir, relPath: 'trigger-eperm-final.bin', expectedHash: 'x', mtime: 1 })
    ).rejects.toMatchObject({ code: 'EPERM' });
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
