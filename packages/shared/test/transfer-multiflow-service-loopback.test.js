// packages/shared/test/transfer-multiflow-service-loopback.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSender, createReceiver } from '../src/transfer-orchestrator.js';
import { createSparsePartFile, openSourceReader, finalizeReceivedFile } from '../src/transfer-io.js';

let srcDir, dstDir;
beforeEach(async () => { srcDir = await mkdtemp(join(tmpdir(), 'mf-src-')); dstDir = await mkdtemp(join(tmpdir(), 'mf-dst-')); });
afterEach(async () => { await rm(srcDir, { recursive: true, force: true }); await rm(dstDir, { recursive: true, force: true }); });

// In-memory duplex wiring: N flows, sender.sendBulk(i) → receiver.flows round-robin onBulk.
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
      // deterministic drop by a key derived from the frame's bytes (offset), first time only
      const key = `${new DataView(buf).getUint32(0)}:${Number(new DataView(buf).getBigUint64(4))}`;
      const target = rxFlowCbs[(rr++) % rxFlowCbs.length];
      if (!dropped.has(key)) target(buf); else dropped.delete(key);
      return Promise.resolve();
    },
  }));
  const receiverFlows = Array.from({ length: flowCount }, () => ({ onBulk: (cb) => rxFlowCbs.push(cb) }));
  return { senderCtrl, receiverCtrl, senderFlows, receiverFlows };
}

describe('multi-flow service loopback (real disk)', () => {
  it('stripes a big file + small files across flows, drops a chunk, resumes, lands byte-identical', async () => {
    const JOB = 'a'.repeat(32);
    // one big file (multi-chunk) + two small
    const big = new Uint8Array(131072 * 3 + 111).map((_, i) => (i * 31) & 0xff);
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
    const absOf = { 0: join(srcDir, 'big.bin'), 1: join(srcDir, 's1.bin'), 2: join(srcDir, 's2.bin') };

    const { senderCtrl, receiverCtrl, senderFlows, receiverFlows } = link({ flowCount: 4, dropFirst: [`0:131072`] });

    const receiver = createReceiver({
      ctrl: receiverCtrl, flows: receiverFlows, jobId: JOB,
      consent: async () => true,
      openPart: (relPath) => createSparsePartFile({ destRoot: dstDir, relPath }),
      verifyAndFinalize: ({ fileId, expectedHash, partFile }) => finalizeReceivedFile({ partFile, expectedHash, mtime: entries.find((e) => e.fileId === fileId).mtime }),
      reportIntervalMs: 40,
    });
    const sender = createSender({
      ctrl: senderCtrl, flows: senderFlows, jobId: JOB, manifest, chunkSize: 131072, flowCount: 4, groupId: 'b'.repeat(32),
      readerFor: (fileId) => { let rp; return { readAt: async (o, l) => { rp = rp || await openSourceReader(absOf[fileId]); return rp.readAt(o, l); }, close: async () => { if (rp) await rp.close(); } }; },
    });

    const rDone = receiver.start();
    const sDone = sender.start();
    const [sr] = await Promise.all([sDone, rDone]);
    expect(sr.ok).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 'big.bin'))).equals(Buffer.from(big))).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 's1.bin'))).equals(Buffer.from(s1))).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 's2.bin'))).equals(Buffer.from(s2))).toBe(true);
  });
});
