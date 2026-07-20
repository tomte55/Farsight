// packages/shared/src/transfer-sender.js
// SP3 MAIN-ONLY send driver over an abstract channel (ft-ctrl JSON + ft-bulk
// bytes). Coordinates the pure engine + io + jobs-store + protocol. Split out of
// the former transfer-orchestrator.js (Phase 2 Task 5, R7) — this file holds only
// the sender side; see transfer-receiver.js for its paired createReceiver.
import {
  offerFrame, offerBeginFrame, offerEntriesFrame, offerEndFrame,
  fileEndFrame, jobDoneFrame, cancelFrame, parseCtrlFrame,
} from './transfer-protocol.js';
import { createHash } from 'node:crypto';
import { createChunkProducer } from './transfer-producer.js';
import { createSendPool } from './transfer-send-pool.js';
import { createCoverageTracker } from './transfer-reconcile.js';
import { batchEntriesBySize, serializer } from './transfer-orchestrator-shared.js';

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
