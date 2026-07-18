// packages/shared/test/transfer-report-batch.test.js
import { describe, it, expect } from 'vitest';
import { capIvals, batchReportFiles } from '../src/transfer-report-batch.js';

describe('capIvals', () => {
  it('returns ivals unchanged under the cap', () => {
    expect(capIvals([[0, 10], [20, 30]], 4)).toEqual([[0, 10], [20, 30]]);
  });
  it('keeps the largest intervals (ascending) and drops the rest, never over-reporting', () => {
    // lengths: [0,2)=2, [10,40)=30, [50,55)=5 → keep the 2 largest: [10,40) and [50,55)
    expect(capIvals([[0, 2], [10, 40], [50, 55]], 2)).toEqual([[10, 40], [50, 55]]);
  });
});

describe('batchReportFiles', () => {
  it('caps ivals per file and splits files across frames', () => {
    const files = [
      { fileId: 0, ivals: [[0, 1], [2, 3], [4, 5]] },
      { fileId: 1, ivals: [[0, 100]] },
      { fileId: 2, ivals: [[0, 10]] },
    ];
    const frames = batchReportFiles(files, { maxFilesPerFrame: 2, maxIntervalsPerFile: 2 });
    expect(frames.length).toBe(2);                 // 3 files / 2 per frame
    expect(frames[0].length).toBe(2);
    expect(frames[1].length).toBe(1);
    expect(frames[0][0].ivals.length).toBeLessThanOrEqual(2); // file 0 capped
  });
});
