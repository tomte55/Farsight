// packages/shared/test/transfer-service-multiflow.test.js
// Plan 3 Task 3: the transfer-service multi-flow branch, driven end to end through
// createTransferService (not the bare orchestrator drivers — that's Plan 2's own
// transfer-multiflow-service-loopback.test.js, whose link() in-memory duplex helper
// this file reuses). Proves (a) a striped, drop-and-recover send/receive lands
// byte-identical on real disk, and (b) a receive that resumes from a persisted
// partial state only transfers the gap, not the whole file again.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransferService } from '../src/transfer-service.js';
import { createJobsStore } from '../src/jobs-store.js';
import { createSparsePartFile } from '../src/transfer-io.js';
import { newJobId } from '../src/transfer-queue.js';
import { offerFrame, parseCtrlFrame, acceptFrame, completeFrame } from '../src/transfer-protocol.js';

const dirs = [];
async function tmp() { const d = await mkdtemp(join(tmpdir(), 'ftsvc-mf-')); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

// Poll until a predicate holds (mirrors transfer-service.test.js:21-24).
async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 1)); }
}

// Same in-memory duplex wiring as Plan 2's transfer-multiflow-service-loopback.test.js:
// N flows, sender.sendBulk(i) -> receiver.flows round-robin onBulk. sendCtrl is
// delivered SYNCHRONOUSLY to whichever onCtrl callback is currently registered on
// the peer side (no queueMicrotask) -- exactly the fixture the Task 3 brief points at.
function link({ flowCount, dropFirst }) {
  const rxCtrlCb = { fn: null }, sxCtrlCb = { fn: null };
  const rxFlowCbs = [];
  const senderCtrl = { sendCtrl: (s) => rxCtrlCb.fn && rxCtrlCb.fn(s), onCtrl: (cb) => { sxCtrlCb.fn = cb; } };
  const receiverCtrl = { sendCtrl: (s) => sxCtrlCb.fn && sxCtrlCb.fn(s), onCtrl: (cb) => { rxCtrlCb.fn = cb; } };
  const dropped = new Set(dropFirst || []);
  let rr = 0;
  const senderFlows = Array.from({ length: flowCount }, (_, i) => ({
    isAlive: () => true,
    sendBulk: (buf) => {
      const key = `${new DataView(buf).getUint32(0)}:${Number(new DataView(buf).getBigUint64(4))}`;
      const target = rxFlowCbs[(rr++) % rxFlowCbs.length];
      if (!dropped.has(key)) target(buf); else dropped.delete(key);
      return Promise.resolve();
    },
  }));
  const receiverFlows = Array.from({ length: flowCount }, () => ({ onBulk: (cb) => rxFlowCbs.push(cb) }));
  return { senderCtrl, receiverCtrl, senderFlows, receiverFlows };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('transfer-service multi-flow branch (real disk + jobs-store)', () => {
  it('stripes a big file + small files across flows through createTransferService, drops a chunk, lands byte-identical on disk and records done', async () => {
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const CHUNK = 131072;
    const big = new Uint8Array(CHUNK * 3 + 111).map((_, i) => (i * 31) & 0xff);
    const s1 = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
    const s2 = new Uint8Array(50).fill(42);
    await writeFile(join(srcDir, 'big.bin'), big);
    await writeFile(join(srcDir, 's1.bin'), s1);
    await writeFile(join(srcDir, 's2.bin'), s2);
    const entries = [
      { fileId: 0, path: 'big.bin', size: big.length, mtime: 1 },
      { fileId: 1, path: 's1.bin', size: s1.length, mtime: 1 },
      { fileId: 2, path: 's2.bin', size: s2.length, mtime: 1 },
    ];
    const manifest = { entries, totalBytes: big.length + s1.length + s2.length, totalFiles: 3 };
    const sources = new Map([
      [0, join(srcDir, 'big.bin')],
      [1, join(srcDir, 's1.bin')],
      [2, join(srcDir, 's2.bin')],
    ]);

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 4, dropFirst: ['0:131072'] });

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: senderFlows, close: async () => {} }),
    });

    const jobId = 'a'.repeat(32);
    const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-1' });
    await tick(10); // let the receive register its raw ctrl handler before the sender's first frame
    const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-mf', flowCount: 4 } });
    const recvResult = await recvPromise;

    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 'big.bin'))).equals(Buffer.from(big))).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 's1.bin'))).equals(Buffer.from(s1))).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 's2.bin'))).equals(Buffer.from(s2))).toBe(true);

    const recvJobs = await recvStore.list();
    const recvRec = recvJobs.find((j) => j.jobId === jobId);
    expect(recvRec).toBeTruthy();
    expect(recvRec.jobState).toBe('done');
    expect(recvRec.dir).toBe('recv');

    const sendJobs = await sendStore.list();
    const sendRec = sendJobs.find((j) => j.jobId === jobId);
    expect(sendRec).toBeTruthy();
    expect(sendRec.jobState).toBe('done');
    expect(sendRec.peer).toEqual({ id: 'device-mf' });
  });

  it('resumes from a pre-populated partial .part + a persisted receive record: only the gap transfers', async () => {
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const CHUNK = 131072;
    const big = new Uint8Array(CHUNK * 3 + 111).map((_, i) => (i * 37 + 5) & 0xff);
    await writeFile(join(srcDir, 'big.bin'), big);
    const entries = [{ fileId: 0, path: 'big.bin', size: big.length, mtime: 1 }];
    const manifest = { entries, totalBytes: big.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'big.bin')]]);

    const jobId = 'b'.repeat(32);

    // Simulate the on-disk + store state left behind by a PRIOR, interrupted
    // receive: the first chunk (aligned to chunkSize, so the producer's covers()
    // check skips it cleanly) is already written into the sparse .part, and the
    // receive record persists that coverage the same way the multi-flow branch's
    // persistRanges seam would have.
    const part = await createSparsePartFile({ destRoot: dstDir, relPath: 'big.bin' });
    await part.writeAt(0, Buffer.from(big.subarray(0, CHUNK)));
    await part.fsync();
    await part.close();
    await recvStore.save({
      jobId, dir: 'recv', tier: 'adhoc', peer: {}, destRoot: dstDir,
      manifest,
      perFile: [{ fileId: 0, ivals: [[0, CHUNK]], status: 'pending' }],
      jobState: 'interrupted', createdAt: Date.now(),
    });

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 3 });
    let bulkSendCount = 0;
    const countingSenderFlows = senderFlows.map((f) => ({
      isAlive: f.isAlive,
      sendBulk: (buf) => { bulkSendCount += 1; return f.sendBulk(buf); },
    }));

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: countingSenderFlows, close: async () => {} }),
    });

    const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-2' });
    await tick(10);
    const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-mf2', flowCount: 3 } });
    const recvResult = await recvPromise;

    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 'big.bin'))).equals(Buffer.from(big))).toBe(true);

    // A from-scratch send of this file would need ceil(size/CHUNK) = 4 bulk
    // frames; the persisted [0, CHUNK) coverage must make the sender skip that
    // first chunk entirely, so fewer bulk frames than a full transfer went out.
    const fullTransferChunkCount = Math.ceil(big.length / CHUNK);
    expect(bulkSendCount).toBeLessThan(fullTransferChunkCount);

    const recvRec = (await recvStore.list()).find((j) => j.jobId === jobId);
    expect(recvRec.jobState).toBe('done');
  });

  // The actual field bug: a resume where ONE file is already fully received
  // (byte-complete via persisted ranges from a prior interrupted attempt), so
  // the sender's initial pass yields it NO bulk chunks at all (already fully
  // covered) — only its file_end arrives. That means openPart is NEVER called
  // for this file this run, so the old partFile-based verifyAndFinalize got
  // `partFile: undefined` and crashed on `partFile.liveDigest()` in an infinite
  // loop (the ctrl handler kept re-processing). The path-based fix
  // (finalizeReceivedPath) must finalize this file from disk with no open
  // handle at all.
  it('resumes a file that is ALREADY fully received (persisted full ranges, no .part bytes needed) without crashing on undefined.liveDigest', async () => {
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const content = new Uint8Array(500).map((_, i) => (i * 13 + 3) & 0xff);
    await writeFile(join(srcDir, 'done.bin'), content);
    const entries = [{ fileId: 0, path: 'done.bin', size: content.length, mtime: 1 }];
    const manifest = { entries, totalBytes: content.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'done.bin')]]);

    const jobId = 'c'.repeat(32);

    // Simulate the prior run's leftovers: the .part already holds every byte
    // (a genuinely complete-but-not-yet-renamed file — e.g. the process died
    // between the last write and finalize), and the receive record persists
    // full [0,size) coverage for it, exactly as this run's persistRanges seam
    // would have left behind.
    const part = await createSparsePartFile({ destRoot: dstDir, relPath: 'done.bin' });
    await part.writeAt(0, Buffer.from(content));
    await part.fsync();
    await part.close();
    await recvStore.save({
      jobId, dir: 'recv', tier: 'adhoc', peer: {}, destRoot: dstDir,
      manifest,
      perFile: [{ fileId: 0, ivals: [[0, content.length]], status: 'pending' }],
      jobState: 'interrupted', createdAt: Date.now(),
    });

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 2 });
    let bulkSendCount = 0;
    const countingSenderFlows = senderFlows.map((f) => ({
      isAlive: f.isAlive,
      sendBulk: (buf) => { bulkSendCount += 1; return f.sendBulk(buf); },
    }));

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: countingSenderFlows, close: async () => {} }),
    });

    const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-3' });
    await tick(10);
    const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-mf3', flowCount: 2 } });
    const recvResult = await recvPromise;

    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    // Already fully covered per persisted ranges: NO bulk frames were needed for it.
    expect(bulkSendCount).toBe(0);
    expect(Buffer.from(await readFile(join(dstDir, 'done.bin'))).equals(Buffer.from(content))).toBe(true);

    const recvRec = (await recvStore.list()).find((j) => j.jobId === jobId);
    expect(recvRec.jobState).toBe('done');
  });
});

// Plan 3 Task 5: deterministic teardown. The controller's real openChannel
// resolves assembleSendFlows/assembleReceiveGroup's {ctrl, flows, close} shape
// (Task 4), whose close() Promise.all-closes every one of the N worker
// windows (pinned directly in packages/controller/test/
// openchannel-multiflow.test.js and multiflow-teardown.test.js). THIS layer
// pins the other half of the chain: that transfer-service.js's runSend and
// runMultiFlowReceive actually CALL that close() on every settle path
// (completion, cancel, error) for the multi-flow branch — exactly like the
// existing single-flow "cancel() on the active send closes its channel" /
// "SP3 P4: cancel aborts a LIVE receive" tests in transfer-service.test.js,
// just against the {ctrl, flows, close} shape instead of {channel, close}.
describe('transfer-service multi-flow branch: close() teardown on every settle path', () => {
  it('SEND completing normally calls close() exactly once', async () => {
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const small = new Uint8Array(64).map((_, i) => i);
    await writeFile(join(srcDir, 's.bin'), small);
    const entries = [{ fileId: 0, path: 's.bin', size: small.length, mtime: 1 }];
    const manifest = { entries, totalBytes: small.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 's.bin')]]);

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 3 });
    let sendCloseCount = 0;
    let recvCloseCount = 0;

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => { recvCloseCount += 1; } }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: senderFlows, close: async () => { sendCloseCount += 1; } }),
    });

    const jobId = newJobId();
    const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-close-1' });
    await tick(10);
    const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-close-1', flowCount: 3 } });
    const recvResult = await recvPromise;

    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    // Neither side's close() is skipped, and neither fires more than once on a
    // clean completion (a stray extra call would mean something re-tears-down
    // an already-closed bundle for no reason; a missing call is the actual
    // app-alive leak this whole task guards against).
    expect(sendCloseCount).toBe(1);
    expect(recvCloseCount).toBe(1);
  });

  it('SEND canceled mid-flight closes the multi-flow channel (all N workers, via close())', async () => {
    const sendStore = createJobsStore({ dir: await tmp() });
    const srcDir = await tmp();
    await writeFile(join(srcDir, 'x.bin'), new Uint8Array(5000).fill(1));
    const entries = [{ fileId: 0, path: 'x.bin', size: 5000, mtime: 1 }];
    const manifest = { entries, totalBytes: 5000, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'x.bin')]]);

    let opened = false;
    let closeCount = 0;
    // A dead multi-flow channel nobody drives further (no receiver ever ACKs
    // the OFFER) — mirrors transfer-service.test.js's single-flow "cancel() on
    // the active send closes its channel" fixture, but with the {ctrl, flows}
    // shape the multi-flow branch actually uses.
    const svc = createTransferService({
      store: sendStore, transferDir: await tmp(), consent: async () => true,
      openChannel: async () => {
        opened = true;
        return {
          ctrl: { sendCtrl() {}, onCtrl() {} },
          flows: [
            { isAlive: () => true, sendBulk: async () => {} },
            { isAlive: () => true, sendBulk: async () => {} },
          ],
          close: async () => { closeCount += 1; },
        };
      },
    });

    const jobId = newJobId();
    const p = svc.startSend({ jobId, manifest, sources, target: { id: 'device-close-2', flowCount: 2 } });
    await until(() => opened);

    const c = await svc.cancel(jobId);
    expect(c.ok).toBe(true);
    // close() was reached — in the real app this is assembleSendFlows' close(),
    // which Promise.all-closes every one of the N worker windows (Task 4).
    expect(closeCount).toBeGreaterThanOrEqual(1);

    const result = await p;
    expect(result.canceled).toBe(true);
    const rec = (await sendStore.list()).find((j) => j.jobId === jobId);
    expect(rec.jobState).toBe('canceled');
  });

  it('RECEIVE canceled mid-flight (multi-flow shape) really stops the receive and closes the group bundle', async () => {
    const dest = await tmp();
    const recvStore = createJobsStore({ dir: await tmp() });
    let ctrlCb = null;
    let closeCount = 0;
    const sentToSender = [];
    const ctrl = {
      sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); },
      onCtrl(cb) { ctrlCb = cb; },
    };
    // Two flows that never deliver any bulk data — the receive stays "active"
    // (awaiting file bytes) until canceled, exactly like the single-flow
    // "SP3 P4: cancel aborts a LIVE receive" fixture, but exercising
    // runMultiFlowReceive's {ctrl, flows, close} branch instead.
    const flows = [{ onBulk() {} }, { onBulk() {} }];
    const svc = createTransferService({
      store: recvStore, transferDir: dest, consent: async () => true,
      openChannel: async () => ({ ctrl, flows, close: async () => { closeCount += 1; } }),
      receiveCloseGraceMs: 0,
    });

    const jobId = newJobId();
    const entries = [{ fileId: 0, path: 'y.bin', size: 16, mtime: 1 }];
    // createMultiFlowReceiver's abort() REJECTS (unlike the single-flow
    // receiver's resolve-with-'canceled') — mirror transfer-service.test.js's
    // own SP3 P4 fixture, which catches it down to the reason string.
    const recvPromise = svc.startReceive({ rendezvous: { sessionId: 'r-mf-close-3' } }).catch((e) => e.message);
    await until(() => ctrlCb !== null);
    ctrlCb(offerFrame({ jobId, entries, totalBytes: 16, totalFiles: 1 }));
    await until(() => sentToSender.some((f) => f.t === 'accept'));

    expect(await svc.cancel(jobId)).toEqual({ ok: true });
    const recvResult = await recvPromise;
    expect(recvResult).toBe('canceled');
    expect(sentToSender.some((f) => f.t === 'cancel')).toBe(true);
    // The group bundle's close() — which in the real app closes every one of
    // the group's K opened flow handles (assembleReceiveGroup, Task 4/5) — was
    // reached on this settle path, not skipped. This is the actual teardown
    // invariant Task 5 is about; the jobs-store record's terminal state is a
    // separate concern (see the note below) and isn't asserted here.
    expect(closeCount).toBeGreaterThanOrEqual(1);
    // NOTE (discovered while writing this test, out of scope for Task 5):
    // unlike single-flow's createReceiver, which persists an 'active' record
    // immediately on accept (transfer-orchestrator.js's saveRecord('active')),
    // createMultiFlowReceiver only persists via the periodic persistRanges tick
    // (default reportIntervalMs=3000) — so canceling a multi-flow receive THIS
    // early (before the first tick) leaves no jobs-store record to flip to
    // 'canceled' at all (cancel()'s store.load(jobId) finds nothing). The
    // receive still stops correctly and every worker still gets torn down
    // (asserted above) — only the Transfers-list bookkeeping for a
    // near-instant cancel is affected. Flagged for a follow-up task, not fixed
    // here (touches transfer-orchestrator.js's multi-flow beginReceive, outside
    // this task's teardown scope).
  });
});

// Review fix: runSend used to hardcode `result = { jobId, ok: true }` right
// after `await sender.start()`, ignoring whatever the promise actually
// resolved with. createMultiFlowSender's start() CAN resolve { jobId,
// ok:false } — the receiver's own 'complete' ctrl frame carries ok:false when
// it finished reconciling but one file terminally failed (per-file I/O
// isolation) — so the old code persisted/reported a false "fully succeeded"
// even though the 'completed' event the caller also sees carries ok:false.
// Drives the SENDER side only through a hand-fed ctrl channel (no real
// receiver needed): feed it `accept` to unblock the pump, then feed it
// `complete{ok:false}` directly — exactly the wire frame a real receiver's
// maybeComplete() sends on a completed-with-failures reconciliation (see its
// doc in transfer-orchestrator.js) — regardless of how far the pump itself got.
describe('transfer-service: runSend honors the resolved ok (not hardcoded true)', () => {
  it('a multi-flow send whose sender.start() resolves {ok:false} records ok:false (jobState still done)', async () => {
    const srcDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });

    const small = new Uint8Array(32).fill(7);
    await writeFile(join(srcDir, 'z.bin'), small);
    const entries = [{ fileId: 0, path: 'z.bin', size: small.length, mtime: 1 }];
    const manifest = { entries, totalBytes: small.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'z.bin')]]);

    let ctrlCb = null;
    const ctrl = {
      sendCtrl() {}, // outbound frames aren't needed for this test
      onCtrl(cb) { ctrlCb = cb; },
    };
    const flows = [{ isAlive: () => true, sendBulk: async () => {} }];

    const svc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl, flows, close: async () => {} }),
    });

    const jobId = newJobId();
    const sendPromise = svc.startSend({ jobId, manifest, sources, target: { id: 'device-okfalse', flowCount: 2 } });
    await until(() => ctrlCb !== null);
    ctrlCb(acceptFrame({ jobId, resume: [] }));
    await tick(5);
    ctrlCb(completeFrame({ jobId, ok: false }));

    const result = await sendPromise;
    expect(result.ok).toBe(false); // truthful — not the old hardcoded true

    const rec = (await sendStore.list()).find((j) => j.jobId === jobId);
    expect(rec).toBeTruthy();
    expect(rec.jobState).toBe('done'); // still done — not resumable; per-file failures are recorded elsewhere
  });

  it('a normal multi-flow success (sender.start() resolves with no ok:false) still records ok:true', async () => {
    const srcDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });

    const small = new Uint8Array(32).fill(3);
    await writeFile(join(srcDir, 'z2.bin'), small);
    const entries = [{ fileId: 0, path: 'z2.bin', size: small.length, mtime: 1 }];
    const manifest = { entries, totalBytes: small.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'z2.bin')]]);

    let ctrlCb = null;
    const ctrl = { sendCtrl() {}, onCtrl(cb) { ctrlCb = cb; } };
    const flows = [{ isAlive: () => true, sendBulk: async () => {} }];

    const svc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl, flows, close: async () => {} }),
    });

    const jobId = newJobId();
    const sendPromise = svc.startSend({ jobId, manifest, sources, target: { id: 'device-oktrue', flowCount: 2 } });
    await until(() => ctrlCb !== null);
    ctrlCb(acceptFrame({ jobId, resume: [] }));
    await tick(5);
    ctrlCb(completeFrame({ jobId, ok: true }));

    const result = await sendPromise;
    expect(result.ok).toBe(true);
    const rec = (await sendStore.list()).find((j) => j.jobId === jobId);
    expect(rec.jobState).toBe('done');
  });
});
