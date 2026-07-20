// packages/shared/test/transfer-multiflow-receiver.test.js
import { describe, it, expect, vi } from 'vitest';
import { createReceiver } from '../src/transfer-receiver.js';
import { encodeBulkFrame } from '../src/transfer-chunk.js';
import { offerFrame, offerBeginFrame, offerEntriesFrame, offerEndFrame, fileEndFrame, jobDoneFrame, cancelFrame, promptingFrame, parseCtrlFrame, fileHashesBeginFrame, fileHashesEntriesFrame, fileHashesEndFrame } from '../src/transfer-protocol.js';
import { createCoverageTracker } from '../src/transfer-reconcile.js';
import { createHash } from 'node:crypto';
const HH = (b) => createHash('sha256').update(b).digest('hex');

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

describe('createReceiver', () => {
  it('accepts, reassembles out-of-order across flows, verifies, completes', async () => {
    const size = 12;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [0, 1, 2].map(() => ({ onBulk: (cb) => flowCbs.push(cb) }));
    const rx = createReceiver({
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
    const rx = createReceiver({
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

  // UI-event-wiring gap: the receiver drove real bytes onto disk but never told
  // the app UI the transfer had moved off "Waiting for approval" (no 'accepted')
  // nor that any bytes had arrived (no aggregate 'progress') — a WORKING
  // transfer looked frozen. Mirrors the removed single-flow receiver driver's
  // onEvent({type: 'accepted', manifest: m}), emitted right after consent, before the accept
  // frame goes out.
  it('emits an accepted event carrying the manifest right after consent (mirrors single-flow)', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flows = [{ onBulk: () => {} }];
    const events = [];
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve(), liveDigest: () => null }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000,
    });
    rx.start().catch(() => {});
    const entries = [{ fileId: 0, path: 'm.bin', size, mtime: 0 }];
    toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush

    expect(out.some((f) => f.t === 'accept')).toBe(true);
    const accepted = events.find((e) => e.type === 'accepted');
    expect(accepted).toBeTruthy();
    expect(accepted.manifest).toBeTruthy();
    expect(accepted.manifest.entries.map((e) => e.fileId)).toEqual([0]);
  });

  // Aggregate progress shape + movement: NOT the per-file {fileId,coveredBytes,
  // size} the router's own onProgress used to pass straight through (wrong
  // shape for the UI, which wants ONE number for the whole job).
  it('emits throttled aggregate progress with shape {received,total,fraction,filesDone,filesTotal} as bytes arrive', async () => {
    const size = 4000;
    const { ctrl, toReceiver } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    let clock = 0;
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => { const b = new Uint8Array(size); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000,
      progressIntervalMs: 100, now: () => clock,
    });
    const done = rx.start();
    const entries = [{ fileId: 0, path: 'p.bin', size, mtime: 0 }];
    toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush

    // Four 1000-byte chunks, each a throttle-interval apart on the injected clock.
    for (let i = 0; i < 4; i += 1) {
      clock += 100;
      flowCbs[0](encodeBulkFrame({ fileId: 0, offset: i * 1000, length: 1000, payload: new Uint8Array(1000).fill(i + 1) }));
      await new Promise((r) => setTimeout(r, 0));
    }
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBeGreaterThan(1); // movement, not one snapshot
    for (const e of progressEvents) {
      expect(Object.keys(e.progress).sort()).toEqual(['filesDone', 'filesTotal', 'fraction', 'received', 'total'].sort());
      expect(e.progress.total).toBe(size);
      expect(e.progress.filesTotal).toBe(1);
    }
    const receivedVals = progressEvents.map((e) => e.progress.received);
    expect(receivedVals).toEqual([...receivedVals].sort((a, b) => a - b)); // monotonic

    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
  });

  it('throttles aggregate progress emission via progressIntervalMs (a chunk-per-frame flood would otherwise reach IPC)', async () => {
    const size = 16;
    const { ctrl, toReceiver } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => { const b = new Uint8Array(size); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000,
      progressIntervalMs: 100_000, now: () => 0, // a clock that never advances past the interval
    });
    const done = rx.start();
    const entries = [{ fileId: 0, path: 'q.bin', size, mtime: 0 }];
    toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush

    for (let i = 0; i < 4; i += 1) {
      flowCbs[0](encodeBulkFrame({ fileId: 0, offset: i * 4, length: 4, payload: new Uint8Array(4).fill(i + 1) }));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(events.filter((e) => e.type === 'progress').length).toBeLessThanOrEqual(1);

    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
  });

  // Phase 4: the receiver reassembles file_hashes begin/entries/end and forwards
  // them to the router's verify-before-add. A chunk whose bytes DON'T match the
  // manifest hash must be left a gap (reported uncovered), not accepted as covered.
  it('reassembles file_hashes and verifies chunks: a mismatching chunk is reported as a gap', async () => {
    const size = 4;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const fake = fakeClock();
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => { const b = new Uint8Array(size); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, readAt: (o, l) => Promise.resolve(b.subarray(o, o + l)), close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 5000, inactivityMs: 0,
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    rx.start().catch(() => {}); // never completes (the only chunk fails verification) — don't leak a rejection
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'v.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    // Announce a chunk hash that will NOT match the bytes we then deliver.
    const wrong = HH(new Uint8Array([0, 0, 0, 0]));
    toReceiver(fileHashesBeginFrame({ jobId: JOB, fileId: 0, chunkBytes: 4, totalChunks: 1 }));
    toReceiver(fileHashesEntriesFrame({ jobId: JOB, fileId: 0, from: 0, hashes: [wrong] }));
    toReceiver(fileHashesEndFrame({ jobId: JOB, fileId: 0 }));
    await new Promise((r) => setTimeout(r, 0));
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array([1, 2, 3, 4]) }));
    await new Promise((r) => setTimeout(r, 0));

    fake.tickOnce(); // force a range_report
    const reports = out.filter((f) => f.t === 'range_report');
    const latest = reports[reports.length - 1];
    expect(latest.files.find((f) => f.fileId === 0)).toEqual({ fileId: 0, ivals: [] }); // NOT covered — verification failed
  });

  // Phase 4: a whole-file verify mismatch where the chunks all verify (so locate
  // finds nothing to punch) must escalate to a bounded TERMINAL failure
  // (completed_with_errors), never an infinite locate/re-drive loop.
  it('finalize mismatch that locate cannot repair goes terminal (completed_with_errors), not a loop', async () => {
    const size = 4;
    const { ctrl, toReceiver } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bufs = new Map(); // memoize per path so a reopen (locate) sees written bytes, like the real .part
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { if (!bufs.has(relPath)) bufs.set(relPath, new Uint8Array(size)); const b = bufs.get(relPath); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, readAt: (o, l) => Promise.resolve(b.subarray(o, o + l)), close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: false }), // whole-file always fails
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000, locateMaxAttempts: 1,
    });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 't.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileHashesBeginFrame({ jobId: JOB, fileId: 0, chunkBytes: 4, totalChunks: 1 }));
    toReceiver(fileHashesEntriesFrame({ jobId: JOB, fileId: 0, from: 0, hashes: [HH(payload)] })); // CORRECT chunk hash
    toReceiver(fileHashesEndFrame({ jobId: JOB, fileId: 0 }));
    await new Promise((r) => setTimeout(r, 0));
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done; // must RESOLVE (completed_with_errors), not hang/loop
    expect(r).toEqual({ jobId: JOB, ok: false });
    expect(events.some((e) => e.type === 'completed' && e.ok === false)).toBe(true);
  });

  it('declines when consent says no', async () => {
    const { ctrl, toReceiver, out } = ctrlPair();
    const rx = createReceiver({ ctrl, flows: [], jobId: JOB, consent: async () => false, openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve() }), verifyAndFinalize: () => Promise.resolve({ ok: true }) });
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
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      persistRanges,
      reportIntervalMs: 5000, // irrelevant — the fake clock only advances via tickOnce()
      // This test is about the REPORTER's cadence specifically; the watchdog now
      // shares the same injected clock (see the inactivity-watchdog tests below),
      // and this fake clock's tickOnce() can't model "some ms elapsed" for one
      // timer but not another — disable the watchdog here so `fake.pending()`
      // reflects only the reporter timer, as this test's assertions expect.
      inactivityMs: 0,
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'y.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush

    const countReports = () => out.filter((f) => f.t === 'range_report').length;

    // accept() sends its own immediate range_report, persists the record ONCE
    // right away (independent of the periodic tick — see the new dedicated test
    // below for the fast-cancel scenario this exists for), and arms the periodic
    // reporter.
    expect(out.some((f) => f.t === 'accept')).toBe(true);
    const afterAccept = countReports();
    expect(afterAccept).toBeGreaterThan(0);
    expect(persistRanges).toHaveBeenCalledTimes(1);
    expect(fake.pending()).toBe(1); // startReporter() armed exactly one timer

    // Property 1 + 2: the tick fires a NEW range_report, calls persistRanges AGAIN
    // (on top of the immediate accept-time call), and re-arms.
    fake.tickOnce();
    expect(countReports()).toBe(afterAccept + 1);
    expect(persistRanges).toHaveBeenCalledTimes(2);
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

  // The gap this closes: persistRanges was previously only ever called from the
  // periodic tick() (~reportIntervalMs later, default 3s). A multi-flow receive
  // canceled/interrupted within that window left NO jobs-store record at all —
  // it vanished from the Transfers list and could never be resumed. Mirrors
  // the removed single-flow receiver driver's immediate saveRecord('active') on accept. Uses
  // a huge reportIntervalMs (never fired via tickOnce here) so the ONLY way
  // persistRanges could have been called is the new immediate accept-path call.
  it('persists the record ONCE immediately on accept, independent of the periodic tick (no vanish on fast cancel)', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const persistRanges = vi.fn();
    const fake = fakeClock();
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve(), liveDigest: () => null }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      persistRanges,
      reportIntervalMs: 999_999_999, // large enough that tickOnce() below cannot be the source
      inactivityMs: 0, // keep the watchdog out of the way — irrelevant to this test
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    rx.start().catch(() => {});
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'q.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    // Called at least once, from the accept path — NOT the tick, which hasn't fired.
    expect(persistRanges).toHaveBeenCalledTimes(1);
    // Shape: one entry per manifest file, with its initial per-file coverage.
    expect(persistRanges.mock.calls[0][0]).toEqual([{ fileId: 0, ivals: [] }]);
  });

  it('reports a finalized file as fully covered even though the router itself omits it (fixes the paired sender\'s livelock)', async () => {
    // router.rangesFor() drops a file entirely once it finalizes — if a
    // range_report just forwarded that straight to the wire, the paired
    // createSender's coverage tracker would freeze at whatever
    // partial coverage the file had before finalizing and never see it as
    // complete. Two files: finalize the first while the second is still
    // in flight, and check the very next range_report reports file 0 as
    // fully covered `[[0, size0]]` rather than omitting it.
    const size0 = 8, size1 = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const rx = createReceiver({
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
  // message limit. sendReport() now calls batchReportFiles() (byte-bounded —
  // it measures actual serialized bytes, not file/interval counts) and emits
  // one range_report frame PER BATCH instead of one unbounded frame. Drives the
  // same 5-file scenario (2 finalized, 1 partially-covered, 2 untouched)
  // through a BOUNDED receiver (reportMaxBytes: 65 -> 3 frames per cycle, at
  // most 2 files each) and an UNBOUNDED one (default reportMaxBytes, which
  // comfortably fits all 5 files in a single frame), then checks that applying
  // every batched frame's files to a fresh createCoverageTracker yields
  // IDENTICAL coverage to applying the single unbatched frame's files
  // (round-trip equivalence: splitting the file set across frames must not
  // lose or corrupt coverage).
  it('bounds one report cycle to a byte budget per range_report frame, with no loss of coverage across the batches', async () => {
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
    async function driveOneReportCycle({ reportMaxBytes } = {}) {
      const { ctrl, toReceiver, out } = ctrlPair();
      const parts = new Map();
      const flowCbs = [];
      const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
      const fake = fakeClock();
      const rx = createReceiver({
        ctrl, flows, jobId: JOB,
        consent: async () => true,
        openPart: (relPath) => {
          const b = new Uint8Array(size);
          parts.set(relPath, b);
          return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null });
        },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        reportIntervalMs: 5000, // irrelevant — the fake clock only advances via tickOnce()
        // Same reasoning as the periodic-tick test above: this fake clock's
        // tickOnce() fires every currently-pending timer unconditionally, so a
        // default-armed watchdog sharing the same clock would fire (and fail
        // the receive) on the very first tickOnce() call below, which this
        // test isn't about — disable it here too.
        inactivityMs: 0,
        setTimer: fake.setTimer, clearTimer: fake.clearTimer,
        ...(reportMaxBytes !== undefined ? { reportMaxBytes } : {}),
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

    const boundedFrames = await driveOneReportCycle({ reportMaxBytes: 65 });
    const unboundedFrames = await driveOneReportCycle(); // default reportMaxBytes (200000) — 5 files fit in one frame

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

  // Unlike the removed single-flow receiver driver — whose ctrl handler had no
  // `cancel` branch at all (a single-flow receive instead recovers from a vanished
  // sender via its own inactivity watchdog, once the sender's channel
  // teardown stops bytes arriving) — the multi-flow receiver adds EXPLICIT
  // inbound-cancel handling: a sender-initiated cancel must settle the
  // receive as canceled, surface the event, and leave no dangling timer
  // (reporter or watchdog) behind.
  it('handles an inbound cancel after accept: settles canceled, emits {type:"canceled"}, and clears all timers', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    const fake = fakeClock();
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 5000,
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    const done = rx.start().catch((e) => e.message);
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'c.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);
    expect(fake.pending()).toBeGreaterThan(0); // reporter + watchdog armed at accept

    toReceiver(cancelFrame(JOB));
    const result = await done;
    expect(result).toBe('canceled');
    expect(events.some((e) => e.type === 'canceled')).toBe(true);
    expect(fake.pending()).toBe(0); // every timer (reporter + watchdog) cleared, none dangling
  });

  // Mirrors the removed single-flow receiver driver's inactivity watchdog: a
  // consented, active receive that stops getting ANY ctrl/bulk traffic (sender vanished, connection
  // dropped) must not hang at 'active' forever.
  it('fails the receive on inactivity: no ctrl/bulk frame within inactivityMs after accept stalls it', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    const fake = fakeClock();
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 5000,
      inactivityMs: 1000,
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    const done = rx.start().catch((e) => e.message);
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 's.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    fake.tickOnce(); // fires every currently-pending timer: the reporter's tick (harmless) + the watchdog (no frames arrived since accept -> stall)
    const result = await done;
    expect(result).toBe('stalled');
    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    expect(fake.pending()).toBe(0); // the fail() path tears down both timers
  });

  // Watchdog RESET needs genuine elapsed-time semantics (a frame just short of
  // the deadline must push the deadline out) which the file's tickOnce()-style
  // fakeClock can't model (it fires every pending timer unconditionally,
  // irrespective of configured ms) — so this one test uses vitest's real fake
  // timers instead, which respect actual relative ms between two independently-
  // configured timers (the reporter and the watchdog).
  it('watchdog reset: a frame delivered just before the deadline delays the stall past it', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    vi.useFakeTimers();
    try {
      const rx = createReceiver({
        ctrl, flows, jobId: JOB,
        consent: async () => true,
        openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onEvent: (ev) => events.push(ev),
        reportIntervalMs: 1_000_000, // keep the reporter out of the way of this timing test
        inactivityMs: 1000,
      });
      const done = rx.start().catch((e) => e.message);
      toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'w.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
      await vi.advanceTimersByTimeAsync(0); // let consent+accept flush
      expect(out.some((f) => f.t === 'accept')).toBe(true);

      await vi.advanceTimersByTimeAsync(800); // 800ms since accept — inside the 1000ms window
      // Poke: bulk bytes arrive on a flow, just before the original deadline would elapse.
      flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(3) }));
      await vi.advanceTimersByTimeAsync(0); // let the bulk handler's pokeWatchdog() run

      await vi.advanceTimersByTimeAsync(800); // 1600ms since accept, but only 800ms since the poke
      expect(events.some((e) => e.type === 'interrupted')).toBe(false); // reset held — no stall yet

      await vi.advanceTimersByTimeAsync(300); // now ~1100ms since the poke — past inactivityMs
      const result = await done;
      expect(result).toBe('stalled');
      expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The watchdog must reset on EVERY inbound ctrl frame too, not just bulk
  // frames — pokeWatchdog() is called at the very top of the ctrl handler,
  // before the frame is even parsed for jobId/type. Uses a `prompting` frame
  // as the poke: it's a valid, parseable ctrl frame for this jobId that the
  // multi-flow receiver's ctrl handler has NO case for (unlike the removed
  // single-flow receiver driver, it never surfaces a 'prompting' event), so besides the
  // watchdog reset it has no side effect at all — nothing here completes or
  // cancels the transfer, isolating exactly the ctrl-side reset behavior.
  it('watchdog reset: a ctrl frame delivered just before the deadline delays the stall past it', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    vi.useFakeTimers();
    try {
      const rx = createReceiver({
        ctrl, flows, jobId: JOB,
        consent: async () => true,
        openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onEvent: (ev) => events.push(ev),
        reportIntervalMs: 1_000_000, // keep the reporter out of the way of this timing test
        inactivityMs: 1000,
      });
      const done = rx.start().catch((e) => e.message);
      toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'p.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
      await vi.advanceTimersByTimeAsync(0); // let consent+accept flush
      expect(out.some((f) => f.t === 'accept')).toBe(true);

      await vi.advanceTimersByTimeAsync(800); // 800ms since accept — inside the 1000ms window
      // Poke: an inbound ctrl frame arrives, just before the original deadline
      // would elapse. It must NOT complete or cancel the transfer.
      toReceiver(promptingFrame({ jobId: JOB }));
      await vi.advanceTimersByTimeAsync(0); // let the ctrl handler's pokeWatchdog() run

      await vi.advanceTimersByTimeAsync(800); // 1600ms since accept, but only 800ms since the poke
      expect(events.some((e) => e.type === 'interrupted')).toBe(false); // reset held — no stall yet

      await vi.advanceTimersByTimeAsync(300); // now ~1100ms since the poke — past inactivityMs
      const result = await done;
      expect(result).toBe('stalled');
      expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Orchestrator-level wiring for the fd-leak fix: the committed tests for
  // createReceiveRouter.closeAll() only exercise it in isolation. This pins that
  // createReceiver actually CALLS it (via closeRouterParts) when a real
  // receive settles with a genuinely open, non-finalized part in flight — not
  // just that closeAll() itself works when invoked directly.
  it('closes an OPEN, non-finalized part on settle (pins the orchestrator-level closeAll() wiring)', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const openedParts = [];
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => {
        const part = {
          writeAt: vi.fn(() => Promise.resolve()),
          close: vi.fn(() => Promise.resolve()),
          liveDigest: () => null,
        };
        openedParts.push(part);
        return Promise.resolve(part);
      },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
    });
    const done = rx.start().catch((e) => e.message);
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'leak.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    // Deliver only PART of the file's bytes: the router opens the .part on the
    // first bulk frame, but it can't finalize — no file_end has landed and the
    // bytes are incomplete — so this part is genuinely OPEN, not finalized.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array(4).fill(9) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(openedParts.length).toBe(1);
    expect(openedParts[0].close).not.toHaveBeenCalled(); // still open at this point

    // Settle via an inbound cancel (the `fail` path).
    toReceiver(cancelFrame(JOB));
    const result = await done;
    expect(result).toBe('canceled');

    expect(openedParts[0].close).toHaveBeenCalledTimes(1);
  });

  // UI-legibility gap: live-observed as sender "21/22 · 0 MB/s", receiver
  // "20/22 · 0 MB/s", no phase label — the receiver never told the UI it had
  // entered the verify-only tail (all bytes in, still hashing/finalizing).
  // Mirrors the removed single-flow receiver driver's job_done `pending.size > 0` check,
  // but computed from router coverage since multi-flow completion is
  // coverage-defined. Two files: file 0 finalizes fast; file 1's
  // verifyAndFinalize hangs on a controllable promise so the receive sits in
  // the verify-only tail long enough to observe the event ordering.
  it('emits a verifying event once all bytes are in but finalize is still pending — not before, not after completion', async () => {
    const size = 8;
    const { ctrl, toReceiver } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const events = [];
    let resolveVerify;
    const verifyGate = new Promise((res) => { resolveVerify = res; });
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve(), liveDigest: () => null }),
      verifyAndFinalize: ({ fileId }) => (fileId === 1 ? verifyGate.then(() => ({ ok: true })) : Promise.resolve({ ok: true })),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    const entries = [{ fileId: 0, path: 'a.bin', size, mtime: 0 }, { fileId: 1, path: 'b.bin', size, mtime: 0 }];
    toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size * 2, totalFiles: 2 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush

    // File 0: fully received + finalized (fast path) — file 1 hasn't even
    // started, so this is still ordinary mid-transfer, NOT the verify tail.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(1) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H0' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.type === 'verifying')).toBe(false);

    // File 1: only HALF its bytes in — still receiving, definitely not the tail.
    flowCbs[0](encodeBulkFrame({ fileId: 1, offset: 0, length: size / 2, payload: new Uint8Array(size / 2).fill(2) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.type === 'verifying')).toBe(false);

    // File 1: the rest of its bytes arrive — now every file's bytes are in,
    // but file 1's verifyAndFinalize hangs on verifyGate, so it's byte-complete
    // and not yet finalized. THIS is the verify-only tail.
    flowCbs[0](encodeBulkFrame({ fileId: 1, offset: size / 2, length: size / 2, payload: new Uint8Array(size / 2).fill(2) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 1, hash: 'H1' }));
    await new Promise((r) => setTimeout(r, 0));

    const verifying = events.find((e) => e.type === 'verifying');
    expect(verifying).toBeTruthy();
    expect(verifying.progress).toEqual({ received: size * 2, total: size * 2, fraction: 1, filesDone: 1, filesTotal: 2 });
    expect(events.some((e) => e.type === 'completed')).toBe(false); // file 1 still finalizing

    resolveVerify();
    await new Promise((r) => setTimeout(r, 0));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(events.some((e) => e.type === 'completed')).toBe(true);
    // Fired exactly once — a flood of no-op progress calls after the tail
    // began must not re-emit it.
    expect(events.filter((e) => e.type === 'verifying').length).toBe(1);
  });

  // Fix 2: the settle-path close/persist await must be bounded — a wedged
  // part.close() (this codebase has a Windows wedged-fd history) must not hang
  // the whole receive (and its start() caller) forever. A leaked fd on timeout
  // is strictly better than a hung receive.
  it('bounds the settle-path close await: a wedged part.close() does not hang start()', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const fake = fakeClock();
    let closeCalled = false;
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: () => Promise.resolve({
        writeAt: () => Promise.resolve(),
        close: () => { closeCalled = true; return new Promise(() => {}); }, // never resolves
        liveDigest: () => null,
      }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
      inactivityMs: 0, // keep the watchdog out of the way of this timing test
      closeTimeoutMs: 50,
      setTimer: fake.setTimer, clearTimer: fake.clearTimer,
    });
    const done = rx.start().catch((e) => e.message);
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'wedged.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array(4).fill(1) }));
    await new Promise((r) => setTimeout(r, 0)); // part opens, partial (not finalized)

    toReceiver(cancelFrame(JOB));
    await new Promise((r) => setTimeout(r, 0)); // let the cancel handler run + arm the close-timeout timer

    fake.tickOnce(); // fires the close-timeout timer — the wedged close() itself never resolves
    const result = await done;
    expect(result).toBe('canceled');
    expect(closeCalled).toBe(true); // the close WAS attempted — just not awaited past the bound
  });

  // Per-file failure isolation (real field case: Windows AV locks/quarantines
  // one file's .part mid-write — "UNKNOWN: unknown error, open ...setup.exe.part").
  // Before this feature, that throw propagated out of the router's onBulkFrame,
  // failed the WHOLE receive, tripped auto-resume, and the SAME file failed
  // again -> infinite loop. Two files: file 0's openPart persistently fails;
  // file 1 is healthy. `delay: () => Promise.resolve()` keeps the router's
  // bounded retry backoff from actually waiting in this test.
  describe('per-file failure isolation (AV-locked file, etc.)', () => {
    it('resolves COMPLETED with the other file finalized, emits file-failed, sends complete{ok:false}, and reports the failed file as covered', async () => {
      const size = 8;
      const { ctrl, toReceiver, out } = ctrlPair();
      const flowCbs = [];
      const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
      const events = [];
      const part1 = { writeAt: () => Promise.resolve(), close: () => Promise.resolve(), liveDigest: () => null };
      const rx = createReceiver({
        ctrl, flows, jobId: JOB,
        consent: async () => true,
        openPart: (relPath) => (relPath === 'bad.bin'
          ? Promise.reject(new Error('UNKNOWN: unknown error, open bad.bin.part'))
          : Promise.resolve(part1)),
        verifyAndFinalize: () => Promise.resolve({ ok: true }),
        onEvent: (ev) => events.push(ev),
        reportIntervalMs: 10_000,
        delay: () => Promise.resolve(), // instant — this test isn't about real backoff timing
      });
      const done = rx.start();
      const entries = [{ fileId: 0, path: 'bad.bin', size, mtime: 0 }, { fileId: 1, path: 'good.bin', size, mtime: 0 }];
      toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size * 2, totalFiles: 2 }));
      await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
      expect(out.some((f) => f.t === 'accept')).toBe(true);

      // File 0's every bulk frame hits the persistently-failing openPart.
      // File 1 is deliberately left UNTOUCHED at this point, so router.isComplete()
      // is still false and maybeComplete() does NOT fire yet — this lets the
      // NEXT range_report (below) actually go out (a report call is a no-op
      // once settled), so its file0 entry can be checked independently of the
      // final completion report.
      flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(1) }));
      // Let the bounded retry (now instant via injected delay) run to exhaustion.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(events.some((e) => e.type === 'file-failed')).toBe(true); // file 0 already given up on

      // The sender doesn't know the receiver gave up on file 0 — it still
      // sends file_end for it once its bytes+hash are done on its side. That
      // triggers a fresh range_report; file 1 is still untouched, so the
      // receive is NOT complete yet (isolating this report from the final
      // completion report).
      toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'irrelevant-file-already-failed' }));
      await new Promise((r) => setTimeout(r, 0));

      // That report must already show the terminally-failed file 0 as fully
      // covered, so the paired sender's coverage tracker converges instead of
      // re-sending into the same failure forever.
      const midReports = out.filter((f) => f.t === 'range_report');
      const midLatest = midReports[midReports.length - 1];
      const midFile0Entry = midLatest.files.find((f) => f.fileId === 0);
      expect(midFile0Entry).toEqual({ fileId: 0, ivals: [[0, size]] });

      // File 1 delivers + finalizes normally — the failure on file 0 must not
      // have wedged it.
      flowCbs[0](encodeBulkFrame({ fileId: 1, offset: 0, length: size, payload: new Uint8Array(size).fill(2) }));
      await new Promise((r) => setTimeout(r, 0));
      toReceiver(fileEndFrame({ jobId: JOB, fileId: 1, hash: 'H1' }));
      toReceiver(jobDoneFrame({ jobId: JOB }));

      const r = await done; // RESOLVES — must not reject/loop
      expect(r).toEqual({ jobId: JOB, ok: false }); // completed WITH a terminal failure

      const failedEvent = events.find((e) => e.type === 'file-failed');
      expect(failedEvent).toBeTruthy();
      expect(failedEvent.fileId).toBe(0);
      expect(failedEvent.reason).toBe('io_error');

      const doneEvent = events.find((e) => e.type === 'file-done');
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.fileId).toBe(1);

      expect(out.some((f) => f.t === 'complete' && f.ok === false)).toBe(true);
    });
  });

  // Task 5: a re-dialed replacement flow (the supervisor's job, done in a later
  // task) must be able to JOIN the running receive — its bulk frames need to
  // reach the SAME router as the original flows so reassembly keeps working.
  // addFlow just wires channel.onBulk into router.onBulkFrame exactly like the
  // initial `for (const flow of flows) flow.onBulk(...)` loop above.
  it('addFlow wires a new flow\'s onBulk into the same router — its bulk frames advance reassembly', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'r.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);

    // Original flow (index 0) delivers the first half.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: 4, payload: new Uint8Array(4).fill(1) }));
    await new Promise((r) => setTimeout(r, 0));

    // A replacement flow (index 2, a bulk-only re-dial slot) JOINS mid-receive.
    let newFlowCb = null;
    const newChannel = { onBulk: (cb) => { newFlowCb = cb; } };
    rx.addFlow(newChannel, 2);
    expect(newFlowCb).toBeTruthy(); // onBulk was actually wired

    // Its bulk frame must reach the SAME router as flow 0 — deliver the second
    // half via the NEW flow and finish the transfer entirely through it.
    newFlowCb(encodeBulkFrame({ fileId: 0, offset: 4, length: 4, payload: new Uint8Array(4).fill(2) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect([...parts.get('r.bin')]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]); // both flows' bytes landed
  });

  // Task 5: idempotent OFFER — a rolling-join re-dial re-sends the OFFER to
  // re-sync a replacement flow (a later task), but the receiver must not treat
  // a repeat OFFER for the SAME (already-active) jobId as a fresh transfer: no
  // second consent prompt, no state reset.
  it('ignores a duplicate OFFER for the already-active jobId: no re-prompt, no state reset', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const consent = vi.fn(async () => true);
    const events = [];
    const rx = createReceiver({
      ctrl, flows, jobId: JOB,
      consent,
      openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve(), liveDigest: () => null }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    const entries = [{ fileId: 0, path: 'd.bin', size, mtime: 0 }];
    toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);
    expect(consent).toHaveBeenCalledTimes(1);
    const acceptFramesBefore = out.filter((f) => f.t === 'accept').length;
    const acceptedEventsBefore = events.filter((e) => e.type === 'accepted').length;

    // Duplicate OFFER for the SAME jobId arrives (e.g. a ctrl re-dial re-sync).
    toReceiver(offerFrame({ jobId: JOB, entries, totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0));

    expect(consent).toHaveBeenCalledTimes(1); // NOT re-prompted
    expect(out.filter((f) => f.t === 'accept').length).toBe(acceptFramesBefore); // no second accept frame
    expect(events.filter((e) => e.type === 'accepted').length).toBe(acceptedEventsBefore); // no state reset

    // Finish the transfer normally so the promise settles cleanly.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(3) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
  });

  // Task 5 review fold-in: the committed duplicate-OFFER test only pinned the
  // simple single `offer` frame. A many-file re-dial re-sync re-sends the CHUNKED
  // OFFER (offer_begin -> offer_entries* -> offer_end), which must be equally
  // idempotent — the whole thing re-sent for an already-active jobId must not
  // re-prompt consent or reset state. This pins exactly the idempotency the
  // sender's setCtrl re-send relies on.
  it('ignores a duplicate CHUNKED OFFER for the already-active jobId: no re-prompt, no state reset', async () => {
    const size = 8;
    const { ctrl, toReceiver, out } = ctrlPair();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const consent = vi.fn(async () => true);
    const events = [];
    const rx = createReceiver({
      ctrl, flows, jobId: JOB, consent,
      openPart: () => Promise.resolve({ writeAt: () => Promise.resolve(), close: () => Promise.resolve(), liveDigest: () => null }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onEvent: (ev) => events.push(ev),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    const entries = [{ fileId: 0, path: 'd.bin', size, mtime: 0 }];
    const sendChunkedOffer = () => {
      toReceiver(offerBeginFrame({ jobId: JOB, totalBytes: size, totalFiles: 1 }));
      toReceiver(offerEntriesFrame({ jobId: JOB, entries }));
      toReceiver(offerEndFrame({ jobId: JOB }));
    };

    // Full chunked OFFER once → consent + accept + beginReceive.
    sendChunkedOffer();
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(out.some((f) => f.t === 'accept')).toBe(true);
    expect(consent).toHaveBeenCalledTimes(1);
    const acceptFramesBefore = out.filter((f) => f.t === 'accept').length;
    const acceptedEventsBefore = events.filter((e) => e.type === 'accepted').length;

    // The WHOLE chunked OFFER is re-sent for the SAME jobId (a ctrl re-dial re-sync).
    sendChunkedOffer();
    await new Promise((r) => setTimeout(r, 0));

    expect(consent).toHaveBeenCalledTimes(1); // beginReceive fired only ONCE
    expect(out.filter((f) => f.t === 'accept').length).toBe(acceptFramesBefore); // no second accept
    expect(events.filter((e) => e.type === 'accepted').length).toBe(acceptedEventsBefore); // no state reset

    // Finish the transfer normally so the promise settles cleanly.
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(3) }));
    await new Promise((r) => setTimeout(r, 0));
    toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
  });

  // Task 6: the ctrl channel is SWAPPABLE on the receiver too. After setCtrl(ch2)
  // — the supervisor re-dialed a dead slot 0 — inbound ctrl on the new channel is
  // handled (accept/range_report/complete continue) AND the receiver's own emitted
  // ctrl frames go out on the new channel. The old channel no longer drives state.
  it('setCtrl swaps the ctrl channel: emitted ctrl goes out on the new channel, inbound ctrl on it is handled, and the old channel is ignored', async () => {
    const size = 8;
    const p1 = ctrlPair();
    const p2 = ctrlPair();
    const parts = new Map();
    const flowCbs = [];
    const flows = [{ onBulk: (cb) => flowCbs.push(cb) }];
    const rx = createReceiver({
      ctrl: p1.ctrl, flows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => { const b = new Uint8Array(size); parts.set(relPath, b); return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null }); },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
    });
    const done = rx.start();
    p1.toReceiver(offerFrame({ jobId: JOB, entries: [{ fileId: 0, path: 'x.bin', size, mtime: 0 }], totalBytes: size, totalFiles: 1 }));
    await new Promise((r) => setTimeout(r, 0)); // let consent+accept flush
    expect(p1.out.some((f) => f.t === 'accept')).toBe(true); // accept went out on the ORIGINAL channel

    // Bytes land on the bulk flow (flow-agnostic — unaffected by the ctrl swap).
    flowCbs[0](encodeBulkFrame({ fileId: 0, offset: 0, length: size, payload: new Uint8Array(size).fill(7) }));
    await new Promise((r) => setTimeout(r, 0));

    // Slot 0 (ctrl flow) died and was re-dialed: swap.
    const emittedOnCh1BeforeSwap = p1.out.length;
    rx.setCtrl(p2.ctrl);

    // The OLD channel no longer drives state: a cancel on ch1 must be ignored.
    p1.toReceiver(cancelFrame(JOB));
    await new Promise((r) => setTimeout(r, 0));

    // Inbound completion arrives on the NEW channel and is handled.
    p2.toReceiver(fileEndFrame({ jobId: JOB, fileId: 0, hash: 'H' }));
    p2.toReceiver(jobDoneFrame({ jobId: JOB }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true }); // driven to completion by inbound ctrl on ch2 (ch1 cancel ignored)

    expect(p2.out.some((f) => f.t === 'complete' && f.ok === true)).toBe(true); // receiver-emitted ctrl goes out on ch2
    expect(p1.out.length).toBe(emittedOnCh1BeforeSwap); // nothing more emitted on the old channel after swap
  });
});
