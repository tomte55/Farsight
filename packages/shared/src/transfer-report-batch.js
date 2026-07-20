// packages/shared/src/transfer-report-batch.js
// Bound a range_report to the data-channel message limit by MEASURED serialized
// bytes (mirroring transfer-sender.js's batchEntriesBySize used for the OFFER).
// applyReport REPLACES a file's coverage, so one file's ivals is never split across
// frames — instead capIvals drops the SMALLEST covered runs of an over-budget file
// (those bytes just get re-sent — harmless positional overwrite, never over-reports),
// and files are packed into frames each under maxBytes.

// Keep the largest covered runs of one file that fit within maxBytes of serialized
// size; drop the smallest (they become gaps → re-sent). Always keeps >= 1 run.
export function capIvals(fileId, ivals, maxBytes) {
  if (!Array.isArray(ivals) || ivals.length === 0) return [];
  const header = JSON.stringify({ fileId, ivals: [] }).length;
  const sorted = [...ivals].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])); // largest runs first
  const kept = [];
  let len = header;
  for (const iv of sorted) {
    const add = JSON.stringify(iv).length + (kept.length ? 1 : 0); // + joining comma
    if (kept.length && len + add > maxBytes) break;
    kept.push(iv); len += add;
  }
  return kept.sort((a, b) => a[0] - b[0]); // back to ascending
}

// Pack files (each first capped to fit maxBytes alone) into frames whose serialized
// files-array stays under maxBytes. Never splits one file across frames. maxBytes is
// the budget for the files array; keep it comfortably under 256KB to leave room for
// the range_report frame envelope + WebRTC overhead (default 200000).
export function batchReportFiles(files, { maxBytes = 200000 } = {}) {
  const capped = files.map((f) => ({ fileId: f.fileId, ivals: capIvals(f.fileId, f.ivals, maxBytes - 2) }));
  const batches = [];
  let cur = [], curLen = 2; // '[]'
  for (const f of capped) {
    const s = JSON.stringify(f).length + 1; // + joining comma
    if (cur.length && curLen + s > maxBytes) { batches.push(cur); cur = []; curLen = 2; }
    cur.push(f); curLen += s;
  }
  if (cur.length) batches.push(cur);
  return batches.length ? batches : [[]];
}
