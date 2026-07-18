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

  describe('resetFile (verify-failure recovery)', () => {
    it('clears a file so it re-receives and is no longer reported complete', async () => {
      const size = 8;
      let opens = 0;
      const bufs = [];
      const mkPart = () => { const b = new Uint8Array(size); bufs.push(b); return { writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve() }; };
      let failNext = true;
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }] },
        openPart: () => { opens += 1; return Promise.resolve(mkPart()); },
        verifyAndFinalize: () => { const ok = !failNext; failNext = false; return Promise.resolve({ ok }); },
        onFileDone: () => {}, onProgress: () => {},
      });
      // First full delivery + hash → verify FAILS.
      await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 8, payload: new Uint8Array(8).fill(1) }));
      await router.onFileHash(0, 'H');
      expect(router.isComplete()).toBe(false);          // verify failed → not complete
      // Recover: reset, then re-deliver → verify SUCCEEDS.
      await router.resetFile(0);
      expect(router.rangesFor()).toEqual([{ fileId: 0, ivals: [] }]); // full gap again
      await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 8, payload: new Uint8Array(8).fill(2) }));
      await router.onFileHash(0, 'H');
      expect(router.isComplete()).toBe(true);
      expect(opens).toBe(2);                            // reopened after reset
    });
  });

  describe('closeAll (fd-leak fix)', () => {
    it('closes an open, non-finalized part handle and is idempotent', async () => {
      const size = 12;
      let closeCalls = 0;
      const part = {
        writeAt: () => Promise.resolve(),
        close: () => { closeCalls += 1; return Promise.resolve(); },
      };
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }] },
        openPart: () => Promise.resolve(part),
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onFileDone: () => {},
        onProgress: () => {},
      });
      // Mid-flight: a partial (not last-byte) bulk frame opens the part but never
      // finalizes it — this is exactly the state a canceled/stalled receive is
      // left in, and the fd leak this whole fix is about.
      await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 1, 1, 1]) }));
      expect(closeCalls).toBe(0); // still open — not complete, nothing finalized it
      await router.closeAll();
      expect(closeCalls).toBe(1);
      // Idempotent: a second call must not re-close an already-released handle.
      await router.closeAll();
      expect(closeCalls).toBe(1);
    });

    it('no-ops on an already-finalized file (its part was closed by finalize, not closeAll)', async () => {
      const size = 4;
      let closeCalls = 0;
      const part = {
        writeAt: () => Promise.resolve(),
        close: () => { closeCalls += 1; return Promise.resolve(); },
      };
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }] },
        openPart: () => Promise.resolve(part),
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onFileDone: () => {}, onProgress: () => {},
      });
      await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 1, 1, 1]) }));
      await router.onFileHash(0, 'HASH'); // completes -> finalizes -> closes part itself
      expect(closeCalls).toBe(1);
      expect(router.isComplete()).toBe(true);
      await router.closeAll(); // must not touch the already-finalized file's part again
      expect(closeCalls).toBe(1);
    });
  });
});
