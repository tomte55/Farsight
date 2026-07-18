import { describe, it, expect, vi } from 'vitest';
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

  describe('per-file I/O failure isolation (AV-locked .part etc.)', () => {
    // Real case this fixes: Windows AV locks/quarantines one file's .part
    // (`UNKNOWN: unknown error, open ...setup.exe.part`). Before this feature,
    // that throw propagated out of onBulkFrame and failed the WHOLE receive ->
    // auto-resume -> the same file fails again -> infinite loop. Two files:
    // file 0's openPart rejects EVERY time (persistent failure); file 1 is
    // healthy. Injected `delay` resolves instantly so the bounded retry
    // backoff doesn't slow the test down.
    it('isolates a persistently-failing file: the other file still finalizes, isComplete() becomes true, a terminal onFileDone fires, and no throw escapes onBulkFrame', async () => {
      const size = 8;
      const doneEvents = [];
      let opensFor0 = 0;
      const part1 = sparseFile(size);
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }, { fileId: 1, size }] },
        openPart: (fileId) => {
          if (fileId === 0) { opensFor0 += 1; return Promise.reject(new Error('UNKNOWN: unknown error, open ...setup.exe.part')); }
          return Promise.resolve(part1);
        },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onFileDone: (e) => doneEvents.push(e),
        onProgress: () => {},
        delay: () => Promise.resolve(), // instant — this test isn't about real timing
      });

      // Must NOT throw/reject — the whole point is isolation.
      await expect(router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 8, payload: new Uint8Array(8).fill(1) }))).resolves.toBeUndefined();

      // Bounded retry: 1 initial attempt + 2 backoff retries (default retryDelays: [150, 400]) = 3 total opens.
      expect(opensFor0).toBe(3);
      expect(router.failedFiles()).toEqual(new Set([0]));
      expect(doneEvents).toContainEqual({ fileId: 0, ok: false, terminal: true });
      expect(router.isComplete()).toBe(false); // file 1 still incomplete

      // File 1 completes normally — the failure on file 0 must not have wedged it.
      await router.onBulkFrame(encodeBulkFrame({ fileId: 1, offset: 0, length: 8, payload: new Uint8Array(8).fill(2) }));
      await router.onFileHash(1, 'H1');
      expect(doneEvents).toContainEqual({ fileId: 1, ok: true });

      // The failed file counts as RESOLVED for isComplete() — the whole receive
      // reaches completion despite the one un-writable file.
      expect(router.isComplete()).toBe(true);

      // Further frames for the failed file are ignored (terminal, like `finalized`).
      await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 8, payload: new Uint8Array(8).fill(9) }));
      expect(opensFor0).toBe(3); // no further open attempts
    });

    // The variant that actually leaked a handle (review fix): openPart SUCCEEDS
    // every time (unlike the test above, where it rejects and there's never a
    // handle to leak) but writeAt persistently rejects — e.g. an AV lock that
    // only bites the write, not the open. Before the fix, each opened handle
    // across the retry loop (plus the terminal give-up) was nulled WITHOUT
    // being closed first, leaking up to 3 open fds/handles that (on Windows)
    // keep the exact contended file locked — the opposite of what per-file
    // isolation is for.
    it('closes the opened .part handle before giving up (no leaked handle) when open succeeds but writeAt persistently fails', async () => {
      const size = 4;
      let opens = 0;
      const closeSpies = [];
      let closedCountAtTerminalEvent = null;
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }] },
        openPart: () => {
          opens += 1;
          const closeSpy = vi.fn(() => Promise.resolve());
          closeSpies.push(closeSpy);
          return Promise.resolve({
            writeAt: () => Promise.reject(new Error('EBUSY: resource busy or locked')),
            close: closeSpy,
          });
        },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onFileDone: (e) => {
          // By the time the terminal onFileDone fires, every handle opened so
          // far must ALREADY be closed — assert the count at this moment, not
          // after onBulkFrame resolves, so this actually pins ordering.
          if (e.terminal) closedCountAtTerminalEvent = closeSpies.filter((s) => s.mock.calls.length > 0).length;
        },
        onProgress: () => {},
        delay: () => Promise.resolve(), // instant — this test isn't about real timing
      });

      // Must NOT throw/reject — the whole point is isolation.
      await expect(router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 2, 3, 4]) }))).resolves.toBeUndefined();

      // Bounded retry: 1 initial attempt + 2 backoff retries (default retryDelays: [150, 400]) = 3 total opens.
      expect(opens).toBe(3);
      expect(closeSpies).toHaveLength(3);
      // Every opened handle across the retry loop AND the terminal give-up had
      // close() called exactly once — no leaked handle anywhere in the path.
      for (const spy of closeSpies) expect(spy).toHaveBeenCalledTimes(1);
      // All 3 closes had already happened by the time the terminal event fired.
      expect(closedCountAtTerminalEvent).toBe(3);
      expect(router.failedFiles()).toEqual(new Set([0]));
    });

    it('a transient failure (fails once, then succeeds) recovers via the retry — no terminal failure', async () => {
      const size = 4;
      const part = sparseFile(size);
      const doneEvents = [];
      let opens = 0;
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }] },
        openPart: () => {
          opens += 1;
          if (opens === 1) return Promise.reject(new Error('EBUSY: resource busy or locked'));
          return Promise.resolve(part);
        },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onFileDone: (e) => doneEvents.push(e),
        onProgress: () => {},
        delay: () => Promise.resolve(),
      });

      await router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 2, 3, 4]) }));
      expect(opens).toBe(2); // first attempt failed, first retry succeeded
      expect(router.failedFiles()).toEqual(new Set()); // recovered — not failed
      expect([...part.buf]).toEqual([1, 2, 3, 4]); // the bytes actually landed

      await router.onFileHash(0, 'H');
      expect(router.isComplete()).toBe(true);
      expect(doneEvents).toEqual([{ fileId: 0, ok: true }]); // only the success — no terminal event
    });

    // Mutation check (guards the isolation itself, not just the outcome): if the
    // try/catch around the write were reverted to let the error rethrow, this
    // must fail — proving the test actually pins the isolation, not merely a
    // condition that happens to hold anyway.
    it('mutation check: without the try/catch isolation, a persistent failure would reject onBulkFrame (this documents WHY the isolation matters)', async () => {
      const size = 4;
      const boom = () => Promise.reject(new Error('boom'));
      // A minimal reproduction of the OLD (pre-fix) code path: no retry/catch at all.
      async function oldOnBulkFrame(openPart) {
        const f = { part: null, partPromise: null };
        if (!f.partPromise) f.partPromise = openPart();
        f.part = await f.partPromise; // this throws, uncaught
      }
      await expect(oldOnBulkFrame(boom)).rejects.toThrow('boom');

      // The FIXED router, given the exact same persistently-failing openPart,
      // must resolve (not reject) — this is the behavior change the feature relies on.
      const router = createReceiveRouter({
        manifest: { entries: [{ fileId: 0, size }] },
        openPart: boom,
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onFileDone: () => {},
        onProgress: () => {},
        delay: () => Promise.resolve(),
      });
      await expect(router.onBulkFrame(encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array(4) }))).resolves.toBeUndefined();
      expect(router.isComplete()).toBe(true); // failed file counts as resolved
    });
  });
});
