// packages/shared/test/transfer-multiflow-receiver.test.js
import { describe, it, expect, vi } from 'vitest';
import { createMultiFlowReceiver } from '../src/transfer-orchestrator.js';
import { encodeBulkFrame } from '../src/transfer-chunk.js';
import { offerFrame, fileEndFrame, jobDoneFrame, parseCtrlFrame } from '../src/transfer-protocol.js';
import { createCoverageTracker } from '../src/transfer-reconcile.js';

const JOB = 'a'.repeat(32);

function ctrlPair() {
  let recvCb = null; const toReceiver = (s) => recvCb && recvCb(s);
  const out = [];
  const ctrl = { sendCtrl: (s) => out.push(parseCtrlFrame(s)), onCtrl: (cb) => { recvCb = cb; } };
  return { ctrl, toReceiver, out };
}

// A controllable fake timer: setTimer/clearTimer inject like real timers, but
// `tickOnce()` fires every CURRENTLY-scheduled callback exactly once (deleting
// its id first, so a re-arming tick's new id is untouched until the next call).
function fakeClock() {
  let seq = 1; const timers = new Map();
  const setTimer = (fn, ms) => { const id = seq++; timers.set(id, fn); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  const tickOnce = () => { const cur = [...timers.entries()]; for (const [id, fn] of cur) { timers.delete(id); fn(); } };
  return { setTimer, clearTimer, tickOnce, pending: () => timers.size };
}

describe('createMultiFlowReceiver', () => {
  it('accepts, reassembles out-of-order across flows, verifies, completes', async () => {
    const size = 12;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [0, 1, 2].map(() => ({ onBulk: (cb) => flowCbs.push(cb) }));
    const rx = createMultiFlowReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'x.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);
    // deliver bytes OUT OF ORDER across the three flows
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 8, length: 4, payload: new Uint8Array([9, 9, 9, 9]) }));
    flowCbs[1](encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 1, 1, 1]) }));
    flowCbs[2](encodeBulkFrame({ fileId: 0, offset: 4, length: 4, payload: new Uint8Array([5, 5, 5, 5]) }));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect([...parts.get('x.bin')]).toEqual([1, 1, 1, 1, 5, 5, 5, 5, 9, 9, 9, 9]);
    expect(out.some((f) => f.t === 'complete' && f.ok === true)).toBe(true);
  });

  it('threads the memoized partFile handle into verifyAndFinalize (router closes it first, but it must still be passed)', async () => {
    const size = 4;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const openedParts = [];
    const verifyAndFinalizeArgs = [];
    const rx = createMultiFlowReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => {
        const part = { relPath, closed: false, writeAt: () => Promise.resolve(), close: () => { part.closed = true; return Promise.resolve(); }, liveDigest: () => null };
        openedParts.push(part);
        return Promise.resolve(part);
      },
      verifyAndFinalize: (args) => { verifyAndFinalizeArgs.push(args); return Promise.resolve({ ok: true }); },
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'z.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(1) }));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    await done;
    expect(verifyAndFinalizeArgs.length).toBe(1);
    // The router closes the part before calling verifyAndFinalize — but the
    // memoized handle must still be the one that was actually opened+written to.
    expect(verifyAndFinalizeArgs[0].partFile).toBe(openedParts[0]);
    expect(verifyAndFinalizeArgs[0].partFile).not.toBeUndefined();
    expect(openedParts[0].closed).toBe(true);
  });

  it('declines when consent says no', async () => {
    const { ctrl, toReceiver, out } = ctrlPair();
    const rx = createMultiFlowReceiver({ ctrl, flows: [], jobId: JOB, consent: async () => false, openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve() }), verifyAndFinalize: () => Promise.resolve({ ok: true }) });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'x', size: 1, mtime: 0 }], totalBytes: 1, totalFiles: 1 }));
    const r = await done;
    expect(r.ok).toBe(false);
    expect(out.some((f) => f.t === 'reject')).toBe(true);
  });

  it('periodic range_report ticks on the injected timer, re-arms, persists only on tick, and tears the timer down at completion', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const persistRanges = vi.fn();
    const fake = fakeClock();
    const rx = createMultiFlowReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      persistRanges,
      reportIntervalMs: 5000, // irrelevant — the fake clock only advances via tickOnce()
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'y.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush

    const countReports = () => out.filter((f) => f.t === 'range_report').length;

    // accept() sends its own immediate range_report and arms the periodic reporter.
    expect(out.some((f) => f.t === 'accept')).toBe(true);
    const afterAccept = countReports();
    expect(afterAccept).toBeGreaterThan(0);
    expect(persistRanges).not.toHaveBeenCalled();
    expect(fake.pending()).toBe(1); // startReporter() armed exactly one timer

    // Property 1 + 2: the tick fires a NEW range_report, calls persistRanges, and re-arms.
    fake.tickOnce();
    expect(countReports()).toBe(afterAccept + 1);
    expect(persistRanges).toHaveBeenCalledTimes(1);
    expect(fake.pending()).toBe(1); // re-armed with a fresh timer id, not left dangling

    const beforeCompletion = countReports();
    const persistCallsBeforeCompletion = persistRanges.mock.calls.length;

    // Deliver the file's bytes, then FILE_END + JOB_DONE to drive completion.
    // The last file's hash lands inside FILE_END's `router.onFileHash`, which
    // finalizes+resolves synchronously (single file, ranges already complete) —
    // so the ctrl handler's own trailing `sendReport()` call is already past
    // `settled` and no-ops. Either way, completion must NOT go through the
    // periodic tick, so persistRanges must NOT be invoked again here.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(7) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });

    expect(countReports()).toBe(beforeCompletion);
    expect(persistRanges).toHaveBeenCalledTimes(persistCallsBeforeCompletion);

    // Property 3: completion tears down the reporter — no dangling timer.
    expect(fake.pending()).toBe(0);

    // Property 4: no further reporter activity once resolved.
    const reportsAtEnd = countReports();
    const persistCallsAtEnd = persistRanges.mock.calls.length;
    fake.tickOnce();
    expect(countReports()).toBe(reportsAtEnd);
    expect(persistRanges).toHaveBeenCalledTimes(persistCallsAtEnd);
  });

  it('reports a finalized file as fully covered even though the router itself omits it (fixes the paired sender\'s livelock)', async () => {
    // router.rangesFor() drops a file entirely once it finalizes — if a
    // range_report just forwarded that straight to the wire, the paired
    // createMultiFlowSender's coverage tracker would freeze at whatever
    // partial coverage the file had before finalizing and never see it as
    // complete. Two files: finalize the first while the second is still
    // in flight, and check the very next range_report reports file 0 as
    // fully covered `[[0, size0]]` rather than omitting it.
    const size0 = 8, size1 = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const rx = createMultiFlowReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(relPath === 'a.bin' ? size0 : size1); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    toReceiver(offerFrame({
      jobId: JOB,
      entries: [{ fileId: 0, path: 'a.bin', size: size0, mtime: 0 }, { fileId: 1, path: 'b.bin', size: size1, mtime: 0 }],
      totalBytes: size0 + size1, totalFiles: 2,
    }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    // Deliver + finalize file 0 only; file 1 stays untouched.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size0, payload: new Uint8Array(size0).fill(1) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    await new Promise((r) => setTimeout(r, 0));

    // The receive isn't done yet (file 1 pending) — assert on the LATEST
    // range_report emitted so far, which was sent right after file 0's
    // file_end drove it to finalize.
    const reports = out.filter((f) => f.t === 'range_report');
    expect(reports.length).toBeGreaterThan(0);
    const latest = reports[reports.length - 1];
    const file0Entry = latest.files.find((f) => f.fileId === 0);
    expect(file0Entry).toEqual({ fileId: 0, ivals: [[0, size0]] });

    // Finish the transfer so the promise settles cleanly.
    flowCbs[0](encodeBulkFrame({ fileId: 1, offset: 0, length: size1, payload: new Uint8Array(size1).fill(2) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 1, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
  });

  // Plan 3, Task 1: a range_report must never exceed the ~256KB data-channel
  // message limit. sendReport() now calls batchReportFiles() and emits one
  // range_report frame PER BATCH instead of one unbounded frame. Drives the
  // same 5-file scenario (2 finalized, 1 partially-covered, 2 untouched)
  // through a BOUNDED receiver (maxFilesPerFrame: 2 -> 3 frames per cycle)
  // and an UNBOUNDED one (default maxFilesPerFrame, which comfortably fits
  // all 5 files in a single frame), then checks that applying every batched
  // frame's files to a fresh createCoverageTracker yields IDENTICAL coverage
  // to applying the single unbatched frame's files (round-trip equivalence:
  // splitting the file set across frames must not lose or corrupt coverage).
  it('bounds one report cycle to maxFilesPerFrame files per range_report frame, with no loss of coverage across the batches', async () => {
    const N = 5;
    const size = 4;
    const manifest = {
      entries: Array.from({ length: N }, (_, i) => ({ fileId: i, path: `f${i}.bin`, size, mtime: 0 })),
      totalBytes: N * size,
      totalFiles: N,
    };

    // Drives one identical scenario through a fresh receiver, returns every
    // range_report frame emitted by the ONE sendReport() call triggered by a
    // single fake-clock tick (isolated from the accept-time report).
    async function driveOneReportCycle({ maxFilesPerFrame } = {}) {
      const { ctrl, toReceiver, out } = ctrlPair();
      const parts = new Map();
      const flowCbs = [];
      const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
      const fake = fakeClock();
      const rx = createMultiFlowReceiver({
        ctrl, flows, jobId: JOB,
        consent: async () => true,
        openPart: (relPath) => {
          const b = new Uint8Array(size);
          parts.set(relPath, b);
          return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null });
        },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        reportIntervalMs: 5000, // irrelevant — the fake clock only advances via tickOnce()
        setTimer: fake.setTimer, clearTimer: fake.clearTimer,
        ...(maxFilesPerFrame !== undefined ? { maxFilesPerFrame } : {}),
      });
      rx.start().catch(() => {}); // never completes in this scenario (files 2-4 stay pending) — don't let a rejection go unhandled
      toReceiver(offerFrame({ jobId: JOB, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
      await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
      expect(out.some((f) => f.t === 'accept')).toBe(true);

      // file 0: fully received + finalized (file_end lands a hash).
      flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(1) }));
      await new Promise((r) => setTimeout(r, 0));
      toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
      // file 1: same — fully received + finalized.
      flowCbs[0](encodeBulkFrame({ fileId: 1, offset: 0, length: size, payload: new Uint8Array(size).fill(2) }));
      await new Promise((r) => setTimeout(r, 0));
      toReceiver(fileEndFrame({ jobId: JOB, fileId: 1, hash: 'H' }));
      // file 2: partially received, never finalized (no file_end).
      flowCbs[0](encodeBulkFrame({ fileId: 2, offset: 0, length: 2, payload: new Uint8Array(2).fill(3) }));
      await new Promise((r) => setTimeout(r, 0));
      // files 3, 4: untouched — no bytes at all.

      const before = out.filter((f) => f.t === 'range_report').length;
      fake.tickOnce(); // fires the ONE periodic sendReport() call for this cycle
      const cycleFrames = out.filter((f) => f.t === 'range_report').slice(before);
      return cycleFrames;
    }

    const boundedFrames = await driveOneReportCycle({ maxFilesPerFrame: 2 });
    const unboundedFrames = await driveOneReportCycle(); // default maxFilesPerFrame (64) — 5 files fit in one frame

    // Pagination actually happened: 5 files / 2 per frame -> 3 frames, each capped.
    expect(boundedFrames.length).toBe(3);
    for (const f of boundedFrames) expect(f.files.length).toBeLessThanOrEqual(2);
    // The unbounded run comfortably fits all 5 files in a single frame.
    expect(unboundedFrames.length).toBe(1);
    expect(unboundedFrames[0].files.length).toBe(5);

    // Round-trip equivalence: applying every batched frame's files to a fresh
    // tracker must yield IDENTICAL per-file coverage to applying the single
    // unbatched frame's files — splitting the file set must not lose/corrupt
    // any file's reported ivals.
    const boundedTracker = createCoverageTracker({ manifest });
    for (const frame of boundedFrames) boundedTracker.applyReport(frame.files);
    const unboundedTracker = createCoverageTracker({ manifest });
    for (const frame of unboundedFrames) unboundedTracker.applyReport(frame.files);

    for (let fileId = 0; fileId < N; fileId += 1) {
      expect(boundedTracker.coveredFor(fileId).toJSON()).toEqual(unboundedTracker.coveredFor(fileId).toJSON());
    }
    // Sanity: the merged coverage actually reflects the scenario (not two
    // trackers that both happen to be empty).
    expect(unboundedTracker.coveredFor(0).toJSON()).toEqual([[0, size]]); // finalized
    expect(unboundedTracker.coveredFor(1).toJSON()).toEqual([[0, size]]); // finalized
    expect(unboundedTracker.coveredFor(2).toJSON()).toEqual([[0, 2]]);    // partial, live
    expect(unboundedTracker.coveredFor(3).toJSON()).toEqual([]);          // untouched
    expect(unboundedTracker.coveredFor(4).toJSON()).toEqual([]);          // untouched
  });
});
