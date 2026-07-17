// In-memory, no-Electron/no-WebRTC loopback: proves Tasks 1-8 wire together to
// stripe a file across N fake flows, reassemble it byte-identical, and recover
// from a deterministic mid-transfer byte-range loss via reconciliation.
//
// NOTE on the drop simulation (see task-9 brief vs. the send-pool redesign):
// createSendPool now dispatches each chunk to whichever live flow is currently
// IDLE (true N-way concurrency) and RETIRES any flow whose sendBulk() rejects
// (its chunk is re-dispatched to a surviving flow within the same run). That
// means "make flow #2 always drop" is no longer a valid way to simulate lost
// bytes: (a) a rejecting flow gets retired and its chunk redelivered in-run, so
// nothing would actually go missing, and (b) which physical flow a given chunk
// lands on is scheduling-dependent, not deterministic. So instead of dropping
// per-flow, round 1 wraps the DELIVERY side: every flow's sendBulk resolves
// (as if the bytes left the sender fine) but frames whose decoded byte-offset
// falls inside a fixed middle slice of the file are silently discarded before
// they reach the router (simulating "a flow died with those bytes still
// buffered, never delivered to the peer"). This is deterministic regardless of
// which flow carried which chunk. Round 2 delivers everything to the real
// router, so reconciliation has a known, reproducible gap to refill.
import { describe, it, expect } from 'vitest';
import { decodeBulkFrame } from '../src/transfer-chunk.js';
import { createChunkProducer } from '../src/transfer-producer.js';
import { createSendPool } from '../src/transfer-send-pool.js';
import { createReceiveRouter } from '../src/transfer-receive-router.js';
import { createCoverageTracker } from '../src/transfer-reconcile.js';
import { createRangeSet } from '../src/transfer-ranges.js';

// N flows, all "alive", each forwarding encoded frames to `deliver`.
function makeFlows(count, deliver) {
  return Array.from({ length: count }, () => ({
    isAlive: () => true,
    async sendBulk(buf) {
      await deliver(buf);
    },
  }));
}

describe('multi-flow loopback', () => {
  it('stripes a file across flows and reassembles byte-identical', async () => {
    const size = 4096 * 7 + 123; // multi-chunk, non-aligned tail
    const src = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
    const dest = new Uint8Array(size);
    const router = createReceiveRouter({
      manifest: { entries: [{ fileId: 0, size }] },
      openPart: () => Promise.resolve({
        writeAt: (off, b) => { dest.set(b, off); return Promise.resolve(); },
        close: () => Promise.resolve(),
      }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onFileDone: () => {},
      onProgress: () => {},
    });

    const flows = makeFlows(4, (buf) => router.onBulkFrame(buf));
    const producer = createChunkProducer({
      readChunk: (o, l) => Promise.resolve(src.subarray(o, o + l)),
      hashUpdate: () => {},
      chunkSize: 4096,
    });

    await createSendPool({ flows }).run(producer.produce({ fileId: 0, size }, createRangeSet()));
    await router.onFileHash(0, 'H');

    expect(router.isComplete()).toBe(true);
    expect(Buffer.from(dest).equals(Buffer.from(src))).toBe(true);
  });

  it('recovers from a dropped middle byte-range, via reconciliation', async () => {
    const size = 4096 * 8; // 8 aligned chunks
    const src = new Uint8Array(size).map((_, i) => (i * 17) & 0xff);
    const dest = new Uint8Array(size);
    const router = createReceiveRouter({
      manifest: { entries: [{ fileId: 0, size }] },
      openPart: () => Promise.resolve({
        writeAt: (off, b) => { dest.set(b, off); return Promise.resolve(); },
        close: () => Promise.resolve(),
      }),
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      onFileDone: () => {},
      onProgress: () => {},
    });

    // Deterministic drop: chunks 2 and 3 (bytes [8192, 16384)) — a middle slice —
    // never reach the router in round 1, regardless of which flow carried them.
    const dropStart = 4096 * 2;
    const dropEnd = 4096 * 4;
    const deliverDropping = (buf) => {
      const d = decodeBulkFrame(buf);
      if (d && d.offset >= dropStart && d.offset < dropEnd) return Promise.resolve(); // lost
      return router.onBulkFrame(buf);
    };
    const deliverAll = (buf) => router.onBulkFrame(buf);

    const tracker = createCoverageTracker({ manifest: { entries: [{ fileId: 0, size }] } });

    // Round 1: initial dispatch; the middle range is silently lost in transit.
    const flowsRound1 = makeFlows(4, deliverDropping);
    const p1 = createChunkProducer({
      readChunk: (o, l) => Promise.resolve(src.subarray(o, o + l)),
      hashUpdate: () => {},
      chunkSize: 4096,
    });
    await createSendPool({ flows: flowsRound1 }).run(p1.produce({ fileId: 0, size }, createRangeSet()));

    tracker.applyReport(router.rangesFor());
    expect(tracker.isComplete()).toBe(false); // the dropped range is a real gap

    // Round 2: re-dispatch ONLY the gaps (per tracker.coveredFor), this time
    // delivered in full — no drop. Record each delivered chunk's offset to verify
    // that ONLY the gap offsets are resent (not the whole file).
    const round2Offsets = [];
    const deliverAllWithRecording = (buf) => {
      const d = decodeBulkFrame(buf);
      if (d) round2Offsets.push(d.offset);
      return router.onBulkFrame(buf);
    };
    const flowsRound2 = makeFlows(4, deliverAllWithRecording);
    const p2 = createChunkProducer({
      readChunk: (o, l) => Promise.resolve(src.subarray(o, o + l)),
      hashUpdate: () => {},
      chunkSize: 4096,
    });
    await createSendPool({ flows: flowsRound2 }).run(p2.produce({ fileId: 0, size }, tracker.coveredFor(0)));

    // Verify round 2 sent ONLY the gap chunks (offsets 8192 and 12288), not the whole file.
    expect([...new Set(round2Offsets)].sort((a, b) => a - b)).toEqual([8192, 12288]);

    tracker.applyReport(router.rangesFor());
    expect(tracker.isComplete()).toBe(true); // gap refilled

    await router.onFileHash(0, 'H');
    expect(router.isComplete()).toBe(true);
    expect(Buffer.from(dest).equals(Buffer.from(src))).toBe(true);
  });
});
