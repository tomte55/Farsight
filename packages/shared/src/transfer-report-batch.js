// packages/shared/src/transfer-report-batch.js
// Bound a range_report to the data-channel message limit. applyReport REPLACES a
// file's coverage, so one file's ivals must never be split across frames — instead
// we (a) cap a single file's interval count (dropping the smallest covered runs,
// which just get re-sent — harmless positional overwrite, never over-reports), and
// (b) split the FILE SET across multiple frames (each a valid full-snapshot subset).
export function capIvals(ivals, maxIntervals) {
  if (!Array.isArray(ivals) || ivals.length <= maxIntervals) return ivals;
  return [...ivals]
    .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])) // largest runs first
    .slice(0, maxIntervals)
    .sort((a, b) => a[0] - b[0]);                   // back to ascending
}

export function batchReportFiles(files, { maxFilesPerFrame = 64, maxIntervalsPerFile = 256 } = {}) {
  const capped = files.map((f) => ({ fileId: f.fileId, ivals: capIvals(f.ivals, maxIntervalsPerFile) }));
  const out = [];
  for (let i = 0; i < capped.length; i += maxFilesPerFrame) out.push(capped.slice(i, i + maxFilesPerFrame));
  return out.length ? out : [[]];
}
