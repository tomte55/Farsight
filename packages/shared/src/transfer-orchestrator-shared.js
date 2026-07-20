// packages/shared/src/transfer-orchestrator-shared.js
// Small helpers shared by transfer-sender.js and transfer-receiver.js (split out
// of the former transfer-orchestrator.js — Phase 2 Task 5, R7). Kept dependency-free
// so neither driver module needs to import the other.

// Split manifest entries into batches whose serialized size stays under maxBytes,
// so no single offer_entries frame exceeds the data-channel message limit. Always
// at least one entry per batch (a lone entry can't realistically exceed the limit).
export function batchEntriesBySize(entries, maxBytes) {
  const batches = [];
  let cur = [], curLen = 2; // '[]'
  for (const e of entries) {
    const s = JSON.stringify(e).length + 1; // +1 for the joining comma
    if (cur.length && curLen + s > maxBytes) { batches.push(cur); cur = []; curLen = 2; }
    cur.push(e); curLen += s;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// Serialize async event handlers so awaited writes never interleave. Handler
// exceptions are surfaced to onErr (a `fail(err)`) instead of being swallowed —
// a swallowed exception here previously left the driver's promise hanging forever.
export function serializer(onErr) {
  let chain = Promise.resolve();
  return (fn) => { chain = chain.then(fn).catch(onErr); return chain; };
}
