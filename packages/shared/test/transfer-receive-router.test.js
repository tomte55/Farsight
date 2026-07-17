import { describe, it, expect } from 'vitest';
import { createReceiveRouter } from '../src/transfer-receive-router.js';
import { encodeBulkFrame } from '../src/transfer-chunk.js';

function sparseFile(size) {
  const buf = new Uint8Array(size);
  return { buf, writeAt: (off, bytes) => { buf.set(bytes, off); return Promise.resolve(); }, close: () => Promise.resolve() };
}

describe('transfer-receive-router', () => {
  it('reassembles out-of-order chunks by offset and finalizes on completion', async () => {
    const size = 12;
    const part = sparseFile(size);
    const done = [];
    const router = createReceiveRouter({
      manifest: { entries: [{ fileId: 0, size }] },
      openPart: () => Promise.resolve(part),
      verifyAndFinalize: ({ fileId }) => { done.push(fileId); return Promise.resolve({ ok: true }); },
      onFileDone: () => {},
      onProgress: () => {},
    });
    // Deliver chunks OUT OF ORDER across "flows".
    await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 8, length: 4, payload: new Uint8Array([9, 9, 9, 9]) }));
    await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 1, 1, 1]) }));
    expect(router.isComplete()).toBe(false);           // gap [4,8) still missing
    await router.onFileHash(0, 'HASH');                  // hash arrives before last chunk
    await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 4, length: 4, payload: new Uint8Array([5, 5, 5, 5]) }));
    expect([...part.buf]).toEqual([1,1,1,1,5,5,5,5,9,9,9,9]); // byte-identical
    expect(done).toEqual([0]);                            // finalized once complete+hash
    expect(router.isComplete()).toBe(true);
  });

  it('reports current coverage for range_report', async () => {
    const router = createReceiveRouter({
      manifest: { entries: [{ fileId: 2, size: 100 }] },
      openPart: () => Promise.resolve(sparseFile(100)),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onFileDone: () => {}, onProgress: () => {},
    });
    await router.onBulkFrame(encodeBulkFrame({ fileId: 2, offset: 0, length: 10, payload: new Uint8Array(10) }));
    expect(router.rangesFor()).toEqual([{ fileId: 2, ivals: [[0, 10]] }]);
  });

  it('does NOT mark a file complete/finalized when verifyAndFinalize reports ok:false', async () => {
    const size = 8;
    const part = sparseFile(size);
    const doneEvents = [];
    const router = createReceiveRouter({
      manifest: { entries: [{ fileId: 5, size }] },
      openPart: () => Promise.resolve(part),
      verifyAndFinalize: () => Promise.resolve({ ok: false }),
      onFileDone: (e) => doneEvents.push(e),
      onProgress: () => {},
    });
    await router.onBulkFrame(encodeBulkFrame({ fileId: 5, offset: 0, length: 8, payload: new Uint8Array(8).fill(3) }));
    await router.onFileHash(5, 'BADHASH');
    expect(router.isComplete()).toBe(false);
    expect(doneEvents).toEqual([{ fileId: 5, ok: false }]);
  });

  it('does not wedge the file when verifyAndFinalize throws — a later retry can re-run finalize', async () => {
    const size = 4;
    const part = sparseFile(size);
    let calls = 0;
    const router = createReceiveRouter({
      manifest: { entries: [{ fileId: 7, size }] },
      openPart: () => Promise.resolve(part),
      verifyAndFinalize: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({ ok: true });
      },
      onFileDone: () => {},
      onProgress: () => {},
    });
    await router.onBulkFrame(encodeBulkFrame({ fileId: 7, offset: 0, length: 4, payload: new Uint8Array([1, 2, 3, 4]) }));
    await expect(router.onFileHash(7, 'HASH')).rejects.toThrow('boom');
    expect(router.isComplete()).toBe(false); // not wedged as finalized

    // A later retry (e.g. re-delivering the hash, modeling a Plan-2 re-fetch) can re-run finalize.
    await router.onFileHash(7, 'HASH');
    expect(router.isComplete()).toBe(true);
  });
});
