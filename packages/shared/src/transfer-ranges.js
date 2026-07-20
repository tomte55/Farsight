// Pure coalesced interval set of received byte ranges for the multi-flow transfer.
// Half-open [start, end). Replaces size-based resume: a file is complete when its
// ranges cover [0, size). NO fs/DOM. add() coalesces overlaps, so re-adding an
// already-covered range is a no-op — this is what makes at-least-once delivery
// safe: a dead flow's requeued chunk (see transfer-chunk.js) can re-add the same
// range without inflating coveredBytes(). Keep add()/coveredBytes() idempotent.
export function createRangeSet(intervals = []) {
  // Normalize input into sorted, coalesced [start,end) pairs.
  let ivals = normalize(intervals.map(([s, e]) => [s, e]));

  function normalize(list) {
    const arr = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [s, e] of arr) {
      const last = out[out.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e); // overlap or touch
      else out.push([s, e]);
    }
    return out;
  }

  return {
    add(offset, length) {
      if (!(length > 0)) return;
      ivals = normalize([...ivals, [offset, offset + length]]);
    },
    // Subtract [offset, offset+length) from coverage — the inverse of add().
    // Phase 4 uses this to PUNCH a hole for a chunk that was covered but is later
    // found bad (retro-verify race, or a finalize-mismatch locate), so the normal
    // report->gap->resend loop re-drives only that chunk. Preserves sorted+disjoint
    // order (subtraction can only shrink/split intervals, never merge), so no
    // re-normalize is needed.
    remove(offset, length) {
      if (!(length > 0)) return;
      const rs = offset, re = offset + length;
      const out = [];
      for (const [s, e] of ivals) {
        if (e <= rs || s >= re) { out.push([s, e]); continue; } // no overlap: keep
        if (s < rs) out.push([s, rs]);                          // left remainder
        if (e > re) out.push([re, e]);                          // right remainder
      }
      ivals = out;
    },
    covers(offset, length) {
      if (length <= 0) return true;
      const end = offset + length;
      for (const [s, e] of ivals) if (s <= offset && e >= end) return true;
      return false;
    },
    coveredBytes() {
      let n = 0;
      for (const [s, e] of ivals) n += e - s;
      return n;
    },
    isComplete(size) {
      if (size === 0) return true;
      for (const [s, e] of ivals) if (s <= 0 && e >= size) return true;
      return false;
    },
    gaps(size) {
      const out = [];
      let cursor = 0;
      for (const [s, e] of ivals) {
        if (s > cursor) out.push({ offset: cursor, length: Math.min(s, size) - cursor });
        cursor = Math.max(cursor, e);
        if (cursor >= size) break;
      }
      if (cursor < size) out.push({ offset: cursor, length: size - cursor });
      return out.filter((g) => g.length > 0);
    },
    toJSON() {
      return ivals.map(([s, e]) => [s, e]);
    },
  };
}
