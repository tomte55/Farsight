// Pure receive-side routing for the multi-flow transfer: each self-addressed bulk
// frame is written positionally by offset (chunks may arrive in any order, on any
// flow) and its range recorded. A file finalizes (verify+fsync+rename) once its
// ranges cover [0,size) AND its file_end hash has arrived. NO fs/DOM (injected).
import { decodeBulkFrame } from './transfer-chunk.js';
import { createRangeSet } from './transfer-ranges.js';

export function createReceiveRouter({ manifest, initialRanges = {}, openPart, verifyAndFinalize, onFileDone, onProgress }) {
  const files = new Map(); // fileId -> { size, ranges, part, hash, finalized, finalizing }
  for (const e of manifest.entries) {
    files.set(e.fileId, { size: e.size, ranges: createRangeSet(initialRanges[e.fileId] || []), part: null, hash: null, finalized: false, finalizing: false });
  }

  async function maybeFinalize(fileId) {
    const f = files.get(fileId);
    if (!f || f.finalized || f.finalizing) return;
    if (f.hash == null || !f.ranges.isComplete(f.size)) return;
    f.finalizing = true;
    if (f.part) await f.part.close();
    const r = await verifyAndFinalize({ fileId, expectedHash: f.hash });
    f.finalized = true;
    onFileDone && onFileDone({ fileId, ok: !!(r && r.ok) });
  }

  return {
    async onBulkFrame(buf) {
      const d = decodeBulkFrame(buf);
      if (!d) return;
      const f = files.get(d.fileId);
      if (!f || f.finalized) return;
      if (!f.part) f.part = await openPart(d.fileId);
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
  };
}
