// packages/shared/test/transfer-service-multiflow.test.js
// Plan 3 Task 3: the transfer-service multi-flow branch, driven end to end through
// createTransferService (not the bare orchestrator drivers — that's Plan 2's own
// transfer-multiflow-service-loopback.test.js, whose link() in-memory duplex helper
// this file reuses). Proves (a) a striped, drop-and-recover send/receive lands
// byte-identical on real disk, and (b) a receive that resumes from a persisted
// partial state only transfers the gap, not the whole file again.
import { describe, it, expect, beforeEach, afterEach, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
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

  // Plan 3 Task 6: createTransferService threads its ONE rate limiter into the
  // multi-flow createSender it constructs (via createSendPool's choke
  // point) -- proved end to end here through the real multi-flow loopback: an
  // injected fake limiter's take() is asked to pace chunks dispatched across
  // MULTIPLE flows, confirming it's the SAME shared instance seeing all of
  // them (not a fresh one per flow).
  it('threads a shared injected rateLimiter into the multi-flow send path -- take() paces chunks across every flow', async () => {
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const CHUNK = 131072;
    const big = new Uint8Array(CHUNK * 3 + 111).map((_, i) => (i * 31) & 0xff);
    await writeFile(join(srcDir, 'big.bin'), big);
    const entries = [{ fileId: 0, path: 'big.bin', size: big.length, mtime: 1 }];
    const manifest = { entries, totalBytes: big.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'big.bin')]]);

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 4 });

    const takenCalls = [];
    const rateLimiter = {
      take: (n) => { takenCalls.push(n); return Promise.resolve(); },
      setRate: () => {}, rate: () => 0,
    };

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: senderFlows, close: async () => {} }),
      rateLimiter,
    });

    const jobId = 'c'.repeat(32);
    const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-rl' });
    await tick(10);
    const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-mf-rl', flowCount: 4 } });
    const recvResult = await recvPromise;

    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 'big.bin'))).equals(Buffer.from(big))).toBe(true);

    // Every chunk striped across all 4 flows went through the ONE injected limiter.
    expect(takenCalls.length).toBeGreaterThan(1);
    expect(takenCalls.reduce((a, b) => a + b, 0)).toBe(16 * takenCalls.length + big.length);
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

  // Phase 2 Task 8 (F-A2 clean-break): INVESTIGATION FINDING -- this is Case B,
  // not Case A. Read before touching this test:
  //   1. createSparsePartFile (transfer-io.js) DOES reuse an existing .part on
  //      disk (opens 'r+' if present, grows-only -- never truncates/discards).
  //   2. BUT readPersistedRanges (above) only honors a perFile entry whose
  //      `ivals` is a real Array -- a legacy single-flow record's perFile
  //      entries (shape `{fileId, status}`, no `ivals` -- see saveSendRecord's
  //      perFile above and the retired single-flow receiver driver) fail that
  //      check and are silently OMITTED from the returned map. So
  //      persistedRanges for a legacy record is ALREADY {} (empty) for every
  //      file, with zero extra code.
  //   3. createReceiveRouter's completion (`f.ranges.isComplete(f.size)`) is
  //      driven purely by explicitly-tracked writeAt() coverage, never by the
  //      .part's on-disk size/content -- so an empty initial range forces the
  //      accept-frame to report the file as 0% covered, the sender resends
  //      EVERY byte from scratch, and finalize only fires once every byte
  //      position has been freshly (re)written this session. The stale bytes
  //      already sitting in the reused .part are therefore always fully
  //      overwritten before any hash-verified publish -- never read through.
  // Net effect: the F-A2 hazard (a size-complete read republishing a stale/
  // zero-filled file) cannot occur for a legacy record with the CURRENT code,
  // with no discard/legacy-detection logic needed (R2/R7 -- don't build what
  // isn't broken). This test is a REGRESSION GUARD pinning that safety so a
  // future change (e.g. "optimize: skip resending if .part size==final size")
  // can't reintroduce it. Mutation-checked by hand (see task-8-report.md):
  // temporarily made readPersistedRanges treat a missing-ivals perFile entry
  // as fully covered ([[0,size]]) -- the assertions below then failed as
  // expected (no bulk frames sent / delivered bytes stayed the stale content),
  // proving this test actually exercises the hazard rather than passing
  // for an unrelated reason.
  describe('Phase 2 Task 8: legacy single-flow recv record never cross-model resumes (F-A2)', () => {
    it('a legacy-format interrupted recv record (perFile with no ivals) + a stale sequential .part restarts from zero and delivers the freshly-sent bytes, not the stale ones', async () => {
      const srcDir = await tmp();
      const dstDir = await tmp();
      const sendStore = createJobsStore({ dir: await tmp() });
      const recvStore = createJobsStore({ dir: await tmp() });

      const CHUNK = 131072;
      const big = new Uint8Array(CHUNK * 3 + 111).map((_, i) => (i * 41 + 9) & 0xff);
      await writeFile(join(srcDir, 'big.bin'), big);
      const entries = [{ fileId: 0, path: 'big.bin', size: big.length, mtime: 1 }];
      const manifest = { entries, totalBytes: big.length, totalFiles: 1 };
      const sources = new Map([[0, join(srcDir, 'big.bin')]]);

      const jobId = 'e'.repeat(32);

      // Simulate what a LEGACY (pre-coverage, single-flow-era) interrupted
      // receive left behind: a .part written the OLD sequential way (here
      // stood in for by deliberately WRONG stale bytes, distinct from `big`,
      // so any accidental reuse of them is detectable), and a receive record
      // whose perFile carries NO `ivals` at all -- exactly
      // saveSendRecord's `{fileId, status}` shape, not
      // saveReceiveRecordWithRanges's `{fileId, ivals, status}` shape.
      const stale = Buffer.alloc(big.length, 0xee);
      const part = await createSparsePartFile({ destRoot: dstDir, relPath: 'big.bin' });
      await part.writeAt(0, stale);
      await part.fsync();
      await part.close();
      await recvStore.save({
        jobId, dir: 'recv', tier: 'adhoc', peer: {}, destRoot: dstDir,
        manifest,
        perFile: [{ fileId: 0, status: 'pending' }], // legacy shape: no ivals
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

      const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-legacy' });
      await tick(10);
      const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-mf-legacy', flowCount: 3 } });
      const recvResult = await recvPromise;

      expect(sendResult.ok).toBe(true);
      expect(recvResult.ok).toBe(true);

      // The delivered file matches the FRESHLY sent bytes -- never the stale
      // 0xee content that was sitting in the reused .part, and never a
      // zero-filled/partial file (F-A2's actual failure mode).
      const delivered = Buffer.from(await readFile(join(dstDir, 'big.bin')));
      expect(delivered.equals(Buffer.from(big))).toBe(true);
      expect(delivered.equals(stale)).toBe(false);

      // A legacy record must restart from ZERO, i.e. a full resend -- not a
      // "gap only" resume the way the modern-coverage resume test above
      // proves. Every chunk went out; none were skipped as "already covered".
      const fullTransferChunkCount = Math.ceil(big.length / CHUNK);
      expect(bulkSendCount).toBe(fullTransferChunkCount);

      const recvRec = (await recvStore.list()).find((j) => j.jobId === jobId);
      expect(recvRec.jobState).toBe('done');
    });
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
    // createReceiver's abort() REJECTS (unlike the single-flow
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
    // unlike the removed single-flow receiver driver, which persisted an
    // 'active' record immediately on accept (transfer-orchestrator.js's saveRecord('active')),
    // createReceiver only persists via the periodic persistRanges tick
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
// resolved with. createSender's start() CAN resolve { jobId,
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
  it('a multi-flow send whose sender.start() resolves {ok:false} records completed_with_errors (F-A4)', async () => {
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
    expect(rec.jobState).toBe('completed_with_errors'); // F-A4: a dropped file must not read as clean 'done'
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

// Resilient multi-flow Task 7: transfer-service is the ONLY place that holds
// BOTH the opened multi-flow bundle (from main's assembleSendFlows / the group
// rendezvous) AND the constructed sender/receiver, so it owns three wirings the
// supervisor/rolling-join depend on. Guarded here as source-text contract points
// (the full behaviour is proven in the orchestrator drivers + the controller
// assembly tests); mirrors the repo's wiring-guard convention.
describe('transfer-service: supervisor + rolling-join wiring (source guards)', () => {
  const src = readFileSync(new URL('../src/transfer-service.js', import.meta.url), 'utf8');

  test('multi-flow SEND threads the bundle\'s awaitFlow into createSender (→ its send pool)', () => {
    expect(src).toMatch(/createSender\(\{[\s\S]*?awaitFlow:\s*opened\.awaitFlow/);
  });

  // Task 9: per-flow health (flowsLive/flowsTotal/redials) in the aggregate
  // progress event. flowsLive/flowsTotal are derived inside createSender
  // itself (from the pool + the flowCount already threaded here); redials needs
  // the supervisor's counter threaded in from the opened bundle.
  test('multi-flow SEND threads the bundle\'s redialCount into createSender (→ progress.redials)', () => {
    expect(src).toMatch(/createSender\(\{[\s\S]*?redialCount:\s*opened\.redialCount/);
  });

  test('multi-flow SEND wires the bundle\'s onCtrlReplaced to the sender\'s setCtrl (slot-0 ctrl swap)', () => {
    expect(src).toMatch(/opened\.onCtrlReplaced\s*===\s*'function'/);
    expect(src).toMatch(/opened\.onCtrlReplaced\(\([^)]*\)\s*=>[\s\S]*?\.setCtrl\(/);
  });

  test('runMultiFlowReceive is threaded the sessionId so the sink can be keyed by it', () => {
    expect(src).toMatch(/runMultiFlowReceive\(\{[\s\S]*?sessionId/);
  });
});

describe('transfer-service multi-flow: pre-consent join buffer (F-B6)', () => {
  it('buffers a flow offered before accept, attaches it on accept, and never drops it', async () => {
    const srcDir = await tmp(); const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });
    const data = new Uint8Array(4000).map((_, i) => (i * 31) & 0xff);
    await writeFile(join(srcDir, 'f.bin'), data);
    const entries = [{ fileId: 0, path: 'f.bin', size: data.length, mtime: 1 }];
    const manifest = { entries, totalBytes: data.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'f.bin')]]);

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 2 });
    const SESSION = 'r-buf-join';

    // A consent we control: block until we release it, so the receive sits PENDING.
    let releaseConsent; const consentGate = new Promise((r) => { releaseConsent = r; });
    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir,
      consent: async () => { await consentGate; return true; },
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 20,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: senderFlows, close: async () => {} }),
    });

    const jobId = 'd'.repeat(32);
    const recvPromise = receiverSvc.startReceive({ rendezvous: SESSION });
    await tick(10);
    const sendPromise = senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-buf', flowCount: 2 } });

    // While PENDING (consent not yet released), a racing rolling-join is
    // BUFFERED, not closed (F-B6 fix) — proven by the 'buffered' outcome below.
    await tick(10);
    let joinClosed = 0;
    const joinHandle = { channel: { onBulk: () => {}, sendCtrl: () => {} }, flowIndex: 5, close: async () => { joinClosed += 1; } };
    const outcome = receiverSvc.offerRollingJoin(SESSION, joinHandle, 5);
    expect(outcome).toBe('buffered');
    expect(joinClosed).toBe(0); // held, NOT dropped

    releaseConsent(); // human accepts → drain buffer, transfer runs
    const [sendResult, recvResult] = await Promise.all([sendPromise, recvPromise]);
    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    expect(joinClosed).toBe(1); // the buffered handle was retained + swept on teardown (no leak)

    // After teardown, a further offer is the ONE correct drop.
    let lateClosed = 0;
    const late = { channel: {}, flowIndex: 6, close: async () => { lateClosed += 1; } };
    expect(receiverSvc.offerRollingJoin(SESSION, late, 6)).toBe('dropped');
    await tick(5);
    expect(lateClosed).toBe(1);
  });

  // Review fix: the primary test above only exercises the accept path, where
  // pend.buffer is already empty by the time `finally` runs (the 'accepted'
  // handler already drained it) -- so it never actually proves the `finally`
  // leftover-close loop does anything. This pins that loop directly: consent
  // is gated, a rolling-join is offered while still PENDING, then consent
  // resolves FALSE (declined) -- the buffer is never drained by 'accepted'
  // (which never fires on a decline), so only the `finally` leftover-close
  // loop can close the buffered handle. Mutation-checked: deleting that loop
  // makes this fail (see task-2-report.md fix-report addendum).
  it('a declined (never-accepted) receive closes a buffered handle via the finally leftover-close loop, not a leak', async () => {
    const srcDir = await tmp(); const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });
    const data = new Uint8Array(1000).map((_, i) => (i * 13) & 0xff);
    await writeFile(join(srcDir, 'f.bin'), data);
    const entries = [{ fileId: 0, path: 'f.bin', size: data.length, mtime: 1 }];
    const manifest = { entries, totalBytes: data.length, totalFiles: 1 };
    const sources = new Map([[0, join(srcDir, 'f.bin')]]);

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 2 });
    const SESSION = 'r-buf-decline';

    // A consent we control: block until we release it, then DECLINE (false) --
    // 'accepted' never fires, so the drain-on-accept path never runs.
    let releaseConsent; const consentGate = new Promise((r) => { releaseConsent = r; });
    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir,
      consent: async () => { await consentGate; return false; },
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 20,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: senderFlows, close: async () => {} }),
    });

    const jobId = 'e'.repeat(32);
    const recvPromise = receiverSvc.startReceive({ rendezvous: SESSION });
    await tick(10);
    const sendPromise = senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-decline', flowCount: 2 } });

    await tick(10);
    let joinClosed = 0;
    const joinHandle = { channel: { onBulk: () => {}, sendCtrl: () => {} }, flowIndex: 5, close: async () => { joinClosed += 1; } };
    expect(receiverSvc.offerRollingJoin(SESSION, joinHandle, 5)).toBe('buffered');
    expect(joinClosed).toBe(0); // held, not yet closed

    releaseConsent(); // human declines -> 'accepted' never fires, receive tears down
    await Promise.allSettled([sendPromise, recvPromise]);
    await tick(30); // past receiveCloseGraceMs, teardown's finally has run

    expect(joinClosed).toBe(1); // swept by the finally leftover-close loop, not leaked
  });
});

// Final-review Important #2: transfer-service.js:891 computes
// jobStateForCompletion({ accepted, ok: result.ok }) at the multi-flow RECEIVE
// completion site, but until now nothing drove a real multi-flow receive to
// ok:false -- only the SEND side (above) was pinned. Forces a genuine terminal
// I/O failure with NO injection seam: createSparsePartFile's openPart does
// `mkdir(dirname(finalPath), { recursive: true })`, so pre-creating a plain
// FILE at the directory path makes that mkdir throw ENOTDIR every time. The
// receive-router (transfer-receive-router.js) retries the open+write with its
// default retryDelays ([150, 400]ms) and then gives up on that ONE file
// permanently (`terminal: true`) -- the other file in the manifest still
// finalizes normally, and the receive as a whole still resolves (not rejects)
// with ok:false once every file has reached a resolved state.
describe('Final-review Important #2: multi-flow RECEIVE completed_with_errors wiring (F-A4)', () => {
  it('one file terminally I/O-failed (blocked directory) -> receive resolves ok:false, the other file lands, and the recv record is completed_with_errors', async () => {
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const okContent = new Uint8Array(200).map((_, i) => (i * 11 + 1) & 0xff);
    const blockedContent = new Uint8Array(80).map((_, i) => (i * 5 + 2) & 0xff);
    await writeFile(join(srcDir, 'okfile.bin'), okContent);
    await mkdir(join(srcDir, 'blocked'), { recursive: true });
    await writeFile(join(srcDir, 'blocked', 'f.bin'), blockedContent);

    // The crux of the fixture: a plain FILE (not a directory) already sits at
    // dstDir/blocked, so the receiver's mkdir(dstDir/blocked, {recursive:true})
    // for 'blocked/f.bin' throws every time it's attempted.
    await writeFile(join(dstDir, 'blocked'), 'not a directory');

    const entries = [
      { fileId: 0, path: 'okfile.bin', size: okContent.length, mtime: 1 },
      { fileId: 1, path: 'blocked/f.bin', size: blockedContent.length, mtime: 1 },
    ];
    const manifest = { entries, totalBytes: okContent.length + blockedContent.length, totalFiles: 2 };
    const sources = new Map([
      [0, join(srcDir, 'okfile.bin')],
      [1, join(srcDir, 'blocked', 'f.bin')],
    ]);

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 2 });

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async () => ({ ctrl: receiverCtrl, flows: receiverFlows, close: async () => {} }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async () => ({ ctrl: senderCtrl, flows: senderFlows, close: async () => {} }),
    });

    const jobId = 'd'.repeat(32);
    const recvPromise = receiverSvc.startReceive({ rendezvous: 'r-mf-blocked' });
    await tick(10);
    const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-mf-blocked', flowCount: 2 } });
    const recvResult = await recvPromise;

    // The receive still resolves (terminal completion, never a hang/reject) --
    // just truthfully, with ok:false because one file never made it.
    expect(recvResult.ok).toBe(false);
    expect(sendResult.ok).toBe(false);

    // The unaffected file landed byte-identical...
    expect(Buffer.from(await readFile(join(dstDir, 'okfile.bin'))).equals(Buffer.from(okContent))).toBe(true);
    // ...and the blocked one never made it to disk (still blocked by the file at that path).
    await expect(readFile(join(dstDir, 'blocked', 'f.bin'))).rejects.toThrow();

    const recvRec = (await recvStore.list()).find((j) => j.jobId === jobId);
    expect(recvRec).toBeTruthy();
    expect(recvRec.jobState).toBe('completed_with_errors'); // F-A4: RECEIVE side, not just send
  }, 10000);
});

// Final-review #3: a phantom late group (a re-dial's TRANSFER_REQUEST arriving
// just after a receive tore down forms a fresh group whose sender is already
// gone) reaches runMultiFlowReceive with no OFFER ever coming. The `await
// jobIdKnown` was unbounded -> the receive hangs forever, leaking the attach
// worker's hidden BrowserWindow. The fix bounds it with a timeout that closes
// the attach worker(s) and rejects cleanly.
describe('Final-review #3: runMultiFlowReceive bounds await jobIdKnown', () => {
  function fakeClock() {
    let now = 0, id = 0; const timers = new Map();
    return {
      setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms }); return { __t: t, unref() {} }; },
      clearTimer: (h) => { if (h && h.__t) timers.delete(h.__t); },
      advance: async (ms) => { now += ms; for (const [t, e] of [...timers.entries()]) if (e.at <= now) { timers.delete(t); e.fn(); } await Promise.resolve(); },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('an OFFER that never arrives -> rejects (no_offer) after the timeout AND closes the attach worker(s)', async () => {
    const clk = fakeClock();
    let closeCount = 0;
    // ctrl registers the tap but NEVER emits a frame (no sender), flows never deliver.
    const ctrl = { sendCtrl() {}, onCtrl() {} };
    const flows = [{ onBulk() {} }, { onBulk() {} }];
    const svc = createTransferService({
      store: createJobsStore({ dir: await tmp() }), transferDir: await tmp(), consent: async () => true,
      openChannel: async () => ({ ctrl, flows, close: async () => { closeCount += 1; } }),
      receiveCloseGraceMs: 0, jobIdTimeoutMs: 10000, setTimer: clk.setTimer, clearTimer: clk.clearTimer,
    });

    const recvPromise = svc.startReceive({ rendezvous: { sessionId: 'phantom-group' } }).catch((e) => e.message);
    await flush(); await flush(); // openChannel resolved, jobIdKnown parked, timeout armed
    expect(closeCount).toBe(0);   // nothing settled/closed before the bound
    await clk.advance(10000);     // reach the jobId timeout
    expect(await recvPromise).toBe('no_offer');
    expect(closeCount).toBe(1);   // attach worker(s) closed, not leaked
  });

  it('mutation: without reaching the bound the receive stays pending (the timeout is what settles it)', async () => {
    const clk = fakeClock();
    let closeCount = 0;
    const ctrl = { sendCtrl() {}, onCtrl() {} };
    const flows = [{ onBulk() {} }];
    const svc = createTransferService({
      store: createJobsStore({ dir: await tmp() }), transferDir: await tmp(), consent: async () => true,
      openChannel: async () => ({ ctrl, flows, close: async () => { closeCount += 1; } }),
      receiveCloseGraceMs: 0, jobIdTimeoutMs: 10000, setTimer: clk.setTimer, clearTimer: clk.clearTimer,
    });
    let settled = false;
    svc.startReceive({ rendezvous: { sessionId: 'phantom-2' } }).then(() => { settled = true; }, () => { settled = true; });
    await flush(); await flush();
    await clk.advance(9999); // just under the bound
    await flush();
    expect(settled).toBe(false); // still hung -> proves the timeout (not something else) settles it
    expect(closeCount).toBe(0);
  });

  // Review fix (F-B6 follow-up): pins the jobId-timeout CATCH-path leak-close
  // loop specifically -- a flow offered while pending, on a receive that never
  // gets an OFFER at all (phantom group), must still be closed once `no_offer`
  // fires. Only the catch-path loop (not the `finally` one, not the drain-on-
  // accept path -- 'accepted' never fires here) can close it. Mutation-checked:
  // deleting that loop makes this fail (see task-2-report.md fix-report addendum).
  it('a buffered rolling-join is closed when the receive times out with no_offer (catch-path leak-close loop)', async () => {
    const clk = fakeClock();
    let closeCount = 0;
    const ctrl = { sendCtrl() {}, onCtrl() {} };
    const flows = [{ onBulk() {} }, { onBulk() {} }];
    const svc = createTransferService({
      store: createJobsStore({ dir: await tmp() }), transferDir: await tmp(), consent: async () => true,
      openChannel: async () => ({ ctrl, flows, close: async () => { closeCount += 1; } }),
      receiveCloseGraceMs: 0, jobIdTimeoutMs: 10000, setTimer: clk.setTimer, clearTimer: clk.clearTimer,
    });

    const recvPromise = svc.startReceive({ rendezvous: { sessionId: 'phantom-buf' } }).catch((e) => e.message);
    await flush(); await flush(); // openChannel resolved, receivePending registered, timeout armed

    let joinClosed = 0;
    const joinHandle = { channel: {}, flowIndex: 5, close: async () => { joinClosed += 1; } };
    expect(svc.offerRollingJoin('phantom-buf', joinHandle, 5)).toBe('buffered');
    expect(joinClosed).toBe(0); // held, not yet closed

    await clk.advance(10000); // reach the jobId timeout -> no_offer
    expect(await recvPromise).toBe('no_offer');
    expect(joinClosed).toBe(1); // swept by the catch-path leak-close loop, not leaked
  });
});
