// Pure receive-side routing for the multi-flow transfer: each self-addressed bulk
// frame is written positionally by offset (chunks may arrive in any order, on any
// flow) and its range recorded. A file finalizes (verify+fsync+rename) once its
// ranges cover [0,size) AND its file_end hash has arrived. NO fs/DOM (injected).
import { decodeBulkFrame } from './transfer-chunk.js';
import { createRangeSet } from './transfer-ranges.js';

export function createReceiveRouter({ manifest, initialRanges = {}, openPart, verifyAndFinalize, onFileDone, onProgress }) {
  const files = new Map(); // fileId -> { size, ranges, part, hash, finalized, finalizing }
  for (const e of manifest.entries) {
    files.set(e.fileId, { size: e.size, ranges: createRangeSet(initialRanges[e.fileId] || []), part: null, partPromise: null, hash: null, finalized: false, finalizing: false });
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
    async onBulkFrame(buf) {
      const d = decodeBulkFrame(buf);
      if (!d) return;
      const f = files.get(d.fileId);
      if (!f || f.finalized) return;
      if (!f.partPromise) f.partPromise = openPart(d.fileId);
      f.part = await f.partPromise;
      await f.part.writeAt(d.offset, d.payload);
      f.ranges.add(d.offset, d.length);
      onProgress && onProgress({ fileId: d.fileId, coveredBytes: f.ranges.coveredBytes(), size: f.size });
      await maybeFinalize(d.fileId);
    },
    async onFileHash(fileId, hash) {
      const f = files.get(fileId);
      if (!f || f.finalized) return;
      f.hash = hash;
      await maybeFinalize(fileId);
    },
    rangesFor() {
      const out = [];
      for (const [fileId, f] of files) if (!f.finalized) out.push({ fileId, ivals: f.ranges.toJSON() });
      return out;
    },
    isComplete() {
      for (const f of files.values()) if (!f.finalized) return false;
      return true;
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
  };
}
