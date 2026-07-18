// packages/shared/test/transfer-multiflow-receiver.test.js
import { describe, it, expect } from 'vitest';
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
});
