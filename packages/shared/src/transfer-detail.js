// packages/shared/src/transfer-detail.js
// Task 10: pure formatting/state helpers for the expandable Transfer Detail UI —
// a per-row toggle that reveals flow health, terminally-failed files (with a
// human reason), and the aggregate bytes/rate/ETA/files line. Pure + runtime-
// agnostic (no node: imports) so these unit-test in isolation and run unchanged
// in the sandboxed renderer, same discipline as transfer-rate.js/transfer-label.js.
import { bytesDone, filesDone, formatBytes, formatRate, formatDuration, etaSeconds } from './transfer-rate.js';

// Human-readable text for a file-failed reason code. Only 'io_error' is emitted
// today (transfer-receiver.js's terminal per-file-retry-exhausted path) but
// an unknown/future code still shows something readable — the raw code — rather
// than nothing.
const REASON_LABELS = {
  io_error: "Couldn't write file (locked by another program?)",
};
export function reasonLabel(code) {
  if (!code) return 'Unknown error';
  return REASON_LABELS[code] || code;
}

// "14/16 flows • 3 re-dials" for a multi-flow send (Task 9's aggregate progress
// fields: flowsLive/flowsTotal/redials). Renders nothing for a single-flow/legacy
// transfer, where these fields are absent (or flowsTotal <= 1) — the caller
// should simply not show the flow-health line in that case.
export function flowHealthLabel({ flowsLive, flowsTotal, redials } = {}) {
  if (!Number.isFinite(flowsTotal) || flowsTotal <= 1) return '';
  const live = Number.isFinite(flowsLive) ? flowsLive : flowsTotal;
  let s = `${live}/${flowsTotal} flows`;
  if (Number.isFinite(redials) && redials > 0) s += ` • ${redials} re-dial${redials === 1 ? '' : 's'}`;
  return s;
}

// Dedupe-by-fileId accumulator for TERMINALLY-failed files. Pure: returns a NEW
// array rather than mutating `list`, so it's safe to call straight off whatever
// the caller is holding (e.g. a job record's own array) without a defensive copy
// first. A retry that fails again for the same fileId REPLACES the prior entry
// (keeps the latest reason) instead of appending a duplicate row. Terminal-vs-
// retryable filtering (a file-failed WITHOUT a `reason` is retryable —
// transfer-service.js) is the caller's job; this function just does an honest
// "add/replace by id".
export function upsertFailedFile(list, entry) {
  const arr = Array.isArray(list) ? list : [];
  const fileId = entry && entry.fileId;
  const next = { fileId, reason: entry && entry.reason };
  const idx = arr.findIndex((f) => f.fileId === fileId);
  if (idx === -1) return [...arr, next];
  const copy = arr.slice();
  copy[idx] = next;
  return copy;
}

// Resolve a fileId to a display name via the manifest's entries (transfer-
// manifest.js: {fileId, path, size, mtime}); falls back to the raw fileId
// (stringified) when the manifest doesn't have it, so the detail panel never
// shows "undefined" for a job whose manifest hasn't loaded yet.
export function fileNameFor(manifest, fileId) {
  const entries = manifest && Array.isArray(manifest.entries) ? manifest.entries : [];
  const e = entries.find((x) => x && x.fileId === fileId);
  if (!e) return String(fileId);
  const path = String(e.path || '');
  const base = path.split('/').filter(Boolean).pop();
  return base || path || String(fileId);
}

// True during the "verify tail": all bytes are already on the wire/received and
// only host-side hashing/finalizing remains (sender 'finishing', receiver
// 'verifying' — see docs/private "Verifying/Finishing state fix"). No more byte
// movement is being sampled during this phase, so a rate/ETA computed from the
// last sample is STALE, not live.
export function isFinishingTail(state) {
  return state === 'finishing' || state === 'verifying';
}

// The detail panel's aggregate line: bytes done/total, current rate, ETA, and
// files done/total. Deferred known-minor, fixed here: during the verify tail
// (isFinishingTail) bytes have stopped moving but `rate` (the caller's last
// sampled value) is still a positive stale number, and remaining bytes is 0 —
// feeding that straight into etaSeconds/formatRate used to render a frozen
// speed plus a bogus "~0s left". Suppress both: blank rate, "Finishing…" in
// place of an ETA.
export function aggregateDetail({ progress, rate, state } = {}) {
  const total = progress && Number.isFinite(progress.total) ? progress.total : 0;
  const done = bytesDone(progress);
  const filesTotal = progress && Number.isFinite(progress.filesTotal) ? progress.filesTotal : 0;
  const filesDoneCount = filesDone(progress);

  let rateText = '';
  let etaText = '';
  if (isFinishingTail(state)) {
    etaText = 'Finishing…';
  } else if (Number.isFinite(rate) && rate > 0) {
    rateText = formatRate(rate);
    const eta = etaSeconds(total - done, rate);
    if (eta !== null) etaText = `~${formatDuration(eta)} left`;
  }

  return {
    bytesText: `${formatBytes(done)} of ${formatBytes(total)}`,
    rateText,
    etaText,
    filesText: filesTotal > 0 ? `${filesDoneCount} / ${filesTotal} files` : '',
  };
}
