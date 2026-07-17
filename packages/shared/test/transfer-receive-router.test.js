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
});
