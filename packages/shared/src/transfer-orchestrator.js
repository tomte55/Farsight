// packages/shared/src/transfer-orchestrator.js
// SP3 MAIN-ONLY send/receive drivers over an abstract channel (ft-ctrl JSON +
// ft-bulk bytes). Coordinates the pure engine + io + jobs-store + protocol.
// ft-ctrl and ft-bulk are INDEPENDENTLY ordered — the receiver routes bulk by
// counting against manifest sizes, and all handlers are serialized. See spec §5/§6.
import {
  offerFrame, offerBeginFrame, offerEntriesFrame, offerEndFrame,
  fileEndFrame, jobDoneFrame, acceptFrame, rejectFrame, promptingFrame, completeFrame,
  cancelFrame, parseCtrlFrame, rangeReportFrame,
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
import { buildManifest } from './transfer-manifest.js';
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

// Multi-flow sender: stripes chunks across N bulk flows (Plan 1's send-pool),
// tracks the RECEIVER's confirmed coverage (Plan 1's reconcile tracker) rather
// than a local send-queue, and re-drives any gap the tracker still shows after
// each pass — so a dropped chunk on a dead/rejecting flow gets re-sent without
// the sender ever needing to know WHICH flow failed. Coverage-defined completion
// (not queue-defined) is the whole point: `job_done` only goes out once the
// tracker says every byte is covered, and even then the driver doesn't resolve
// until the receiver's `complete` ack lands (same discipline the single-flow
// sender driver used before it was removed — Phase 2 Task 3).
export function createSender({
  ctrl: ctrl0, flows, jobId, manifest, chunkSize = 131072, flowCount, groupId,
  readerFor, newHash = () => createHash('sha256'),
  // Resilient multi-flow: the supervisor's starvation waiter. The send pool
  // awaits it (instead of throwing no_live_flows) when it has a chunk to send
  // but no live flow yet — a staggered dial still in progress, or every flow
  // transiently lost — and it only rejects once every slot is exhausted. Absent
  // (single-flow/legacy, or a caller that opened a static flow set) → the pool
  // keeps its old throw-immediately-on-starvation behavior.
  awaitFlow,
  onEvent = () => {},
  offerBatchBytes = 49152,
  completionTimeoutMs = 120000,
  reconcileWaitMs = 3000,
  // Sender-side inactivity/stall watchdog for a GENUINE WEDGE — bytes should be
  // moving (a flow is alive) but no receiver range_report has arrived within the
  // bound. Mirrors createReceiver's ~25s inactivity watchdog: armed at
  // accept (pump start), reset on every inbound range_report (the receiver's
  // liveness signal — time-driven ~reportIntervalMs in a healthy transfer, so
  // steady progress can't false-trip it), and disarmed at `all-sent` (the
  // no_confirmation completion timer owns the drain phase) and on settle. On
  // expiry it fail('stalled')s so the app's existing fail->auto-resume path takes
  // over. 0 disables (single-flow/legacy).
  //
  // Task 6 (common-mode-resilience) — the watchdog is GATED so it does NOT fire
  // during a legitimate total-outage GENTLE RECOVERY. With the flow supervisor's
  // Tasks 2-4, a common-mode outage (all N flows share one satellite/TURN path,
  // so they drop together) now KEEPS the session alive and re-dials for up to
  // outageGiveupMs; an unrecoverable outage ends by the supervisor's OWN outage
  // timer, which rejects awaitFlow (`outage_giveup` → the pool throws, failing
  // the send through that path). If the watchdog fired blindly at ~25s into such
  // an outage it would re-introduce the whole-transfer resume loop this phase
  // exists to eliminate. So on expiry the watchdog consults `watchdogGate()`:
  //   true  -> a real wedge (≥1 flow ALIVE, or the supervisor has GIVEN UP) -> fail('stalled')
  //   false -> a total outage still being gently recovered (0 live flows, not yet
  //            given up) -> DON'T fail; re-arm and keep watching.
  // (The stale rationale this block used to carry — "a stuck 'disconnected' slot
  // means awaitFlow never rejects" — no longer holds: the supervisor's time-based
  // outage timer guarantees awaitFlow eventually rejects, so the watchdog's job is
  // now just the alive-but-stalled wedge, not compensating for a wedged waiter.)
  // Default `() => true` preserves single-flow/legacy/static-flow-set behavior (no
  // supervisor behind the flows to recover an outage — so any stall IS terminal).
  inactivityMs = 25000, watchdogGate = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout,
  // Per-chunk progress would flood IPC; throttle to a human-legible cadence,
  // same discipline the removed single-flow sender driver's emitProgress used.
  // Clock injected for tests.
  progressIntervalMs = 250, now = () => Date.now(),
  // Task 9: cumulative re-dial count this transfer, read live at each progress
  // emit — the flow supervisor's counter (threaded via assembleSendFlows'
  // redialCount), 0 if the caller doesn't wire one (single-flow/legacy, or a
  // static flow set with no supervisor behind it).
  redialCount = () => 0,
  // Plan 3 Task 6: optional shared { take(n) } rate limiter, threaded straight
  // into the send pool (the ONE choke point where every flow's bulk send goes
  // out — see transfer-send-pool.js) so ONE instance paces the aggregate byte
  // rate across all N flows. Absent -> byte-for-byte unchanged (guarded there).
  limiter,
}) {
  if (typeof readerFor !== 'function') throw new Error('readerFor is required');

  // The ctrl channel (flow 0's ft-ctrl) is held in a MUTABLE ref, not a fixed
  // capture: when the supervisor re-dials a dead slot 0, setCtrl(newChannel)
  // reassigns it so every ctrl.sendCtrl(...) site below (file_end, job_done, the
  // OFFER, and setCtrl's re-send) goes out on the live channel, and the range_report
  // handler re-attaches to it. See setCtrl / attachCtrl below.
  let ctrl = ctrl0;

  // Task 9: a SINGLE persistent send pool for the whole transfer (both the
  // initial pass and every later gap pass reuse it — see pump() below), so its
  // aliveCount() is a live, queryable read of "how many flows are usable RIGHT
  // NOW" for the aggregate progress health fields. Previously each pass built
  // its own throwaway createSendPool; reusing one changes nothing observable
  // about dispatch (usableFlows() already re-filters the live `flows` array
  // fresh on every call) but gives emitProgress somewhere to read from.
  const pool = createSendPool({ flows, awaitFlow, limiter });

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
  // Final-review #2 stall watchdog state (armed in pump(), see inactivityMs above).
  let inactive = null;     // active timer handle, or null
  let watching = false;    // armed only between accept (pump start) and all-sent/settle
  const stopWatchdog = () => { if (inactive) { clearTimer(inactive); inactive = null; } };
  const resolveOnce = (v) => { if (!settled) { settled = true; watching = false; stopWatchdog(); clearCompletion(); resolve(v); } };
  const fail = (e) => { if (!settled) { settled = true; watching = false; stopWatchdog(); clearCompletion(); reject(e); } };
  const run = serializer(fail);
  // Arm (or reset) the stall watchdog. Called at pump start and on every inbound
  // range_report (liveness). ≤ 1 timer at a time.
  const armWatchdog = () => {
    if (!watching || settled || !(inactivityMs > 0)) return;
    if (inactive) clearTimer(inactive);
    inactive = setTimer(onWatchdogExpiry, inactivityMs);
    if (inactive && inactive.unref) inactive.unref();
  };
  // On expiry, only fail on a GENUINE wedge (gate open: ≥1 flow alive, or the
  // supervisor has given up). While a total outage is still being gently
  // recovered (gate closed) don't fail — re-arm and keep watching, so a wedge
  // that develops AFTER a flow returns is still caught, and an outage that never
  // recovers is failed by the supervisor's awaitFlow reject, not by us.
  function onWatchdogExpiry() {
    if (settled || !watching) return;
    if (watchdogGate()) { fail(new Error('stalled')); return; }
    armWatchdog();
  }
  const pokeWatchdog = armWatchdog;

  // Each file's hash, computed once by the initial full-file read (below) and
  // reused by any later gap pass's re-sent file_end — a resumed, already
  // byte-complete file still gets hashed+file_end here (the bug this fixes: a
  // file the accept-time coverage already reports complete previously never
  // got read/hashed at all, so its file_end never went out and the receiver
  // could never finalize it).
  const fileHash = new Map();

  // Throttled AGGREGATE progress from the coverage tracker (the sender's
  // authoritative record of what the RECEIVER has confirmed) — mirrors the
  // removed single-flow sender driver's emitProgress. Computed whenever a
  // range_report is applied (tracker.applyReport), so it always reflects real, confirmed
  // delivery, never merely-queued bytes.
  let lastProgressAt = 0;
  function emitProgress() {
    const t = now();
    if (t - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = t;
    let sent = 0, filesSent = 0;
    for (const file of manifest.entries) {
      sent += Math.min(tracker.coveredFor(file.fileId).coveredBytes(), file.size);
      if (tracker.coveredFor(file.fileId).isComplete(file.size)) filesSent += 1;
    }
    onEvent({
      type: 'progress',
      progress: {
        sent, total: totalBytes, fraction: totalBytes > 0 ? sent / totalBytes : 1,
        filesSent, filesTotal: totalFiles,
        // Task 9: per-flow health, for the transfer detail UI. flowsLive is a
        // LIVE read of the pool's usable-flow count (never hardcoded to
        // flowCount — a re-dial in progress or a dead slot must show through);
        // flowsTotal is the target slot count; redials is the supervisor's
        // cumulative counter (0 if none is wired).
        flowsLive: pool.aliveCount(), flowsTotal: flowCount, redials: redialCount(),
      },
    });
  }

  // Emits 'file-sent' the moment the tracker reports a file fully covered
  // (confirmed by the RECEIVER, not merely queued) — each fileId reported once.
  const sentFiles = new Set();
  function checkFileSent() {
    for (const file of manifest.entries) {
      if (sentFiles.has(file.fileId)) continue;
      if (tracker.coveredFor(file.fileId).isComplete(file.size)) {
        sentFiles.add(file.fileId);
        onEvent({ type: 'file-sent', fileId: file.fileId });
      }
    }
  }

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
    watching = true; pokeWatchdog(); // now actively sending — a stall must not hang forever
    try {
      await pool.run(initialPass());
      for (;;) {
        // `settled` is the backstop: the receiver's own `complete`/`reject`/
        // `cancel` frame settles this driver directly (see the ctrl handler
        // below), but router.rangesFor() omits finalized files from every
        // report (fixed on the receiver side too — see reportFiles() in
        // createReceiver), so tracker.isComplete() alone is not
        // guaranteed reachable against every receiver implementation. Without
        // this check the loop would keep re-reading/re-sending the whole
        // payload every reconcileWaitMs forever, even after the transfer has
        // already resolved.
        if (canceled || settled) return;
        if (tracker.isComplete()) break;
        await waitForReport(reconcileWaitMs);
        if (canceled || settled) return;
        if (tracker.isComplete()) break;
        await pool.run(gapPass());
      }
    } catch (e) {
      fail(e); // includes 'no_live_flows' — never spin against a dead flow set
      return;
    }
    ctrl.sendCtrl(jobDoneFrame({ jobId }));
    onEvent({ type: 'all-sent' });
    // Every byte is on the wire — hand the drain phase to the no_confirmation
    // completion timer below and disarm the stall watchdog (otherwise it could
    // trip during a legitimate final-verify wait, and it would double-cover a
    // phase the completion timer already owns).
    watching = false; stopWatchdog();
    if (!settled && completionTimeoutMs > 0) {
      completionTimer = setTimer(() => fail(new Error('no_confirmation')), completionTimeoutMs);
      if (completionTimer && completionTimer.unref) completionTimer.unref();
    }
  }

  // Attach the range_report/complete/reject/cancel/accept handler to a ctrl
  // channel. The handler is gated on `ch === ctrl` (the current live channel), so
  // once setCtrl swaps to a re-dialed channel, the OLD channel's handler — still
  // wired to a now-dead data channel — can no longer drive state even if a late
  // frame arrives on it.
  function attachCtrl(ch) {
    ch.onCtrl((str) => run(async () => {
    if (ch !== ctrl) return;
    const f = parseCtrlFrame(str);
    if (!f || f.jobId !== jobId) return;
    if (f.t === 'prompting') { onEvent({ type: 'prompting' }); return; }
    if (f.t === 'complete') {
      // complete{ok:false} used to fail() the sender ('receiver_incomplete'),
      // which the caller (transfer-service.js) treats as a recoverable
      // failure for own-fleet/contact -> auto-resume kicks in and re-sends.
      // But by the time the receiver sends `complete` at all, ITS OWN
      // reconciliation has already retried everything it can — a per-file
      // terminal I/O failure on the receiver won't be fixed by the sender
      // re-sending the same bytes again. Resolving here (done-with-failures)
      // instead of failing is what stops that resend/re-fail loop.
      if (f.ok) { onEvent({ type: 'completed' }); resolveOnce({ jobId, ok: true }); }
      else { onEvent({ type: 'completed', ok: false }); resolveOnce({ jobId, ok: false }); }
      return;
    }
    if (f.t === 'reject') { onEvent({ type: 'declined', reason: f.reason }); fail(new Error(`rejected: ${f.reason}`)); return; }
    if (f.t === 'cancel') {
      onEvent({ type: 'canceled' }); canceled = true;
      if (pendingWaiterResolve) pendingWaiterResolve();
      fail(new Error('canceled'));
      return;
    }
    if (f.t === 'range_report') {
      tracker.applyReport(f.files);
      pokeWatchdog(); // fresh receiver report — the control plane + transfer are alive
      emitProgress();
      checkFileSent();
      if (pendingWaiterResolve) pendingWaiterResolve();
      return;
    }
    // pump() is intentionally NOT awaited here — same reasoning as the removed
    // single-flow sender driver's pump: it must run outside the serializer chain so a later `cancel` can
    // still get processed (and observed by the `canceled` flag) while pump is
    // mid-flight, rather than queuing behind it.
    if (f.t === 'accept' && !pumped) {
      pumped = true;
      tracker.applyReport(f.ranges || []);
      onEvent({ type: 'accepted' });
      emitProgress();
      checkFileSent();
      pump().catch(fail);
    }
    }));
  }
  attachCtrl(ctrl);

  // Send the OFFER on the CURRENT ctrl channel — a small manifest as one legacy
  // `offer` frame (an older receiver understands it), a large one chunked so no
  // single ft-ctrl message exceeds the channel limit. Reused by both start() and
  // setCtrl (the re-send is idempotent on the receiver per Task 5).
  function sendOffer() {
    const batches = batchEntriesBySize(manifest.entries, offerBatchBytes);
    if (batches.length <= 1) {
      ctrl.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes, totalFiles, flowCount, groupId }));
    } else {
      ctrl.sendCtrl(offerBeginFrame({ jobId, totalBytes, totalFiles, flowCount, groupId }));
      for (const b of batches) ctrl.sendCtrl(offerEntriesFrame({ jobId, entries: b }));
      ctrl.sendCtrl(offerEndFrame({ jobId }));
    }
  }

  return {
    start() {
      sendOffer();
      return finished;
    },
    // Hand the control plane over to a re-dialed replacement ctrl channel (the
    // supervisor re-dials a dead slot 0 in a later task; this is the sender-side
    // hook it calls). Reassign the mutable ref so all subsequent ctrl.sendCtrl
    // sites use it, re-attach the range_report handler (attachCtrl's stale-channel
    // gate then makes the OLD channel's handler inert), and re-send the OFFER on
    // the new channel to re-sync the receiver — idempotent per Task 5. Used only
    // once a receive is active (a real re-dial happens mid-transfer).
    setCtrl(newChannel) {
      ctrl = newChannel;
      attachCtrl(newChannel);
      sendOffer();
    },
    // Mirrors the removed single-flow sender driver's abort. Also wakes a
    // pump() parked in waitForReport so the pass loop observes `canceled`
    // promptly instead of idling out the full reconcileWaitMs before it gets a
    // chance to check.
    abort(reason = 'aborted') {
      canceled = true;
      if (pendingWaiterResolve) pendingWaiterResolve();
      fail(new Error(reason));
    },
    // F-A7: mirrors the removed single-flow sender driver's notifyCancel.
    // Sends on the CURRENT ctrl channel (the
    // mutable `ctrl`, kept live across a slot-0 re-dial by setCtrl) so the cancel
    // frame goes out on whichever channel is actually connected.
    notifyCancel() { try { ctrl.sendCtrl(cancelFrame(jobId)); } catch { /* best effort */ } },
  };
}

// Multi-flow receiver: pairs with createSender. Reuses the removed
// single-flow receiver driver's OFFER reassembly (offer / offer_begin->
// offer_entries*->offer_end) and its settled/abort discipline, but routes bulk
// bytes through Plan 1's createReceiveRouter (positional writeAt + per-file
// RangeSet) instead of a manifest-order cursor, since bytes now arrive striped
// across N independent flows in ARBITRARY order — a cursor assumes one
// strictly-ordered stream, which no longer holds.
//
// jobId is known up front (the pairing/rendezvous already assigned it), unlike
// the removed single-flow receiver driver, where it was learned from the wire
// OFFER — so every ctrl frame here (including the OFFER itself) is filtered by
// jobId match.
export function createReceiver({
  ctrl: ctrl0, flows, jobId, consent,
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
  // Mirrors the removed single-flow receiver driver's inactivity watchdog: a
  // consented, active receive that stops getting ANY ctrl or bulk traffic
  // (sender vanished / connection dropped, on ANY of the N flows) must not
  // hang at 'active' forever. Armed only after accept; reset on every ctrl
  // frame and every bulk frame across every flow. Same default as single-flow.
  inactivityMs = 25000,
  onEvent = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
  // Bounds the settle-path close/persist await (see boundedSettleClose below):
  // a wedged part.close() or jobs-store write must not hang the whole receive
  // forever. Generous default — the close/persist normally lands in well under
  // a second — but injectable so a test can prove the bound without a real
  // multi-second wait.
  closeTimeoutMs = 5000,
  // Per-chunk progress would flood IPC (mirrors the removed single-flow
  // receiver driver's emitProgress); throttle to a human-legible cadence. Clock injected for tests.
  progressIntervalMs = 250, now = () => Date.now(),
  // Forwarded to createReceiveRouter's per-file I/O failure isolation (bounded
  // retry of a failing open/write before giving up on that one file) — see its
  // own doc in transfer-receive-router.js. Injectable so a test can prove the
  // retry/terminal-failure path without waiting through real backoff delays.
  retryDelays, delay,
}) {
  // The ctrl channel is held in a MUTABLE ref (mirrors createSender): a
  // re-dialed slot 0 is handed over via setCtrl, so every ctrl.sendCtrl(...) site
  // (accept, range_report, complete, reject, cancel) uses the live channel and the
  // inbound handler re-attaches to it. See setCtrl / attachCtrl below.
  let ctrl = ctrl0;
  let settled = false;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
  let reportTimer = null;
  const stopReporter = () => { if (reportTimer) { clearTimer(reportTimer); reportTimer = null; } };

  // Inactivity watchdog — mirrors the removed single-flow receiver driver's.
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

  // Fd-leak fix: mirrors the removed single-flow receiver driver's
  // closeOpenPartFiles-on-settle discipline for the multi-flow router. A receive that settles
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
  // Bounds the settle-path close/persist await: router.closeAll() (or the
  // persist it awaits first) can wedge — this codebase has a Windows
  // wedged-fd history — and without a bound that would hang the whole receive
  // (and its start() caller) forever. A leaked fd is strictly better than a
  // hung receive, so once closeTimeoutMs elapses, proceed to settle ANYWAY;
  // the close keeps running in the background (best effort), it's just no
  // longer awaited. The normal case (close/persist complete fast) is
  // unaffected — it still settles only AFTER they land, preserving the
  // deterministic-close-before-settle discipline that fixed the ENOTEMPTY
  // bug. Whichever finishes first (the close, or the timeout) clears the
  // other side, so no dangling timer and no double-settle.
  function boundedSettleClose() {
    return new Promise((res) => {
      let done = false;
      const timer = setTimer(() => { if (done) return; done = true; res(); }, closeTimeoutMs);
      if (timer && timer.unref) timer.unref();
      run(closeRouterParts).then(
        () => { if (done) return; done = true; clearTimer(timer); res(); },
        () => { if (done) return; done = true; clearTimer(timer); res(); },
      );
    });
  }
  const resolveOnce = (v) => { if (!settled) { settled = true; watching = false; stopReporter(); stopWatchdog(); boundedSettleClose().then(() => resolve(v)); } };
  const fail = (e) => { if (!settled) { settled = true; watching = false; stopReporter(); stopWatchdog(); boundedSettleClose().then(() => reject(e)); } };
  const run = serializer(fail);

  let manifest = null;
  let router = null;
  let jobDoneSeen = false; // noted for observability; completion is driven by router.isComplete(), not this flag
  // Files the router has fully finalized (verified+fsync'd+renamed). Per receive
  // (this whole createReceiver instance handles exactly one receive —
  // beginReceive is guarded against re-entry — so a fresh Set at construction is
  // already "per receive").
  const finalizedFiles = new Set();
  // Files the router gave up on permanently (a persistent I/O failure — e.g. an
  // AV-locked .part — survived its bounded retries). Distinct from a verify
  // MISMATCH (router.onFileDone({ok:false}) with no `terminal` flag), which
  // stays retryable via router.resetFile — see the onFileDone handler in
  // beginReceive below. A terminally-failed file is resolved-but-failed: it
  // counts toward completion (router.isComplete()) and is reported fully
  // covered (reportFiles(), below) so the paired sender's coverage tracker
  // converges instead of re-sending into the same failure forever.
  const terminalFailedFiles = new Set();
  // Reassembly buffer for a chunked OFFER (offer_begin -> offer_entries* -> offer_end).
  let offerAccum = null;

  function findEntry(fileId) { return manifest.entries.find((e) => e.fileId === fileId); }
  function pathOf(fileId) { const e = findEntry(fileId); return e ? e.path : undefined; }

  // Detects the verify-only TAIL: every file's bytes are fully in (per the
  // router's coverage — coveredBytesFor counts a finalized file as fully
  // covered too, so this stays true once files start finishing) but not every
  // file has finalized (verified+fsync'd+renamed) yet. Mirrors the removed
  // single-flow receiver driver's `if (pending.size > 0) onEvent({type:'verifying'})` on
  // job_done — same intent, computed from the router's coverage instead of a
  // pending-map, since multi-flow completion is coverage-defined, not a
  // job_done-first sequencing. Fires ONCE per transition (guarded by
  // verifyingEmitted) so a flood of harmless duplicate/gap-resend bulk frames
  // after all bytes are already in doesn't re-emit it every frame. Reset on a
  // verify FAILURE (router.resetFile via onFileDone below) so a genuine retry
  // cycle — bytes come back in, finalize again — can re-surface the label.
  let verifyingEmitted = false;
  function checkVerifying() {
    if (settled || verifyingEmitted || !router || !manifest) return;
    if (finalizedFiles.size + terminalFailedFiles.size >= manifest.entries.length) return; // nothing left to verify
    let received = 0, total = 0;
    for (const e of manifest.entries) { total += e.size; received += router.coveredBytesFor(e.fileId); }
    if (total > 0 && received < total) return; // still mid-transfer — not the verify tail
    verifyingEmitted = true;
    onEvent({
      type: 'verifying',
      progress: {
        received, total, fraction: total > 0 ? received / total : 1,
        filesDone: finalizedFiles.size, filesTotal: manifest.entries.length,
      },
    });
  }

  // Throttled AGGREGATE progress — the per-file {fileId, coveredBytes, size} the
  // router's onProgress used to pass straight through was the wrong shape for the
  // UI (which wants one number for the whole job) AND unthrottled (a flood over
  // IPC). Computed from the manifest + router's per-file coverage (a finalized
  // file counts as fully covered via coveredBytesFor — see its doc in
  // transfer-receive-router.js). Mirrors the removed single-flow receiver driver's emitProgress.
  let lastProgressAt = 0;
  function emitProgress() {
    if (!router || !manifest) return;
    const t = now();
    if (t - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = t;
    let received = 0, total = 0;
    for (const e of manifest.entries) {
      total += e.size;
      received += router.coveredBytesFor(e.fileId);
    }
    onEvent({
      type: 'progress',
      progress: {
        received, total, fraction: total > 0 ? received / total : 1,
        filesDone: finalizedFiles.size, filesTotal: manifest.entries.length,
      },
    });
  }

  // router.rangesFor() OMITS finalized files entirely (transfer-receive-router.js)
  // — once a file finalizes it simply vanishes from every subsequent report. The
  // paired createSender's coverage tracker only REPLACES coverage for
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
    // A terminally-failed file is reported fully covered too, alongside a
    // finalized one — otherwise the paired sender's coverage tracker never
    // converges for it and keeps re-sending into the same I/O failure forever
    // (the receiver just fails it again -> the exact loop this feature fixes).
    return manifest.entries.map((e) => ((finalizedFiles.has(e.fileId) || terminalFailedFiles.has(e.fileId))
      ? { fileId: e.fileId, ivals: [[0, e.size]] }
      : { fileId: e.fileId, ivals: live.get(e.fileId) || [] }));
  }

  // Sends the receiver's current per-file coverage so the paired
  // createSender's reconciliation loop can see what's still missing.
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
    // Every file has reached a resolved state (finalized OR terminally
    // failed). ok reflects whether ANY file terminally failed — but either
    // way this is a genuine, terminal COMPLETION: resolve (never reject), so
    // a completed-with-failures receive reads as done, not interrupted, and
    // does not trip auto-resume into re-fetching the same doomed file.
    const ok = terminalFailedFiles.size === 0;
    ctrl.sendCtrl(completeFrame({ jobId, ok }));
    stopReporter();
    onEvent({ type: 'completed', ok });
    resolveOnce({ jobId, ok });
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
    // The receiver now has the manifest and has committed to receiving. Surface
    // it so the UI can label the transfer (file/folder name + count) and leave
    // "Waiting for approval" — mirrors the removed single-flow receiver driver's `accepted`.
    onEvent({ type: 'accepted', manifest: m });
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
        // Pass the final size so the sparse writer can preallocate the .part
        // (contiguous layout, sequential finalize read) — see createSparsePartFile.
        const p = await openPart(pathOf(fileId), findEntry(fileId)?.size);
        partFiles.set(fileId, p);
        return p;
      },
      verifyAndFinalize: ({ fileId, expectedHash }) => verifyAndFinalize({ ...findEntry(fileId), expectedHash, partFile: partFiles.get(fileId) }),
      onFileDone: ({ fileId, ok: fileOk, terminal }) => {
        if (fileOk) {
          finalizedFiles.add(fileId);
        } else if (terminal) {
          // Persistent I/O failure (router gave up after bounded retries) —
          // TERMINAL, unlike a verify-mismatch: do NOT resetFile/retry (the
          // router itself now CLOSES the file's open .part handle, then nulls
          // it, before giving up — so there's no open handle left for us to
          // manage here); it now counts as resolved for isComplete()/
          // reportFiles() purposes.
          terminalFailedFiles.add(fileId);
        } else {
          router.resetFile(fileId); verifyingEmitted = false; // verify-mismatch: real retry cycle — allow re-surfacing
        }
        onEvent({ type: fileOk ? 'file-done' : 'file-failed', fileId, ...(terminal ? { reason: 'io_error' } : {}) });
        maybeComplete();
      },
      onProgress: () => { emitProgress(); checkVerifying(); },
      ...(retryDelays !== undefined ? { retryDelays } : {}),
      ...(delay !== undefined ? { delay } : {}),
    });
    for (const flow of flows) flow.onBulk((buf) => run(() => { pokeWatchdog(); return router.onBulkFrame(buf); }));
    if (settled) return;
    ctrl.sendCtrl(acceptFrame({ jobId, resume: [], ranges: reportFiles() }));
    // Persist the jobs-store record ONCE, immediately — mirrors the removed
    // single-flow receiver driver's immediate saveRecord('active') on accept. Without this, the record only
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

  // Attach the inbound ctrl handler (offer/accept/file_end/job_done/cancel) to a
  // ctrl channel, gated on `ch === ctrl` so a superseded channel's late frames
  // can't drive state once setCtrl swaps to a re-dialed one.
  function attachCtrl(ch) {
    ch.onCtrl((str) => run(async () => {
    if (ch !== ctrl) return;
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
      // Backstop for checkVerifying's normal onProgress trigger: covers the
      // (unusual) case where the last bytes landed without a following bulk
      // frame ever calling onProgress again (e.g. a manifest whose only
      // remaining file is zero-length, so no bulk frame arrives for it at
      // all) — job_done is the one guaranteed later signal.
      checkVerifying();
      maybeComplete();
      return;
    }
    }));
  }
  attachCtrl(ctrl);

  return {
    start() { return finished; },
    // Hand the control plane over to a re-dialed replacement ctrl channel (the
    // supervisor re-dials a dead slot 0 in a later task; this is the receiver-side
    // hook it calls). Reassign the mutable ref so the receiver's own emitted ctrl
    // (range_report/complete/…) goes out on the new channel, and re-attach the
    // inbound handler — attachCtrl's stale-channel gate then makes the OLD
    // channel's handler inert. No OFFER re-send here (that's the sender's job).
    setCtrl(newChannel) {
      ctrl = newChannel;
      attachCtrl(newChannel);
    },
    // Mirrors the removed single-flow receiver driver's abort: tell the sender to stop, then fail. The
    // paired createSender already honors an inbound `cancel` frame.
    abort(reason = 'aborted') {
      if (settled) return;
      try { ctrl.sendCtrl(cancelFrame(jobId)); } catch { /* best effort */ }
      onEvent({ type: 'canceled' });
      fail(new Error(reason));
    },
    // Lets a re-dialed REPLACEMENT flow join a receive already in progress (the
    // supervisor's re-dial + the group rendezvous' onFlowJoin are a later
    // task's job — this is just the receiver-side hook they call). Wires the
    // new flow's onBulk EXACTLY like the initial `for (const flow of flows)`
    // loop in beginReceive above: chunks are self-addressed (fileId+offset), so
    // the router is flow-agnostic — any flow's bytes land in the same place.
    // flowIndex isn't used here (bulk routing needs no per-flow bookkeeping);
    // it's accepted for interface parity with the sender/supervisor side and
    // for future diagnostics. A no-op if the receive hasn't begun yet (no
    // router to route into) or has already settled.
    addFlow(channel, flowIndex) {
      if (settled || !router) return;
      channel.onBulk((buf) => run(() => { pokeWatchdog(); return router.onBulkFrame(buf); }));
    },
  };
}
