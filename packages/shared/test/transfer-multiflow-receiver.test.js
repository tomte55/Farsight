// packages/shared/test/transfer-multiflow-receiver.test.js
import { describe, it, expect, vi } from 'vitest';
import { createMultiFlowReceiver } from '../src/transfer-orchestrator.js';
import { encodeBulkFrame } from '../src/transfer-chunk.js';
import { offerFrame, fileEndFrame, jobDoneFrame, parseCtrlFrame } from '../src/transfer-protocol.js';

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
});
