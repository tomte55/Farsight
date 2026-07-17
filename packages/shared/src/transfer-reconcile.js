// The SENDER's model of what the RECEIVER has confirmed on disk, updated from
// range_report snapshots. Drives (a) which chunks to skip/send and (b) when the
// whole job is truly delivered — completion is coverage-defined, NOT queue-defined,
// so a chunk lost when a flow died is re-dispatched until the receiver confirms it.
import { createRangeSet } from './transfer-ranges.js';

export function createCoverageTracker({ manifest }) {
  const sizes = new Map(manifest.entries.map((e) => [e.fileId, e.size]));
  const cover = new Map(manifest.entries.map((e) => [e.fileId, createRangeSet()]));

  return {
    applyReport(files) {
      for (const f of files || []) {
        if (!sizes.has(f.fileId)) continue;
        cover.set(f.fileId, createRangeSet(f.ivals || [])); // full snapshot: replace
      }
    },
    coveredFor(fileId) { return cover.get(fileId); },
    gapsFor(fileId) { return cover.get(fileId).gaps(sizes.get(fileId)); },
    isComplete() {
      for (const [fileId, size] of sizes) if (!cover.get(fileId).isComplete(size)) return false;
      return true;
    },
    pendingFiles() {
      const out = [];
      for (const [fileId, size] of sizes) if (!cover.get(fileId).isComplete(size)) out.push({ fileId, size });
      return out;
    },
  };
}
