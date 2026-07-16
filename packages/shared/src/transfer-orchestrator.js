// packages/shared/src/transfer-orchestrator.js
// SP3 MAIN-ONLY send/receive drivers over an abstract channel (ft-ctrl JSON +
// ft-bulk bytes). Coordinates the pure engine + io + jobs-store + protocol.
// ft-ctrl and ft-bulk are INDEPENDENTLY ordered — the receiver routes bulk by
// counting against manifest sizes, and all handlers are serialized. See spec §5/§6.
import {
  offerFrame, offerBeginFrame, offerEntriesFrame, offerEndFrame,
  fileBeginFrame, fileEndFrame, jobDoneFrame, acceptFrame, rejectFrame, promptingFrame, completeFrame,
  parseCtrlFrame, TRANSFER_PROTOCOL_VERSION,
} from './transfer-protocol.js';

// Split manifest entries into batches whose serialized size stays under maxBytes,
// so no single offer_entries frame exceeds the data-channel message limit. Always
// at least one entry per batch (a lone entry can't realistically exceed the limit).
function batchEntriesBySize(entries, maxBytes) {
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
import { buildManifest, skipExisting } from './transfer-manifest.js';
import { createSendJob, createReceiveJob } from './transfer-engine.js';
import { sendFile, createPartFile, finalizeReceivedFile, hasFreeSpace, confineDestPath, publishFullyReceivedFile } from './transfer-io.js';
import { stat } from 'node:fs/promises';

// Serialize async event handlers so awaited writes never interleave. Handler
// exceptions are surfaced to onErr (a `fail(err)`) instead of being swallowed —
// a swallowed exception here previously left the driver's promise hanging forever.
function serializer(onErr) {
  let chain = Promise.resolve();
  return (fn) => { chain = chain.then(fn).catch(onErr); return chain; };
}

export function createSender({
  channel, jobId, manifest, sources, chunkSize = 131072, onEvent = () => {},
  // Max serialized size of one offer_entries batch. Well under the ~256KB WebRTC
  // data-channel message limit; a manifest that fits in ONE batch uses the legacy
  // single `offer` frame (backward-compatible), larger ones are chunked.
  offerBatchBytes = 49152,
  // After all bytes + JOB_DONE are on the wire, the sender WAITS for the
  // receiver's `complete` ack before resolving — so the caller doesn't close the
  // channel while the receiver is still draining (which loses the tail). This
  // backstops a lost ack / dead connection so the send can't hang forever.
  // Generous: the ack normally arrives seconds after the last byte.
  completionTimeoutMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let job = null;
  let canceled = false;
  let settled = false;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
  let completionTimer = null;
  const clearCompletion = () => { if (completionTimer) { clearTimer(completionTimer); completionTimer = null; } };
  const resolveOnce = (v) => { if (!settled) { settled = true; clearCompletion(); resolve(v); } };
  const fail = (e) => { if (!settled) { settled = true; clearCompletion(); reject(e); } };
  const run = serializer(fail);

  async function pump() {
    for (;;) {
      if (canceled) return;
      const nf = job.nextFile();
      if (!nf) break;
      channel.sendCtrl(fileBeginFrame({ jobId, fileId: nf.fileId, offset: nf.offset }));
      const { hash } = await sendFile({
        sourcePath: sources.get(nf.fileId), offset: nf.offset, chunkSize,
        onChunk: async (buf) => { if (canceled) throw new Error('canceled'); await channel.sendBulk(buf); },
      });
      channel.sendCtrl(fileEndFrame({ jobId, fileId: nf.fileId, hash }));
      job.onFileSent(nf.fileId);
      onEvent({ type: 'file-sent', fileId: nf.fileId, progress: job.progress() });
    }
    channel.sendCtrl(jobDoneFrame({ jobId }));
    // Everything is SENT — but not yet confirmed RECEIVED. Surface 'all-sent' so
    // the UI can show "Finishing…", and wait for the receiver's `complete` ack
    // (or the completion timeout) before resolving. Do NOT resolve here.
    onEvent({ type: 'all-sent', progress: job.progress() });
    if (!settled && completionTimeoutMs > 0) {
      completionTimer = setTimer(() => fail(new Error('no_confirmation')), completionTimeoutMs);
      if (completionTimer && completionTimer.unref) completionTimer.unref();
    }
  }

  channel.onCtrl((str) => run(async () => {
    const f = parseCtrlFrame(str);
    if (!f || f.jobId !== jobId) return;
    // The receiver is prompting the user — it's alive and awaiting a human
    // decision. Surface it so the app can cancel the approval timeout (a person
    // deciding must NOT read as "host didn't respond").
    if (f.t === 'prompting') { onEvent({ type: 'prompting' }); return; }
    // Delivery ack: the receiver has every file on disk, verified. NOW it's safe
    // to resolve/close. ok=false means a file failed verification on the receiver.
    if (f.t === 'complete') {
      if (f.ok) { onEvent({ type: 'completed' }); resolveOnce({ jobId, ok: true }); }
      else { onEvent({ type: 'error', reason: 'receiver_incomplete' }); fail(new Error('receiver_incomplete')); }
      return;
    }
    if (f.t === 'reject') { onEvent({ type: 'declined', reason: f.reason }); fail(new Error(`rejected: ${f.reason}`)); return; }
    if (f.t === 'cancel') { canceled = true; fail(new Error('canceled')); return; }
    // pump() is intentionally NOT awaited here: it must run outside the
    // serializer chain, otherwise a later `cancel` frame would queue behind
    // the entire (possibly long-running) pump and could never abort it.
    // 'accepted' is emitted the instant the peer approves — BEFORE any bytes —
    // so the sender UI leaves "waiting for approval" only on a real accept, not
    // when the job is merely queued.
    if (f.t === 'accept' && !job) { onEvent({ type: 'accepted' }); job = createSendJob({ manifest, resume: f.resume }); pump().catch(fail); }
  }));

  return {
    start() {
      const batches = batchEntriesBySize(manifest.entries, offerBatchBytes);
      if (batches.length <= 1) {
        // Small manifest → single legacy frame (an older receiver understands it).
        channel.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
      } else {
        // Large manifest → chunk so no single ft-ctrl message exceeds the channel
        // limit (a one-shot OFFER for a big folder throws + kills ft-ctrl).
        channel.sendCtrl(offerBeginFrame({ jobId, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
        for (const b of batches) channel.sendCtrl(offerEntriesFrame({ jobId, entries: b }));
        channel.sendCtrl(offerEndFrame({ jobId }));
      }
      return finished;
    },
    // Externally abort a send that can never make progress — e.g. the rendezvous
    // failed or the peer never accepted before the timeout. Rejects start()'s
    // promise (idempotent via `settled`); a no-op once the send has settled.
    abort(reason = 'aborted') { canceled = true; fail(new Error(reason)); },
  };
}

async function resumeOffsetFor(destRoot, entry) {
  const finalPath = confineDestPath(destRoot, entry.path);
  try {
    const st = await stat(finalPath);
    if (skipExisting(entry, { size: st.size, mtime: Math.floor(st.mtimeMs) })) return entry.size;
  } catch { /* no final file */ }
  try {
    const pst = await stat(`${finalPath}.part`);
    return Math.min(pst.size, entry.size);
  } catch { /* no .part */ }
  return 0;
}

export function createReceiver({
  channel, destRoot, store, consent, peer = {}, onEvent = () => {},
  // A consented, active receive that stops getting data (the sender vanished /
  // the connection dropped) must NOT hang "Receiving" forever — after this long
  // with no ctrl/bulk frame, fail it and persist the terminal state so the UI
  // clears it (and a Refresh reflects it). Armed only AFTER accept, so a human
  // deliberating over the consent prompt never trips it. Timer injectable for tests.
  inactivityMs = 60000, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let job = null, manifest = null, jobId = null, ok = true;
  let jobDoneSeen = false;
  const doneIds = new Set(), failedIds = new Set();
  // Byte-routing is driven by a manifest-order CURSOR built at accept time — NOT
  // by FILE_BEGIN frames. ft-ctrl and ft-bulk are independently-timed channels,
  // so a file's bytes can (and on a real network DO) arrive before its FILE_BEGIN;
  // routing off FILE_BEGIN then sends bytes to the wrong file and cascades into
  // corrupting every file after (observed live: 98x1.5MB, files 1-6 fine then
  // 7-98 all hash-failed). The sender streams files in strict manifest order, so
  // a cursor over that same order routes correctly regardless of ctrl timing.
  // `seq` is every file's item in manifest order; `cursor` is the file currently
  // receiving bytes. `pending` maps fileId -> item so FILE_END can attach a hash
  // to a file whose bytes have already finished.
  const seq = [];            // {entry, offset, expected, received, partFile, hash, finalizing} in manifest order
  let cursor = 0;            // index in seq of the file currently consuming bulk bytes
  const pending = new Map(); // fileId -> item, until finalized
  let settled = false;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });

  // Inactivity watchdog for an active transfer (see the inactivityMs doc above).
  let inactive = null;     // active timer handle, or null
  let watching = false;    // armed only between accept and settle
  function stopWatchdog() { if (inactive) { clearTimer(inactive); inactive = null; } }
  function pokeWatchdog() {
    if (!watching || settled || !(inactivityMs > 0)) return;
    if (inactive) clearTimer(inactive);
    inactive = setTimer(() => run(async () => {
      if (settled) return;
      ok = false;
      try { await saveRecord('error'); } catch { /* best effort */ }
      onEvent({ type: 'interrupted' });
      fail(new Error('stalled'));
    }), inactivityMs);
    if (inactive && inactive.unref) inactive.unref();
  }

  const resolveOnce = (v) => { if (!settled) { settled = true; watching = false; stopWatchdog(); resolve(v); } };
  const fail = (e) => { if (!settled) { settled = true; watching = false; stopWatchdog(); reject(e); } };
  const run = serializer(fail);

  // Resolves the receiver's promise only once JOB_DONE has actually been seen
  // AND every file has finalized (pending empty) — job_done and the last file's
  // bulk bytes/FILE_END are independently ordered, so job_done can arrive first
  // and must NOT resolve early. A file leaves `pending` only when finalized.
  async function maybeComplete() {
    if (settled) return;
    if (jobDoneSeen && pending.size === 0) {
      await saveRecord('done');
      // Acknowledge delivery so the SENDER can resolve/close (it waits for this —
      // without it the sender would tear the channel down mid-drain). Best effort:
      // if the ack is lost the sender falls back to its completion timeout.
      try { channel.sendCtrl(completeFrame({ jobId, ok })); } catch { /* best effort */ }
      resolveOnce({ jobId, ok });
    }
  }

  function perFileSnapshot() {
    const plan = job ? job.resumePlan() : [];
    const have = new Map(plan.map((p) => [p.fileId, p.haveBytes]));
    return manifest.entries.map((e) => ({
      fileId: e.fileId,
      status: doneIds.has(e.fileId) ? 'done' : failedIds.has(e.fileId) ? 'error'
        : (have.get(e.fileId) || 0) >= e.size ? 'done' : 'pending',
      hashLive: false, // records are only read on resume, which always completion-reads (spec §6.4)
    }));
  }

  async function saveRecord(jobState) {
    if (!store || !manifest) return;
    await store.save({
      jobId, dir: 'recv', tier: 'adhoc', peer, destRoot,
      manifest,
      perFile: perFileSnapshot(),
      jobState, createdAt: 0,
    });
  }

  async function tryFinalize(item) {
    if (item.finalizing || !item.partFile || item.received < item.expected || item.hash == null) return;
    item.finalizing = true;
    await item.partFile.fsync();
    await item.partFile.close();
    const r = await finalizeReceivedFile({ partFile: item.partFile, expectedHash: item.hash, mtime: item.entry.mtime });
    pending.delete(item.entry.fileId);
    if (r.ok) { doneIds.add(item.entry.fileId); job.markVerified(item.entry.fileId); onEvent({ type: 'file-done', fileId: item.entry.fileId, progress: job.progress() }); }
    else { ok = false; failedIds.add(item.entry.fileId); job.markFailed(item.entry.fileId); onEvent({ type: 'file-failed', fileId: item.entry.fileId }); }
    await maybeComplete();
  }

  channel.onBulk((buf) => run(async () => {
    pokeWatchdog(); // fresh bytes — the transfer is alive
    if (!job) return; // bytes before accept: impossible in practice, guard anyway
    let chunk = Buffer.from(buf);
    while (chunk.length > 0 && cursor < seq.length) {
      const item = seq[cursor];
      if (item.expected <= 0) { cursor += 1; continue; } // fully-resumed file: no bytes, finalized via FILE_END
      // Open the .part lazily when the cursor first reaches this file (keeps at
      // most one fd open at a time — matters for huge file counts).
      if (!item.partFile) item.partFile = await createPartFile({ destRoot, relPath: item.entry.path, resumeFrom: item.offset, hashLive: true });
      const need = item.expected - item.received;
      const take = chunk.subarray(0, need);
      await item.partFile.write(take);
      item.received += take.length;
      job.onBytes(item.entry.fileId, take.length);
      chunk = chunk.subarray(take.length);
      if (item.received >= item.expected) {
        cursor += 1; // byte-complete: advance the cursor NOW, independent of hash arrival
        await tryFinalize(item); // finalizes only if FILE_END's hash already landed
      }
    }
    // Trailing bytes past the last file (cursor === seq.length) shouldn't happen
    // for a well-formed stream — discarded silently, not an error.
  }));

  // Process a COMPLETE offer (legacy single `offer` frame, or the reassembled
  // chunked offer_begin→offer_entries*→offer_end). Validates, checks space, prompts
  // for consent, then accepts + seeds the byte-routing sequence.
  async function beginReceive({ offJobId, protoVer, entries }) {
    if (typeof protoVer === 'number' && protoVer > TRANSFER_PROTOCOL_VERSION) {
      channel.sendCtrl(rejectFrame({ jobId: offJobId, reason: 'proto' }));
      resolveOnce({ jobId: offJobId, ok: false, rejected: 'proto' });
      return;
    }
    let m;
    try { m = buildManifest(entries); } catch {
      channel.sendCtrl(rejectFrame({ jobId: offJobId, reason: 'bad_manifest' }));
      resolveOnce({ jobId: offJobId, ok: false, rejected: 'bad_manifest' });
      return;
    }
    jobId = offJobId; manifest = m;
    if (!(await hasFreeSpace(destRoot, m.totalBytes))) {
      channel.sendCtrl(rejectFrame({ jobId, reason: 'nospace' }));
      resolveOnce({ jobId, ok: false, rejected: 'nospace' });
      return;
    }
    // Thread the REAL transfer jobId (assigned by the sender) into consent — not a
    // locally-minted correlation id — so the renderer's accept/reject round-trip and
    // the persisted jobs-store record agree on one id end to end (coherence #2).
    // Tell the sender we're now prompting a human, so it stops its approval timeout
    // (deciding is not "no response"). Sent BEFORE the await so it goes out at once.
    channel.sendCtrl(promptingFrame({ jobId }));
    if (!(await consent({ jobId, manifest: m }))) {
      channel.sendCtrl(rejectFrame({ jobId, reason: 'declined' }));
      resolveOnce({ jobId, ok: false, rejected: 'declined' });
      return;
    }
    const have = {};
    for (const e of m.entries) have[e.fileId] = await resumeOffsetFor(destRoot, e);
    job = createReceiveJob({ manifest: m, have });
    // Build the byte-routing sequence from the MANIFEST (the order the sender
    // streams files) so routing never depends on FILE_BEGIN timing. Part files
    // open lazily as the cursor reaches each file — except fully-resumed files
    // (no bytes to receive), whose .part we open now so FILE_END can finalize.
    for (const e of m.entries) {
      const offset = have[e.fileId] || 0;
      const item = { entry: e, offset, expected: e.size - offset, received: 0, partFile: null, hash: null, finalizing: false };
      if (item.expected <= 0) {
        // Already fully present (skip-existing final, or a complete .part from a
        // prior run). The sender sends NOTHING for such a file — no FILE_BEGIN/
        // END/bytes (createSendJob marks it `sent` up front) — so we must finalize
        // it NOW. Parking it in `pending` to await a FILE_END that never arrives
        // hangs the whole receive (field bug: "stuck at verifying" + orphan .part).
        // Keep it in `seq` (onBulk's cursor skips expected<=0 items) but not in
        // `pending`; publish any full .part and mark it done.
        await publishFullyReceivedFile({ destRoot, relPath: e.path, mtime: e.mtime });
        doneIds.add(e.fileId);
        job.markVerified(e.fileId);
        onEvent({ type: 'file-done', fileId: e.fileId, progress: job.progress() });
        seq.push(item);
        continue;
      }
      pending.set(e.fileId, item);
      seq.push(item);
    }
    await saveRecord('active');
    // Only send NON-ZERO resume offsets — the sender defaults any file missing from
    // `resume` to 0. This keeps the accept frame tiny for a fresh transfer (all
    // zeros) so it can't itself overrun the data-channel message limit on a huge
    // folder (the OFFER's sibling failure mode).
    channel.sendCtrl(acceptFrame({ jobId, resume: job.resumePlan().filter((r) => r.haveBytes > 0) }));
    watching = true; pokeWatchdog(); // now expecting a steady stream of bytes
  }

  // Reassembly buffer for a chunked OFFER (offer_begin → offer_entries* → offer_end).
  let offerAccum = null;

  channel.onCtrl((str) => run(async () => {
    pokeWatchdog(); // fresh ctrl frame — the transfer is alive
    const f = parseCtrlFrame(str);
    if (!f) return;
    if (f.t === 'offer') {
      if (job || offerAccum) return;
      await beginReceive({ offJobId: f.jobId, protoVer: f.protoVer, entries: f.entries });
      return;
    }
    if (f.t === 'offer_begin') {
      if (job || offerAccum) return;
      offerAccum = { jobId: f.jobId, protoVer: f.protoVer, entries: [] };
      return;
    }
    if (f.t === 'offer_entries') {
      if (offerAccum && f.jobId === offerAccum.jobId) { for (const e of f.entries) offerAccum.entries.push(e); }
      return;
    }
    if (f.t === 'offer_end') {
      if (!offerAccum || f.jobId !== offerAccum.jobId) return;
      const acc = offerAccum; offerAccum = null;
      await beginReceive({ offJobId: acc.jobId, protoVer: acc.protoVer, entries: acc.entries });
      return;
    }
    if (!jobId || f.jobId !== jobId) return;
    if (f.t === 'file_begin') {
      // Advisory now — routing is driven by the manifest cursor (see onBulk), so
      // FILE_BEGIN no longer creates the part file or seeds the queue. Kept in the
      // protocol for the sender's per-file framing; nothing to do on receipt.
    } else if (f.t === 'file_end') {
      const item = pending.get(f.fileId);
      if (item) { job.onFileEnd({ fileId: f.fileId }); item.hash = f.hash; await tryFinalize(item); }
    } else if (f.t === 'job_done') {
      jobDoneSeen = true;
      await maybeComplete();
    }
  }));

  return { start() { return finished; } };
}
