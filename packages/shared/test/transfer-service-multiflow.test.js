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

const dirs = [];
async function tmp() { const d = await mkdtemp(join(tmpdir(), 'ftsvc-mf-')); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

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
});
