import { describe, it, expect } from 'vitest';
import { capIvals, batchReportFiles } from '../src/transfer-report-batch.js';
import { rangeReportFrame } from '../src/transfer-protocol.js';

describe('capIvals (byte-bounded)', () => {
  it('returns all runs when they fit', () => {
    expect(capIvals(0, [[0, 10], [20, 30]], 1000)).toEqual([[0, 10], [20, 30]]);
  });
  it('drops the smallest runs to fit the byte budget, ascending, never over-reporting', () => {
    const ivals = [[0, 2], [10, 40], [50, 55]]; // lengths 2, 30, 5
    const capped = capIvals(0, ivals, 40); // tight budget → keep largest run(s) only
    // must be a subset of the input, ascending, and never widen a run
    expect(capped.every((iv) => ivals.some((o) => o[0] === iv[0] && o[1] === iv[1]))).toBe(true);
    for (let i = 1; i < capped.length; i++) expect(capped[i][0]).toBeGreaterThanOrEqual(capped[i - 1][1]);
    expect(JSON.stringify({ fileId: 0, ivals: capped }).length).toBeLessThanOrEqual(40 + 20);
  });
});

describe('batchReportFiles (byte-bounded)', () => {
  it('splits files across frames and every emitted range_report stays under 256KB (worst case)', () => {
    const files = [];
    for (let fi = 0; fi < 100; fi++) {
      const ivals = [];
      for (let k = 0; k < 500; k++) { const base = k * 2 * 1_000_000_000; ivals.push([base, base + 1_000_000_000]); }
      files.push({ fileId: fi, ivals });
    }
    const frames = batchReportFiles(files, { maxBytes: 200000 });
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      const wire = rangeReportFrame({ jobId: 'a'.repeat(32), files: frame });
      expect(wire.length).toBeLessThanOrEqual(256 * 1024);
    }
  });
  it('empty input still yields one (empty) frame so a report always fires', () => {
    expect(batchReportFiles([], {})).toEqual([[]]);
  });
});
