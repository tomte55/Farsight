// packages/shared/src/transfer-orchestrator.js
// SP3 MAIN-ONLY send/receive drivers over an abstract channel (ft-ctrl JSON +
// ft-bulk bytes). Coordinates the pure engine + io + jobs-store + protocol.
// ft-ctrl and ft-bulk are INDEPENDENTLY ordered — the receiver routes bulk by
// counting against manifest sizes, and all handlers are serialized. See spec §5/§6.
import {
  offerFrame, offerBeginFrame, offerEntriesFrame, offerEndFrame,
  fileBeginFrame, fileEndFrame, jobDoneFrame, acceptFrame, rejectFrame, promptingFrame, completeFrame,
  cancelFrame, parseCtrlFrame, rangeReportFrame, TRANSFER_PROTOCOL_VERSION,
} from './transfer-protocol.js';
import { batchReportFiles } from './transfer-report-batch.js';

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
import { createHash } from 'node:crypto';
import { createChunkProducer } from './transfer-producer.js';
import { createSendPool } from './transfer-send-pool.js';
import { createCoverageTracker } from './transfer-reconcile.js';
import { createReceiveRouter } from './transfer-receive-router.js';

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
  // Per-chunk progress would be far too chatty over IPC (a 100 GB send is ~800k
  // chunks); throttle to a human-legible cadence. Clock injected for tests.
  progressIntervalMs = 250, now = () => Date.now(),
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

  let lastProgressAt = 0;
  function emitProgress() {
    if (!job) return;
    const t = now();
    if (t - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = t;
    onEvent({ type: 'progress', progress: job.progress() });
  }

  async function pump() {
    for (;;) {
      if (canceled) return;
      const nf = job.nextFile();
      if (!nf) break;
      channel.sendCtrl(fileBeginFrame({ jobId, fileId: nf.fileId, offset: nf.offset }));
      const { hash } = await sendFile({
        sourcePath: sources.get(nf.fileId), offset: nf.offset, chunkSize,
        onChunk: async (buf) => {
          if (canceled) throw new Error('canceled');
          await channel.sendBulk(buf);
          job.onBytes(nf.fileId, buf.length);
          emitProgress();
        },
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
    if (f.t === 'cancel') { onEvent({ type: 'canceled' }); canceled = true; fail(new Error('canceled')); return; }
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

// Multi-flow sender: stripes chunks across N bulk flows (Plan 1's send-pool),
// tracks the RECEIVER's confirmed coverage (Plan 1's reconcile tracker) rather
// than a local send-queue, and re-drives any gap the tracker still shows after
// each pass — so a dropped chunk on a dead/rejecting flow gets re-sent without
// the sender ever needing to know WHICH flow failed. Coverage-defined completion
// (not queue-defined) is the whole point: `job_done` only goes out once the
// tracker says every byte is covered, and even then the driver doesn't resolve
// until the receiver's `complete` ack lands (same discipline as createSender).
export function createMultiFlowSender({
  ctrl, flows, jobId, manifest, chunkSize = 131072, flowCount, groupId,
  readerFor, newHash = () => createHash('sha256'),
  onEvent = () => {},
  offerBatchBytes = 49152,
  completionTimeoutMs = 120000,
  reconcileWaitMs = 3000,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (typeof readerFor !== 'function') throw new Error('readerFor is required');

  const tracker = createCoverageTracker({ manifest });
  // The test manifests (and any minimal caller) may omit totalBytes/totalFiles —
  // the wire's `offer`/`offer_begin` frames require them to be integers (protocol
  // validation in transfer-protocol.js's parseCtrlFrame), so derive them from the
  // entries when a full buildManifest() output wasn't provided.
  const totalBytes = Number.isInteger(manifest.totalBytes) ? manifest.totalBytes
    : manifest.entries.reduce((s, e) => s + e.size, 0);
  const totalFiles = Number.isInteger(manifest.totalFiles) ? manifest.totalFiles : manifest.entries.length;

  let canceled = false;
  let settled = false;
  let pumped = false;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
  let completionTimer = null;
  const clearCompletion = () => { if (completionTimer) { clearTimer(completionTimer); completionTimer = null; } };
  const resolveOnce = (v) => { if (!settled) { settled = true; clearCompletion(); resolve(v); } };
  const fail = (e) => { if (!settled) { settled = true; clearCompletion(); reject(e); } };
  const run = serializer(fail);

  // Each file's hash, computed once by the initial full-file read (below) and
  // reused by any later gap pass's re-sent file_end — a resumed, already
  // byte-complete file still gets hashed+file_end here (the bug this fixes: a
  // file the accept-time coverage already reports complete previously never
  // got read/hashed at all, so its file_end never went out and the receiver
  // could never finalize it).
  const fileHash = new Map();

  // Resolves the next time a range_report updates the tracker, or after `ms` —
  // a lost/delayed final report must not stall the driver forever, so a timeout
  // just re-drives another pass (which is a correctness no-op if nothing's left).
  let pendingWaiterResolve = null;
  function waitForReport(ms) {
    return new Promise((res) => {
      let done = false;
      const timer = setTimer(() => {
        if (done) return;
        done = true; pendingWaiterResolve = null;
        res();
      }, ms);
      if (timer && timer.unref) timer.unref();
      pendingWaiterResolve = () => {
        if (done) return;
        done = true; clearTimer(timer); pendingWaiterResolve = null;
        res();
      };
    });
  }

  // Initial pass: read+hash EVERY file exactly once, in manifest order — even
  // one the accept-time tracker already reports byte-complete (the resume
  // case) — yielding only its currently-uncovered chunks, then send its
  // file_end. This is what fixes the hang: without a full read here, a
  // resumed-complete file never gets hashed and its file_end never goes out,
  // so the receiver has every byte but nothing to finalize against.
  async function* initialPass() {
    for (const file of manifest.entries) {
      if (canceled) return;
      const reader = readerFor(file.fileId);
      const hasher = newHash();
      const producer = createChunkProducer({
        readChunk: (o, l) => reader.readAt(o, l),
        hashUpdate: (b) => hasher.update(b),
        chunkSize,
      });
      for await (const c of producer.produce(file, tracker.coveredFor(file.fileId))) {
        if (canceled) { await reader.close(); return; }
        yield c;
      }
      await reader.close();
      if (canceled) return;
      const h = hasher.digest('hex');
      fileHash.set(file.fileId, h);
      ctrl.sendCtrl(fileEndFrame({ jobId, fileId: file.fileId, hash: h }));
    }
  }

  // Later passes: for each file the receiver still reports incomplete, re-send
  // ONLY its gap byte-ranges (no whole-file re-read/re-hash — the hash was
  // already computed once, above) and RE-SEND its file_end — idempotent on the
  // receiver, and needed for a file the receiver reset after a verify failure.
  async function* gapPass() {
    for (const file of manifest.entries) {
      if (canceled) return;
      if (tracker.coveredFor(file.fileId).isComplete(file.size)) continue;
      const reader = readerFor(file.fileId);
      for (const gap of tracker.gapsFor(file.fileId)) {
        let off = gap.offset; const end = gap.offset + gap.length;
        while (off < end) {
          if (canceled) { await reader.close(); return; }
          const len = Math.min(chunkSize, end - off);
          const payload = await reader.readAt(off, len);
          yield { fileId: file.fileId, offset: off, length: len, payload };
          off += len;
        }
      }
      await reader.close();
      if (canceled) return;
      if (fileHash.has(file.fileId)) {
        ctrl.sendCtrl(fileEndFrame({ jobId, fileId: file.fileId, hash: fileHash.get(file.fileId) }));
      }
    }
  }

  async function pump() {
    try {
      await createSendPool({ flows }).run(initialPass());
      for (;;) {
        // `settled` is the backstop: the receiver's own `complete`/`reject`/
        // `cancel` frame settles this driver directly (see the ctrl handler
        // below), but router.rangesFor() omits finalized files from every
        // report (fixed on the receiver side too — see reportFiles() in
        // createMultiFlowReceiver), so tracker.isComplete() alone is not
        // guaranteed reachable against every receiver implementation. Without
        // this check the loop would keep re-reading/re-sending the whole
        // payload every reconcileWaitMs forever, even after the transfer has
        // already resolved.
        if (canceled || settled) return;
        if (tracker.isComplete()) break;
        await waitForReport(reconcileWaitMs);
        if (canceled || settled) return;
        if (tracker.isComplete()) break;
        await createSendPool({ flows }).run(gapPass());
      }
    } catch (e) {
      fail(e); // includes 'no_live_flows' — never spin against a dead flow set
      return;
    }
    ctrl.sendCtrl(jobDoneFrame({ jobId }));
    onEvent({ type: 'all-sent' });
    if (!settled && completionTimeoutMs > 0) {
      completionTimer = setTimer(() => fail(new Error('no_confirmation')), completionTimeoutMs);
      if (completionTimer && completionTimer.unref) completionTimer.unref();
    }
  }

  ctrl.onCtrl((str) => run(async () => {
    const f = parseCtrlFrame(str);
    if (!f || f.jobId !== jobId) return;
    if (f.t === 'prompting') { onEvent({ type: 'prompting' }); return; }
    if (f.t === 'complete') {
      if (f.ok) { onEvent({ type: 'completed' }); resolveOnce({ jobId, ok: true }); }
      else { onEvent({ type: 'error', reason: 'receiver_incomplete' }); fail(new Error('receiver_incomplete')); }
      return;
    }
    if (f.t === 'reject') { onEvent({ type: 'declined', reason: f.reason }); fail(new Error(`rejected: ${f.reason}`)); return; }
    if (f.t === 'cancel') {
      onEvent({ type: 'canceled' }); canceled = true;
      if (pendingWaiterResolve) pendingWaiterResolve();
      fail(new Error('canceled'));
      return;
    }
    if (f.t === 'range_report') { tracker.applyReport(f.files); if (pendingWaiterResolve) pendingWaiterResolve(); return; }
    // pump() is intentionally NOT awaited here — same reasoning as createSender's
    // pump: it must run outside the serializer chain so a later `cancel` can
    // still get processed (and observed by the `canceled` flag) while pump is
    // mid-flight, rather than queuing behind it.
    if (f.t === 'accept' && !pumped) {
      pumped = true;
      tracker.applyReport(f.ranges || []);
      onEvent({ type: 'accepted' });
      pump().catch(fail);
    }
  }));

  return {
    start() {
      const batches = batchEntriesBySize(manifest.entries, offerBatchBytes);
      if (batches.length <= 1) {
        ctrl.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes, totalFiles, flowCount, groupId }));
      } else {
        ctrl.sendCtrl(offerBeginFrame({ jobId, totalBytes, totalFiles, flowCount, groupId }));
        for (const b of batches) ctrl.sendCtrl(offerEntriesFrame({ jobId, entries: b }));
        ctrl.sendCtrl(offerEndFrame({ jobId }));
      }
      return finished;
    },
    // Mirrors createSender's abort. Also wakes a pump() parked in waitForReport
    // so the pass loop observes `canceled` promptly instead of idling out the
    // full reconcileWaitMs before it gets a chance to check.
    abort(reason = 'aborted') {
      canceled = true;
      if (pendingWaiterResolve) pendingWaiterResolve();
      fail(new Error(reason));
    },
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
  // The receiver learns its peer's trust tier only AFTER the consent classify
  // resolves, so it's read lazily. It decides whether a stall is recoverable:
  // fleet/contact sends auto-resume (the SENDER's resume watcher re-establishes
  // with the same jobId), adhoc does not.
  getTier = () => 'adhoc',
  // A consented, active receive that stops getting data (the sender vanished /
  // the connection dropped) must NOT hang "Receiving" forever — after this long
  // with no ctrl/bulk frame, fail it and persist the terminal state so the UI
  // clears it (and a Refresh reflects it). Armed only AFTER accept, so a human
  // deliberating over the consent prompt never trips it. During a healthy
  // transfer bulk chunks arrive continuously (every chunk pokes this), so the
  // window only elapses on a genuine stall — 25s keeps the receiver from looking
  // frozen when a sender is closed/restarted, while still tolerating a brief
  // ICE-restart reconnect (an own-fleet drop is saved 'interrupted' and the
  // sender's resume watcher re-establishes anyway). Timer injectable for tests.
  inactivityMs = 25000, setTimer = setTimeout, clearTimer = clearTimeout,
  // Bytes land per chunk but the UI only needs a legible cadence; without ANY
  // per-chunk emission a single huge file shows no movement for hours (progress
  // otherwise rides only on file-done).
  progressIntervalMs = 250, now = () => Date.now(),
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
      // fleet/contact: the sender auto-resumes this same jobId, so this is a
      // recoverable pause, not a failure — persist 'interrupted' so a refresh
      // (and the UI) says "reconnecting", not "Failed". adhoc has no resume path.
      const tier = getTier();
      const resumable = tier === 'fleet' || tier === 'contact';
      try { await saveRecord(resumable ? 'interrupted' : 'error'); } catch { /* best effort */ }
      onEvent({ type: 'interrupted', resumable });
      fail(new Error('stalled'));
    }), inactivityMs);
    if (inactive && inactive.unref) inactive.unref();
  }

  // Fd-leak fix: tryFinalize only closes a file's .part handle as part of
  // actually finalizing it (fsync+close, unconditional, right before the
  // settled check — see tryFinalize). A receive that settles (abort, stall,
  // error) while a file is still mid-flight — either still receiving bytes, or
  // byte-complete but awaiting FILE_END's hash — never reaches that close, so
  // its fd would otherwise sit open until Node's FileHandle finalizer gets
  // around to it (non-deterministic, with a process warning). Marking
  // `item.finalizing = true` before closing also prevents a late-queued
  // tryFinalize call for this same item from trying to finalize/close it too —
  // though in practice tryFinalize's own `if (settled) return` (its first line)
  // already makes that impossible once we get here.
  function closeOpenPartFiles() {
    for (const item of seq) {
      if (item.partFile && !item.finalizing) {
        item.finalizing = true;
        item.partFile.close().catch(() => { /* best effort */ });
      }
    }
  }

  // Routed through run() (not called directly) so the close is queued behind
  // any handler currently in-flight on the shared serializer — most notably
  // onBulk's `await item.partFile.write(take)` for the very item we're about
  // to close. Closing a fd while a write to it is still parked in libuv would
  // race the fd itself; run() guarantees the write's handler has already
  // returned (its own `if (settled) return` bails it out) before this runs.
  const resolveOnce = (v) => { if (!settled) { settled = true; watching = false; stopWatchdog(); run(closeOpenPartFiles); resolve(v); } };
  const fail = (e) => { if (!settled) { settled = true; watching = false; stopWatchdog(); run(closeOpenPartFiles); reject(e); } };
  const run = serializer(fail);

  let lastProgressAt = 0;
  function emitProgress() {
    if (!job) return;
    const t = now();
    if (t - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = t;
    onEvent({ type: 'progress', progress: job.progress() });
  }

  // Resolves the receiver's promise only once JOB_DONE has actually been seen
  // AND every file has finalized (pending empty) — job_done and the last file's
  // bulk bytes/FILE_END are independently ordered, so job_done can arrive first
  // and must NOT resolve early. A file leaves `pending` only when finalized.
  async function maybeComplete() {
    if (settled) return;
    if (jobDoneSeen && pending.size === 0) {
      await saveRecord('done');
      // abort() can race this in-flight save (it runs outside the run() serializer
      // — see the module-level abort() below): if it settled us WHILE the save
      // above was in flight, don't ack a delivery that was already canceled, and
      // don't emit a stray 'completed' after the 'canceled' event already went out
      // (review finding 2). resolveOnce() below is separately idempotent, but the
      // sendCtrl/onEvent are not, so bail explicitly.
      if (settled) return;
      // Acknowledge delivery so the SENDER can resolve/close (it waits for this —
      // without it the sender would tear the channel down mid-drain). Best effort:
      // if the ack is lost the sender falls back to its completion timeout.
      try { channel.sendCtrl(completeFrame({ jobId, ok })); } catch { /* best effort */ }
      // The receiver's own terminal event. Without it the UI has to INFER done
      // from fraction >= 1, which fires early (last file verified, job_done not yet
      // seen) and fires instantly for a fully-resumed job.
      onEvent({ type: 'completed', ok, progress: job ? job.progress() : undefined });
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
    // An abort() may have already settled the receive (e.g. while this call's
    // caller was suspended on the human consent prompt, or racing a run()-queued
    // handler that got past its own entry guard). transfer-service's cancel()
    // owns the store record for this path — a write here must never resurrect/
    // clobber the 'canceled' record it persists (review findings 1 & 2).
    if (settled) return;
    await store.save({
      jobId, dir: 'recv', tier: getTier() || 'adhoc', peer, destRoot,
      manifest,
      perFile: perFileSnapshot(),
      jobState, createdAt: 0,
    });
  }

  async function tryFinalize(item) {
    // A canceled receive must not finalize a file — no fsync/rename onto the real
    // destination path, no 'file-done'/'file-failed' event — after 'canceled' has
    // already been emitted and the promise settled (review round 2 finding).
    if (settled) return;
    if (item.finalizing || !item.partFile || item.received < item.expected || item.hash == null) return;
    item.finalizing = true;
    await item.partFile.fsync();
    await item.partFile.close();
    // Round 3: a cancel can land while suspended on fsync/close too. Both already
    // ran by the time we can observe this (an fd close can't be un-run, and
    // there's nothing to undo — the closed .part is exactly the resumable state
    // beginReceive's resume logic expects), so just stop BEFORE the potentially
    // expensive hash+rename step below instead of doing it for a transfer that's
    // already canceled.
    if (settled) return;
    const r = await finalizeReceivedFile({ partFile: item.partFile, expectedHash: item.hash, mtime: item.entry.mtime });
    // Round 4 (CRITICAL, reverts round 3): finalizeReceivedFile's rename onto the
    // real destination is a real, uninterruptible disk op — once the call above
    // was made, it commits regardless of whether `settled` flips while it's in
    // flight. Round 3 tried to "undo" a landed rename by renaming the file back
    // onto a `.part` — but that causes DATA LOSS: skipExisting only skips when
    // size AND mtime both match (transfer-manifest.js), so a pre-existing
    // destination file that's merely an OLDER version of the incoming one reaches
    // this function, and the rename above has already overwritten it before this
    // check runs. The round-3 undo then relocated the just-landed new content
    // away to `.part`, leaving the destination EMPTY: the user's original file
    // was already gone (overwritten) and the new one never actually lands there
    // either. An already-verified file quietly finishing despite a cancel that
    // raced its last byte is an acceptable outcome (the user gets the file they
    // asked for); a file that existed before the transfer vanishing is not. So:
    // don't undo it — just stop advancing bookkeeping/events for a settled
    // receiver, same discipline as every other guard in this file.
    if (settled) return;   // an already-verified file may land; that's acceptable
    pending.delete(item.entry.fileId);
    if (r.ok) { doneIds.add(item.entry.fileId); job.markVerified(item.entry.fileId); onEvent({ type: 'file-done', fileId: item.entry.fileId, progress: job.progress() }); }
    else { ok = false; failedIds.add(item.entry.fileId); job.markFailed(item.entry.fileId); onEvent({ type: 'file-failed', fileId: item.entry.fileId }); }
    await maybeComplete();
  }

  channel.onBulk((buf) => run(async () => {
    pokeWatchdog(); // fresh bytes — the transfer is alive
    // A cancel that landed while this handler was already queued behind the
    // serializer (abort() runs outside run(), synchronously) must stop byte
    // writes here too — otherwise a canceled receive keeps writing real bytes
    // to the .part file after 'canceled' has already been emitted (review
    // round 2 finding; mirrors the settled discipline already applied to
    // beginReceive/saveRecord/maybeComplete/tryFinalize).
    if (settled) return;
    if (!job) return; // bytes before accept: impossible in practice, guard anyway
    let chunk = Buffer.from(buf);
    while (chunk.length > 0 && cursor < seq.length) {
      // Round 3: the entry guard above only catches a cancel that landed BEFORE
      // this handler started. This loop itself suspends on awaits below, and a
      // cancel can land while parked on any of them — re-check every iteration
      // so a canceled receive can't open/write into the NEXT file once it does.
      if (settled) return;
      const item = seq[cursor];
      if (item.expected <= 0) { cursor += 1; continue; } // fully-resumed file: no bytes, finalized via FILE_END
      // Open the .part lazily when the cursor first reaches this file (keeps at
      // most one fd open at a time — matters for huge file counts).
      if (!item.partFile) item.partFile = await createPartFile({ destRoot, relPath: item.entry.path, resumeFrom: item.offset, hashLive: true });
      // Opening the .part is a real (uninterruptible) fs op, but it's exactly
      // the "leave the .part for resume" state this design already wants — no
      // need to undo it. Just don't write bytes into it once canceled.
      if (settled) return;
      const need = item.expected - item.received;
      const take = chunk.subarray(0, need);
      await item.partFile.write(take);
      // Same reasoning: the write itself lands real (but resumable) .part bytes
      // on disk, which is fine — that's what resume expects. What must NOT
      // happen is advancing bookkeeping/finalizing/emitting progress for a
      // receive that's already canceled, so stop right here.
      if (settled) return;
      item.received += take.length;
      job.onBytes(item.entry.fileId, take.length);
      chunk = chunk.subarray(take.length);
      if (item.received >= item.expected) {
        cursor += 1; // byte-complete: advance the cursor NOW, independent of hash arrival
        await tryFinalize(item); // finalizes only if FILE_END's hash already landed
      }
    }
    if (settled) return; // don't emit a stray progress event after canceled
    emitProgress(); // throttled: the bar/speed/ETA need movement between file boundaries
    // Trailing bytes past the last file (cursor === seq.length) shouldn't happen
    // for a well-formed stream — discarded silently, not an error.
  }));

  // Process a COMPLETE offer (legacy single `offer` frame, or the reassembled
  // chunked offer_begin→offer_entries*→offer_end). Validates, checks space, prompts
  // for consent, then accepts + seeds the byte-routing sequence.
  async function beginReceive({ offJobId, protoVer, entries }) {
    // A cancel() can land at ANY point below — most notably while the human
    // consent prompt is pending, which can stay open arbitrarily long. abort()
    // runs synchronously and settles `finished` immediately, but this function
    // keeps running (it's suspended on an await, not actually stopped). Every
    // resumption point below re-checks `settled` before touching the store or
    // the channel, mirroring createSender's pump() `canceled` discipline — so a
    // stale resume can never send an accept on a torn-down channel or persist a
    // record for a transfer that's already confirmed canceled (review finding 1).
    if (settled) return;
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
    const freeSpace = await hasFreeSpace(destRoot, m.totalBytes);
    if (settled) return;
    if (!freeSpace) {
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
    const consented = await consent({ jobId, manifest: m });
    if (settled) return;
    if (!consented) {
      channel.sendCtrl(rejectFrame({ jobId, reason: 'declined' }));
      resolveOnce({ jobId, ok: false, rejected: 'declined' });
      return;
    }
    // The receiver now has the manifest and has committed to receiving. Surface
    // it so the UI can label the transfer (file/folder name + count) immediately
    // — the receiver's other events (progress/file-done/…) carry no manifest, so
    // without this the name stayed blank until a manual Refresh re-read the store
    // record. Covers both the prompted and the auto-accepted (own-fleet) paths,
    // since consent() resolves true in both.
    onEvent({ type: 'accepted', manifest: m });
    const have = {};
    for (const e of m.entries) have[e.fileId] = await resumeOffsetFor(destRoot, e);
    if (settled) return;
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
        // Round 3 (minor): guard BEFORE this write too, not just after — a
        // cancel landing during a PRIOR iteration's await (resumeOffsetFor, or
        // this same call on an earlier entry) must stop the NEXT entry's
        // publish from starting at all, not just suppress the events that
        // follow it.
        if (settled) return;
        await publishFullyReceivedFile({ destRoot, relPath: e.path, mtime: e.mtime });
        if (settled) return;
        doneIds.add(e.fileId);
        job.markVerified(e.fileId);
        onEvent({ type: 'file-done', fileId: e.fileId, progress: job.progress() });
        seq.push(item);
        continue;
      }
      pending.set(e.fileId, item);
      seq.push(item);
    }
    if (settled) return;
    await saveRecord('active');
    // saveRecord() itself no-ops once settled (see its own guard) — but even so,
    // don't send an accept frame on what may already be a torn-down channel for
    // a transfer that's already confirmed canceled.
    if (settled) return;
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
    // Mirrors the onBulk guard above: a cancel that landed while this handler was
    // already queued must stop EVERY ctrl-frame side effect, not just tryFinalize's
    // fsync/rename. Found by audit: without this, `job_done`'s `onEvent({type:
    // 'verifying'})` below fires after 'canceled' whenever `pending` is non-empty —
    // which it always is post-cancel, since the guarded tryFinalize no longer
    // reaches its own `pending.delete(...)` (review round 2).
    if (settled) return;
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
      // All bytes are in but hashes are still being verified/finalized — a real,
      // visible phase on a big transfer, not a stall.
      if (pending.size > 0) onEvent({ type: 'verifying', progress: job ? job.progress() : undefined });
      await maybeComplete();
    }
  }));

  return {
    start() { return finished; },
    // Mirrors createSender's abort (:131). Tells the sender to stop — it already
    // honors an inbound `cancel` frame (:103), so no protocol change — then fails
    // the receive. The persisted 'canceled' record is written by transfer-service's
    // cancel(), which owns the store for this path.
    abort(reason = 'aborted') {
      if (settled) return;
      try { if (jobId) channel.sendCtrl(cancelFrame(jobId)); } catch { /* best effort */ }
      onEvent({ type: 'canceled' });
      fail(new Error(reason));
    },
  };
}

// Multi-flow receiver: pairs with createMultiFlowSender. Reuses createReceiver's
// OFFER reassembly (offer / offer_begin->offer_entries*->offer_end) and its
// settled/abort discipline, but routes bulk bytes through Plan 1's
// createReceiveRouter (positional writeAt + per-file RangeSet) instead of a
// manifest-order cursor, since bytes now arrive striped across N independent
// flows in ARBITRARY order — a cursor assumes one strictly-ordered stream, which
// no longer holds.
//
// jobId is known up front (the pairing/rendezvous already assigned it), unlike
// single-flow createReceiver where it's learned from the wire OFFER — so every
// ctrl frame here (including the OFFER itself) is filtered by jobId match.
export function createMultiFlowReceiver({
  ctrl, flows, jobId, consent,
  // Accepted for forward interface compatibility with the paired sender's
  // constructor shape; this control flow only ever builds the manifest from the
  // wire OFFER (see beginReceive below) — there is no alternate entries source.
  entriesFromOffer = true,
  openPart, verifyAndFinalize,
  initialRangesFor = () => ({}),
  persistRanges = () => {},
  reportIntervalMs = 3000,
  // Bound each range_report ft-ctrl frame to the ~256KB data-channel message
  // limit (Plan 3): batchReportFiles measures actual SERIALIZED BYTES (not file
  // or interval counts — a fragmented file's ivals can blow the byte budget long
  // before any count cap would trip) and packs files into frames each under
  // reportMaxBytes; capIvals drops the smallest covered runs of an individual
  // over-budget file (harmless re-send, never over-reports). Each batch is a
  // valid full-snapshot subset, since createCoverageTracker.applyReport only
  // replaces coverage for files present in a given report.
  reportMaxBytes = 200000,
  // Mirrors createReceiver's inactivity watchdog (see its doc there): a
  // consented, active receive that stops getting ANY ctrl or bulk traffic
  // (sender vanished / connection dropped, on ANY of the N flows) must not
  // hang at 'active' forever. Armed only after accept; reset on every ctrl
  // frame and every bulk frame across every flow. Same default as single-flow.
  inactivityMs = 25000,
  onEvent = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let settled = false;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
  let reportTimer = null;
  const stopReporter = () => { if (reportTimer) { clearTimer(reportTimer); reportTimer = null; } };

  // Inactivity watchdog — mirrors createReceiver's (see its doc above it).
  let inactive = null;     // active timer handle, or null
  let watching = false;    // armed only between accept and settle
  const stopWatchdog = () => { if (inactive) { clearTimer(inactive); inactive = null; } };
  const pokeWatchdog = () => {
    if (!watching || settled || !(inactivityMs > 0)) return;
    if (inactive) clearTimer(inactive);
    inactive = setTimer(() => run(async () => {
      if (settled) return;
      stopReporter();
      onEvent({ type: 'interrupted' });
      fail(new Error('stalled'));
    }), inactivityMs);
    if (inactive && inactive.unref) inactive.unref();
  };

  // Fd-leak fix: mirrors createReceiver's closeOpenPartFiles-on-settle discipline
  // (see its doc above it) for the multi-flow router. A receive that settles
  // (cancel/stall/error) while a file is still mid-flight leaves that file's
  // sparse .part fd open (only a FINALIZED file's part gets closed, by
  // maybeFinalize) — on Windows this blocks deleting the temp/dest dir
  // (ENOTEMPTY) until the fd is released. Routed through run() (not called
  // directly) so it's queued behind any in-flight onBulkFrame/onFileHash
  // handler on the shared serializer — closing a fd mid-write would race it.
  //
  // Related (same class of bug, found while verifying the above deterministically):
  // beginReceive's accept-time persistRanges() write and tick()'s periodic one are
  // both fire-and-forget — nothing here previously awaited them. A cancel landing
  // immediately after accept could settle (and a caller could then delete the
  // destRoot/store dir) WHILE that write's tmp file was still open, the same
  // Windows fd-blocks-rmdir failure as the .part leak, just for the jobs-store
  // record instead of a part handle. `lastPersist` tracks whichever persistRanges
  // call was most recent (from either call site); the settle path below awaits it
  // before closing router parts, so neither write ever straddles the settle.
  let lastPersist = Promise.resolve();
  const closeRouterParts = async () => {
    try { await lastPersist; } catch { /* best effort — a failed persist must not block settling */ }
    if (router) await router.closeAll();
  };
  const resolveOnce = (v) => { if (!settled) { settled = true; watching = false; stopReporter(); stopWatchdog(); run(closeRouterParts).then(() => resolve(v)); } };
  const fail = (e) => { if (!settled) { settled = true; watching = false; stopReporter(); stopWatchdog(); run(closeRouterParts).then(() => reject(e)); } };
  const run = serializer(fail);

  let manifest = null;
  let router = null;
  let jobDoneSeen = false; // noted for observability; completion is driven by router.isComplete(), not this flag
  // Files the router has fully finalized (verified+fsync'd+renamed). Per receive
  // (this whole createMultiFlowReceiver instance handles exactly one receive —
  // beginReceive is guarded against re-entry — so a fresh Set at construction is
  // already "per receive").
  const finalizedFiles = new Set();
  // Reassembly buffer for a chunked OFFER (offer_begin -> offer_entries* -> offer_end).
  let offerAccum = null;

  function findEntry(fileId) { return manifest.entries.find((e) => e.fileId === fileId); }
  function pathOf(fileId) { const e = findEntry(fileId); return e ? e.path : undefined; }

  // router.rangesFor() OMITS finalized files entirely (transfer-receive-router.js)
  // — once a file finalizes it simply vanishes from every subsequent report. The
  // paired createMultiFlowSender's coverage tracker only REPLACES coverage for
  // files present in a report (never clears missing ones), so a finalized file's
  // last-known coverage freezes at whatever partial state it had before
  // finalizing — the sender's tracker.isComplete() then never converges, and its
  // pump() would spin forever re-reading/re-sending the whole payload every
  // reconcileWaitMs. Reporting EVERY manifest file on every report — finalized
  // ones as fully covered `[[0, size]]`, others from the router's live ranges —
  // keeps the sender's tracker moving toward real completion. (Plan 3's
  // paginated-range_report requirement — see the NOTE below — applies to this
  // full per-file list too.)
  function reportFiles() {
    const live = new Map(router.rangesFor().map((r) => [r.fileId, r.ivals]));
    return manifest.entries.map((e) => (finalizedFiles.has(e.fileId)
      ? { fileId: e.fileId, ivals: [[0, e.size]] }
      : { fileId: e.fileId, ivals: live.get(e.fileId) || [] }));
  }

  // Sends the receiver's current per-file coverage so the paired
  // createMultiFlowSender's reconciliation loop can see what's still missing.
  // Reports are byte-bounded via batchReportFiles — it measures actual
  // serialized bytes and emits one range_report ft-ctrl frame PER BATCH, so no
  // single frame can exceed the ~256KB data-channel message limit (the same
  // failure mode the OFFER hit for many-file manifests). capIvals (used
  // internally by batchReportFiles) may drop the smallest covered runs of an
  // extremely fragmented single file to keep it within budget — those bytes are
  // simply re-sent later, never over-reported.
  function sendReport() {
    if (settled || !router) return;
    const batches = batchReportFiles(reportFiles(), { maxBytes: reportMaxBytes });
    for (const files of batches) ctrl.sendCtrl(rangeReportFrame({ jobId, files }));
  }

  function tick() {
    if (settled || !router) return;
    sendReport();
    lastPersist = Promise.resolve(persistRanges(reportFiles()));
    reportTimer = setTimer(tick, reportIntervalMs);
    if (reportTimer && reportTimer.unref) reportTimer.unref();
  }
  function startReporter() {
    reportTimer = setTimer(tick, reportIntervalMs);
    if (reportTimer && reportTimer.unref) reportTimer.unref();
  }

  // Checked after every finalize (via onFileDone below) and after job_done —
  // router.isComplete() means every manifest file is written+hashed+verified,
  // which is real completion regardless of whether job_done has been SEEN yet
  // (ft-ctrl frames are independently ordered from bulk delivery, and a fully
  // resumed/short job can finish before job_done's frame is even processed).
  function maybeComplete() {
    if (settled || !router) return;
    if (!router.isComplete()) return;
    ctrl.sendCtrl(completeFrame({ jobId, ok: true }));
    stopReporter();
    onEvent({ type: 'completed' });
    resolveOnce({ jobId, ok: true });
  }

  async function beginReceive(entries) {
    if (settled) return;
    const m = buildManifest(entries);
    manifest = m;
    ctrl.sendCtrl(promptingFrame({ jobId }));
    const consented = await consent({ jobId, manifest: m });
    if (settled) return;
    if (!consented) {
      ctrl.sendCtrl(rejectFrame({ jobId, reason: 'declined' }));
      resolveOnce({ jobId, ok: false });
      return;
    }
    // Memoize each file's open partFile by fileId: the router closes its own
    // `f.part` handle before calling verifyAndFinalize (so it can't hand us the
    // handle directly), but the REAL finalizeReceivedFile({ partFile, ... }) needs
    // it (for partPath/finalPath/liveDigest — a closed handle object still
    // provides all three, since liveDigest() for the sparse writer is always
    // null and just triggers a completion hashFile read). Recorded on every
    // openPart call (including a post-resetFile reopen), so the map entry is
    // always the CURRENT part for that fileId.
    const partFiles = new Map();
    router = createReceiveRouter({
      manifest: m,
      initialRanges: initialRangesFor(m),
      openPart: async (fileId) => {
        const p = await openPart(pathOf(fileId));
        partFiles.set(fileId, p);
        return p;
      },
      verifyAndFinalize: ({ fileId, expectedHash }) => verifyAndFinalize({ ...findEntry(fileId), expectedHash, partFile: partFiles.get(fileId) }),
      onFileDone: ({ fileId, ok: fileOk }) => {
        if (fileOk) finalizedFiles.add(fileId);
        else router.resetFile(fileId);
        onEvent({ type: fileOk ? 'file-done' : 'file-failed', fileId });
        maybeComplete();
      },
      onProgress: (p) => onEvent({ type: 'progress', ...p }),
    });
    for (const flow of flows) flow.onBulk((buf) => run(() => { pokeWatchdog(); return router.onBulkFrame(buf); }));
    if (settled) return;
    ctrl.sendCtrl(acceptFrame({ jobId, resume: [], ranges: reportFiles() }));
    // Persist the jobs-store record ONCE, immediately — mirrors createReceiver's
    // immediate saveRecord('active') on accept. Without this, the record only
    // ever gets written by the periodic tick() below (~reportIntervalMs later,
    // default 3s), so a receive canceled/interrupted within that window leaves
    // NO store record at all: it vanishes from the Transfers list and can never
    // be resumed. This call is independent of (and precedes) the first tick.
    // Tracked in `lastPersist` (not awaited here — this fire-and-forget write
    // must not block accepting bulk traffic) so a settle landing before it
    // finishes still waits for it in closeRouterParts, above.
    lastPersist = Promise.resolve(persistRanges(reportFiles()));
    sendReport();
    startReporter();
    watching = true; pokeWatchdog(); // now expecting a steady stream of ctrl/bulk traffic
  }

  ctrl.onCtrl((str) => run(async () => {
    pokeWatchdog(); // fresh ctrl frame — the transfer is alive
    if (settled) return;
    const f = parseCtrlFrame(str);
    if (!f || f.jobId !== jobId) return;
    if (f.t === 'cancel') {
      onEvent({ type: 'canceled' });
      stopReporter();
      fail(new Error('canceled'));
      return;
    }
    if (f.t === 'offer') {
      if (router || offerAccum) return;
      await beginReceive(f.entries);
      return;
    }
    if (f.t === 'offer_begin') {
      if (router || offerAccum) return;
      offerAccum = { entries: [] };
      return;
    }
    if (f.t === 'offer_entries') {
      if (offerAccum) for (const e of f.entries) offerAccum.entries.push(e);
      return;
    }
    if (f.t === 'offer_end') {
      if (!offerAccum) return;
      const entries = offerAccum.entries; offerAccum = null;
      await beginReceive(entries);
      return;
    }
    if (f.t === 'file_end') {
      if (!router) return;
      await router.onFileHash(f.fileId, f.hash);
      sendReport();
      maybeComplete();
      return;
    }
    if (f.t === 'job_done') {
      jobDoneSeen = true;
      sendReport();
      maybeComplete();
      return;
    }
  }));

  return {
    start() { return finished; },
    // Mirrors createReceiver's abort: tell the sender to stop, then fail. The
    // paired createMultiFlowSender already honors an inbound `cancel` frame.
    abort(reason = 'aborted') {
      if (settled) return;
      try { ctrl.sendCtrl(cancelFrame(jobId)); } catch { /* best effort */ }
      onEvent({ type: 'canceled' });
      fail(new Error(reason));
    },
  };
}
