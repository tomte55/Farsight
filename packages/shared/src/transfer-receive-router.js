// Pure receive-side routing for the multi-flow transfer: each self-addressed bulk
// frame is written positionally by offset (chunks may arrive in any order, on any
// flow) and its range recorded. A file finalizes (verify+fsync+rename) once its
// ranges cover [0,size) AND its file_end hash has arrived. NO fs/DOM (injected).
import { decodeBulkFrame, TRANSFER_CHUNK_BYTES } from './transfer-chunk.js';
import { createRangeSet } from './transfer-ranges.js';
import { createHash } from 'node:crypto';

export function createReceiveRouter({
  manifest, initialRanges = {}, openPart, verifyAndFinalize, onFileDone, onProgress,
  // Phase 4: per-chunk hash function (hex), injectable (default real SHA-256). Used
  // to verify each chunk before it is added to coverage, so persisted coverage means
  // "verified" and a resume can trust it without re-hashing.
  hashChunk = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  // Per-file I/O failure isolation (e.g. AV locking/quarantining a .part mid-write):
  // a bounded, brief, ONE-TIME retry of the open+write for THIS file before giving
  // up on it. Injectable so a test can prove the retry without real timers/delays.
  retryDelays = [150, 400],
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const files = new Map(); // fileId -> { size, ranges, part, hash, finalized, finalizing, failed, chunkBytes, chunkHashes, hashesFinal, pendingVerify }
  for (const e of manifest.entries) {
    files.set(e.fileId, { size: e.size, ranges: createRangeSet(initialRanges[e.fileId] || []), part: null, partPromise: null, hash: null, finalized: false, finalizing: false, failed: false,
      chunkBytes: null, chunkHashes: null, hashesFinal: false, pendingVerify: new Set() });
  }

  // Ensure a file's .part handle is open (memoized) — for a read-back verify when a
  // chunk arrived before its hash, or for the finalize locate (Task 6). Mirrors
  // onBulkFrame's memoized open.
  async function partOf(f, fileId) {
    if (!f.partPromise) f.partPromise = openPart(fileId);
    f.part = await f.partPromise;
    return f.part;
  }

  // Best-effort close of a file's currently-open .part handle before nulling
  // it out. Nulling alone (the pre-fix behavior) leaks the fd/handle on the
  // "open succeeded but a later writeAt failed" variant — up to 3 handles
  // across the retry loop plus the terminal give-up, kept open until app quit
  // and, on Windows, keeping the exact contended file LOCKED (the opposite of
  // what this feature wants). close() failing (e.g. the same AV lock that
  // caused the write to fail) must not block giving up on the file.
  async function closeAndClearPart(f) {
    try { await f.part?.close(); } catch { /* best effort */ }
    f.part = null;
    f.partPromise = null;
  }

  // Phase 4 verify-before-add: coverage MEANS "verified". A chunk enters the
  // RangeSet only after its bytes match the manifest hash for its grid index. When
  // hashes aren't known yet (the ctrl/bulk race — file_hashes rides ctrl, bulk rides
  // the bulk flows, independently ordered — or an old sender that never sends them),
  // add optimistically and, if hashes may still arrive, remember the chunk so
  // setChunkHashes can retro-verify it. NEVER folds a running whole-file hash (the
  // at-least-once contract forbids it — transfer-chunk.js); each chunk hashes alone.
  function addVerifiedChunk(f, offset, length, payload) {
    const cb = f.chunkBytes || TRANSFER_CHUNK_BYTES;
    const aligned = offset % cb === 0;
    if (f.chunkHashes && aligned) {
      const idx = offset / cb;
      const expected = f.chunkHashes[idx];
      const expectedLen = Math.min(cb, f.size - offset);
      if (expected !== undefined && length === expectedLen) {
        if (hashChunk(payload) === expected) f.ranges.add(offset, length);
        return; // mismatch -> NOT added (stays a gap, re-requested by range_report)
      }
    }
    f.ranges.add(offset, length); // no usable hash yet / off-grid frame: optimistic add
    // Remember the raw OFFSET (not an index): the real chunk grid is unknown until
    // file_hashes arrives, so we can't compute a stable index yet.
    if (!f.hashesFinal) f.pendingVerify.add(offset);
  }

  async function maybeFinalize(fileId) {
    const f = files.get(fileId);
    if (!f || f.finalized || f.finalizing) return;
    if (f.hash == null || !f.ranges.isComplete(f.size)) return;
    f.finalizing = true;
    let r;
    try {
      if (f.part) await f.part.close();
      r = await verifyAndFinalize({ fileId, expectedHash: f.hash });
    } catch (e) {
      // A verify/finalize throw must NOT wedge the file: clear finalizing so a later
      // retry (Plan 2 re-fetch) can re-run this. Do NOT mark finalized.
      f.finalizing = false;
      throw e;
    }
    if (r && r.ok) {
      f.finalized = true;
      onFileDone && onFileDone({ fileId, ok: true });
    } else {
      // Verification FAILED: the bytes are all present but wrong. Do NOT mark the file
      // finalized (so isComplete() correctly stays false and does not report success on a
      // corrupt file); clear finalizing so a Plan-2 re-fetch can re-verify. Surface ok:false.
      f.finalizing = false;
      onFileDone && onFileDone({ fileId, ok: false });
    }
  }

  return {
    // Memoized openPart makes concurrent first-frames for the same not-yet-opened file safe.
    // At-least-once delivery: the SAME (fileId,offset) chunk can arrive more than
    // once (a dead flow's requeued chunk — see transfer-chunk.js). That's safe here
    // BY DESIGN — writeAt overwrites identical bytes at the same offset, and
    // f.ranges.add() coalesces so coveredBytes() can't double-count. Keep it that
    // way: don't add per-frame counters or streaming-hash folds that assume
    // exactly-once.
    async onBulkFrame(buf) {
      const d = decodeBulkFrame(buf);
      if (!d) return;
      const f = files.get(d.fileId);
      // A `failed` file is TERMINAL, same as `finalized`: ignore further frames
      // for it rather than re-attempting an I/O path already given up on.
      if (!f || f.finalized || f.failed) return;

      const attemptWrite = async () => {
        if (!f.partPromise) f.partPromise = openPart(d.fileId);
        f.part = await f.partPromise;
        await f.part.writeAt(d.offset, d.payload);
      };

      // Isolate a persistent open/write failure (real case: Windows AV locking/
      // quarantining a `setup.exe.part`) to THIS FILE ONLY — it must never
      // escape onBulkFrame and fail the whole receive (that used to trigger
      // auto-resume -> the same file fails again -> infinite loop). Retry
      // bounded + brief (one-time per delivered frame): if it still fails after
      // retryDelays are exhausted, give up on this file permanently.
      let lastErr = null;
      try {
        await attemptWrite();
      } catch (e) {
        lastErr = e;
        for (const ms of retryDelays) {
          await closeAndClearPart(f); // close before a fresh open on retry — the prior open may have succeeded even though writeAt failed
          await delay(ms);
          try {
            await attemptWrite();
            lastErr = null;
            break;
          } catch (e2) {
            lastErr = e2;
          }
        }
      }

      if (lastErr) {
        f.failed = true;
        await closeAndClearPart(f);
        onFileDone && onFileDone({ fileId: d.fileId, ok: false, terminal: true });
        return; // NOT rethrown — the receive must not fail because of one file
      }

      addVerifiedChunk(f, d.offset, d.length, d.payload);
      onProgress && onProgress({ fileId: d.fileId, coveredBytes: f.ranges.coveredBytes(), size: f.size });
      await maybeFinalize(d.fileId);
    },
    async onFileHash(fileId, hash) {
      const f = files.get(fileId);
      if (!f || f.finalized || f.failed) return;
      f.hash = hash;
      await maybeFinalize(fileId);
    },
    // Phase 4: receive a file's per-chunk hash manifest (reassembled by the
    // receiver from file_hashes_begin/entries/end). Records the digests so
    // subsequent bulk frames verify-before-add, and retro-verifies any chunk that
    // already landed before the hashes did (the ctrl/bulk race) — re-reading it
    // from the .part and removing it from coverage if it doesn't match.
    async setChunkHashes(fileId, chunkBytes, hashes) {
      const f = files.get(fileId);
      if (!f || f.finalized || f.failed) return;
      f.chunkBytes = chunkBytes; f.chunkHashes = hashes; f.hashesFinal = true;
      let changed = false;
      const pending = [...f.pendingVerify]; f.pendingVerify.clear();
      if (pending.length) {
        const part = await partOf(f, fileId);
        for (const off of pending) {
          if (off % chunkBytes !== 0) continue; // off-grid frame: can't map to a chunk hash -> leave as-added
          const idx = off / chunkBytes; const len = Math.min(chunkBytes, f.size - off);
          if (len <= 0) continue;
          const expected = hashes[idx];
          if (expected === undefined) continue; // no hash for this index -> leave as-added
          const bytes = await part.readAt(off, len);
          if (hashChunk(bytes) !== expected) { f.ranges.remove(off, len); changed = true; }
        }
      }
      if (changed) onProgress && onProgress({ fileId, coveredBytes: f.ranges.coveredBytes(), size: f.size });
      await maybeFinalize(fileId);
    },
    rangesFor() {
      const out = [];
      for (const [fileId, f] of files) if (!f.finalized && !f.failed) out.push({ fileId, ivals: f.ranges.toJSON() });
      return out;
    },
    // Covered-bytes for ONE file, finalized or not — lets a caller (the
    // multi-flow receiver driver) build an aggregate progress figure without
    // reconstructing it from rangesFor() (which omits finalized files entirely).
    // A terminally-failed file counts as fully "covered" too — it's RESOLVED
    // (won't receive any more bytes), so aggregate progress should reach 100%
    // rather than being permanently short by that file's size.
    coveredBytesFor(fileId) {
      const f = files.get(fileId);
      if (!f) return 0;
      return (f.finalized || f.failed) ? f.size : f.ranges.coveredBytes();
    },
    // A file counts as RESOLVED once it's either finalized (verified+written)
    // OR terminally failed (I/O give-up after bounded retries) — the receive as
    // a whole is complete once every file has reached one of these two states,
    // so one un-writable file (e.g. AV-locked) can no longer wedge the others.
    isComplete() {
      for (const f of files.values()) if (!f.finalized && !f.failed) return false;
      return true;
    },
    // Which files gave up permanently (terminal I/O failure) — lets a caller
    // report+record them (e.g. the multi-flow receiver driver's reportFiles()/
    // jobs-store perFile) without re-deriving this from onFileDone events.
    failedFiles() {
      const out = new Set();
      for (const [fileId, f] of files) if (f.failed) out.add(fileId);
      return out;
    },
    async resetFile(fileId) {
      const f = files.get(fileId);
      if (!f || f.finalized) return;
      if (f.part) { try { await f.part.close(); } catch { /* best effort */ } }
      f.part = null;
      f.partPromise = null;
      f.hash = null;
      f.finalizing = false;
      f.ranges = createRangeSet();
    },
    // Fd-leak fix: release every file's open .part handle when a multi-flow
    // receive settles WITHOUT every file finalizing (canceled/stalled/errored)
    // — a finalized file already closed its own part in maybeFinalize (and left
    // `f.part` pointing at the now-closed handle, not null), so this skips
    // those and only closes ones still genuinely open. Best-effort (mirrors
    // resetFile): a close() failure must not stop the rest from releasing.
    // Nulls part/partPromise so a stray later access reopens rather than
    // touching a closed handle, and so a second closeAll() call is a no-op
    // (idempotent — safe to call from more than one settle path).
    async closeAll() {
      for (const f of files.values()) {
        if (f.part && !f.finalized) {
          try { await f.part.close(); } catch { /* best effort */ }
          f.part = null;
          f.partPromise = null;
        }
      }
    },
  };
}
