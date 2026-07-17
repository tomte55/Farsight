import { describe, it, expect } from 'vitest';
import { createCoverageTracker } from '../src/transfer-reconcile.js';

const manifest = { entries: [{ fileId: 0, size: 100 }, { fileId: 1, size: 50 }] };

describe('transfer-reconcile', () => {
  it('is incomplete until every file is fully covered', () => {
    const t = createCoverageTracker({ manifest });
    expect(t.isComplete()).toBe(false);
    t.applyReport([{ fileId: 0, ivals: [[0, 100]] }, { fileId: 1, ivals: [[0, 50]] }]);
    expect(t.isComplete()).toBe(true);
  });

  it('a report is a full snapshot and drives gap computation', () => {
    const t = createCoverageTracker({ manifest });
    t.applyReport([{ fileId: 0, ivals: [[0, 40], [60, 100]] }]);
    expect(t.gapsFor(0)).toEqual([{ offset: 40, length: 20 }]);
    expect(t.pendingFiles().map((f) => f.fileId)).toEqual([0, 1]); // file 1 has no coverage yet
  });

  it('a later report replaces (not merges) prior coverage for that file', () => {
    const t = createCoverageTracker({ manifest });
    t.applyReport([{ fileId: 0, ivals: [[0, 100]] }]);
    t.applyReport([{ fileId: 0, ivals: [[0, 30]] }]); // receiver re-reported less (unusual, but must be respected)
    expect(t.gapsFor(0)).toEqual([{ offset: 30, length: 70 }]);
  });
});
