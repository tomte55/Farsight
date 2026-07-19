// packages/shared/src/transfer-service.js
// SP3 MAIN-ONLY pipeline that assembles the orchestrator + jobs-store + queue
// into an app-facing service. Electron-free: `openChannel` is injected so this
// module is unit-testable via loopback (see transfer-orchestrator.test.js's
// loopback() pattern) with no real WebRTC/worker involved.
//
// Concurrency model: SENDS are serialized through one `createQueue()` — only
// the head job's channel is opened/run at a time (spec-driven UX: one active
// upload at a time, others wait). RECEIVES are NOT gated by that queue — a
// receive can run concurrently with an active send, since the remote peer
// initiates it and the user has already consented per-offer.
import { createHash } from 'node:crypto';
import { resolveParallelConnections } from './config.js';
import { createSender, createReceiver, createMultiFlowSender, createMultiFlowReceiver } from './transfer-orchestrator.js';
import { createQueue, selectResumable, newJobId } from './transfer-queue.js';
import { parseCtrlFrame } from './transfer-protocol.js';
import { walkSource, openSourceReader, createSparsePartFile, finalizeReceivedPath } from './transfer-io.js';
import { buildManifest } from './transfer-manifest.js';
import { createResumeWatcher } from './transfer-resume-watcher.js';

// A stable fingerprint of a manifest's file list, so a resumed contact job can
// be recognized by content, not just by the sender-chosen jobId (SECURITY —
// see acceptedContactJobs below). manifest.entries is already the RECEIVER's
// own buildManifest() output (sanitized paths, validated fields), so this is
// deterministic across an unchanged source re-walk.
function manifestFingerprint(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex');
}

// Wrap a channel so we can observe the jobId as soon as it appears on the wire
// (the OFFER frame) without altering behavior — the real onCtrl callback still
// receives every frame unchanged. Used on the receive side, where the jobId
// isn't known to the service until the remote sender announces it.
function tapJobId(channel, setJobId) {
  return {
    sendCtrl: (s) => channel.sendCtrl(s),
    sendBulk: (b) => channel.sendBulk(b),
    onCtrl(cb) {
      channel.onCtrl((s) => {
        const f = parseCtrlFrame(s);
        if (f && typeof f.jobId === 'string') setJobId(f.jobId);
        return cb(s);
      });
    },
    onBulk(cb) { channel.onBulk(cb); },
  };
}

function errMessage(err) {
  return (err && err.message) ? err.message : String(err);
}

// A send failure is TERMINAL/AUTHORITATIVE (won't fix itself on retry) or
// TRANSIENT/recoverable (a transport/availability problem that a re-dial or a
// later retry can fix). Recoverable own-fleet failures become a resumable
// `interrupted`; everything else is `error`.
//
// Exported so packages/controller/src/transfer-channel-assembly.js's slot-0
// handler can reuse this SAME predicate (common-mode-resilience Task 5) to
// decide which `error:*` rendezvous states are authoritative enough to fail
// the whole transfer fast via onRendezvousError. TRANSIENT reasons — notably
// `auth_timeout` (a connection-auth handshake timeout during a connection
// storm — see connection-auth.js) and `transfer_timeout` — must NOT match
// here: they are exactly the recoverable case the supervisor's slot-0 re-dial
// + ctrl-swap (Task 6) is built to handle, and did not appear anywhere in the
// pre-Task-5 regex (relying on that is fragile — asserted directly by
// transfer-service.test.js). `bad_password`/`host_offline`/`unknown_device`
// are signaling-level rendezvous rejections (see server.js / connection-
// auth.js) that retrying will never fix, so they're included alongside the
// pre-existing local-exception terms below.
export function isTerminalReason(reason) {
  return /rejected:|receiver_incomplete|canceled|aborted|bad_manifest|nospace|proto|declined|bad_password|host_offline|unknown_device/.test(String(reason || ''));
}

// Multi-flow selection (Plan 3 Task 3): flowCount > 1 drives the Plan-2
// createMultiFlowSender/createMultiFlowReceiver instead of the single-flow
// createSender/createReceiver. Any non-positive-integer input (missing, 0,
// negative, non-integer) is ignored and falls through to the next source, then
// to 1 (single-flow) -- never silently coerces a bad value into "multi-flow".
//
// Task 6 review fix: whatever falls out of preferred/fallback/1 above is then
// run through resolveParallelConnections (config.js) -- the SAME [1,32] clamp
// the "Parallel connections" setting itself uses -- so this is the LAST-line
// choke point. No caller-supplied value (target.flowCount, an out-of-range
// serviceFlowCount, or anything else routed here) can ever reach the
// multi-flow branch above 32 or below 1, regardless of what earlier call
// sites (e.g. main.js's override) did or didn't clamp. resolveParallelConnections
// is a no-op on an already-valid integer in [1,32] (including 1, so single-flow
// routing is unaffected), so this doesn't duplicate the literal 32 anywhere.
export function resolveFlowCount(preferred, fallback) {
  const p = Number.isInteger(preferred) && preferred > 0 ? preferred : undefined;
  const f = Number.isInteger(fallback) && fallback > 0 ? fallback : undefined;
  return resolveParallelConnections(p ?? f ?? 1);
}

// createMultiFlowSender's readerFor(fileId) is called SYNCHRONOUSLY (see
// initialPass/gapPass in transfer-orchestrator.js -- there is no `await
// readerFor(...)`), but transfer-io.js's openSourceReader is async. Return a
// plain {readAt,close} object immediately and open the real fd lazily on first
// readAt (memoized) -- the same lazy-open pattern Plan 2's own loopback test
// fixture uses for this exact seam.
function readerForSources(sources) {
  return (fileId) => {
    let rp = null;
    return {
      async readAt(offset, length) {
        rp = rp || await openSourceReader(sources.get(fileId));
        return rp.readAt(offset, length);
      },
      async close() { if (rp) await rp.close(); },
    };
  };
}

// Multi-flow RESUME (Plan 3 Task 3): the positional/sparse receive writer means
// the .part file's on-disk SIZE is no longer the resume offset the way it is for
// the single-flow writer (createPartFile) -- the receiver must persist each
// file's actual covered byte-ranges explicitly (createMultiFlowReceiver's
// persistRanges seam) and read them back on a fresh start (initialRangesFor).
// Returns {fileId: ivals} the same way createReceiveRouter indexes
// initialRanges (transfer-receive-router.js: `initialRanges[e.fileId]`); {} for
// no usable prior record (fresh job, wrong dir, or one that predates range
// persistence).
async function readPersistedRanges(store, jobId) {
  let rec = null;
  try { rec = await store.load(jobId); } catch { rec = null; }
  if (!rec || rec.dir !== 'recv' || !Array.isArray(rec.perFile)) return {};
  const out = {};
  for (const pf of rec.perFile) {
    if (pf && typeof pf.fileId !== 'undefined' && Array.isArray(pf.ivals)) out[pf.fileId] = pf.ivals;
  }
  return out;
}

function ivalsCoverFile(ivals, size) {
  return Array.isArray(ivals) && ivals.some((iv) => Array.isArray(iv) && iv[0] <= 0 && iv[1] >= size);
}

// Persist the multi-flow receive record with each file's current byte-ranges
// attached (perFile[i].ivals), alongside the same fields the single-flow receive
// record carries (dir/tier/peer/destRoot/manifest/jobState -- see createReceiver's
// own saveRecord in transfer-orchestrator.js). Called periodically
// (createMultiFlowReceiver's persistRanges seam, every reportIntervalMs) and once
// more with the terminal state when the receive settles. store.save() is itself
// serialized per jobId (jobs-store.js), so concurrent calls here are safe
// (last-writer-wins, matching the existing send-side saves' discipline).
// `failedFileIds` (a Set, optional): per-file failure isolation — a file the
// router terminally gave up on (bounded I/O retries exhausted, e.g. an
// AV-locked .part) is recorded status:'error' regardless of what its ivals
// say (reportFiles() reports it fully-covered so the sender's tracker
// converges, which would otherwise read as ivalsCoverFile()->'done' — wrong,
// the bytes are NOT verified-and-written for this file). This is the ONLY
// terminal per-file status this helper can produce; everything else is the
// existing done/pending-by-coverage logic, unchanged.
async function saveReceiveRecordWithRanges({ store, jobId, tier, peer, destRoot, manifest, jobState, files, failedFileIds }) {
  if (!store || !manifest) return;
  const byId = new Map((files || []).map((f) => [f.fileId, f.ivals]));
  const failed = failedFileIds || new Set();
  return store.save({
    jobId, dir: 'recv', tier: tier || 'adhoc', peer: peer || {}, destRoot,
    manifest,
    perFile: manifest.entries.map((e) => {
      const ivals = byId.get(e.fileId) || [];
      const status = failed.has(e.fileId) ? 'error' : (ivalsCoverFile(ivals, e.size) ? 'done' : 'pending');
      return { fileId: e.fileId, ivals, status };
    }),
    jobState, createdAt: 0,
  });
}

export function createTransferService({ store, transferDir, consent, openChannel, onEvent = () => {}, rendezvousTimeoutMs = 30000, receiveCloseGraceMs = 2000, consentClassifyTimeoutMs = 8000, delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  // Final-review #3: bound runMultiFlowReceive's `await jobIdKnown`. A phantom
  // group (a re-dial's TRANSFER_REQUEST arriving just after a receive tore down,
  // forming a fresh group whose sender is already gone) fires onGroupReady and
  // reaches runMultiFlowReceive with no OFFER ever coming — the unbounded await
  // then hangs the receive and leaks the attach worker's hidden BrowserWindow.
  // Timer injected so a fake clock can prove the bound without a real wait.
  jobIdTimeoutMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout,
  // SP3 Phase 4 auto-resume: when provided, an own-fleet interrupted send is
  // re-established via the resume watcher (getFleet resolves the peer's current
  // signalingId by deviceId). resumeOpts injects the watcher's timers for tests.
  getFleet, resumeOpts = {},
  // Plan 3 Task 3: default flowCount for a send when `target.flowCount` isn't
  // set (per-send override always wins -- see resolveFlowCount). 1 keeps the
  // existing single-flow path exactly as it was.
  flowCount: serviceFlowCount = 1 }) {
  const queue = createQueue();
  let resumeWatcher = null; // set below when getFleet is provided (own-fleet auto-resume)
  const pendingSends = new Map(); // jobId -> { manifest, sources, target, createdAt, resolve, reject }
  let sendRunning = false;
  // Handle to the ACTIVE send's openChannel-returned close(), so cancel(jobId)
  // can actually tear the channel down (SP3 coherence contract #3) instead of
  // only flipping the persisted record while the transfer keeps running.
  let activeClose = null;
  // Live receives, keyed by jobId, so cancel() can actually reach one. Sends are
  // serialized (one activeClose suffices); receives are explicitly NOT queue-gated,
  // so several can be in flight — this must be a map, not a single slot.
  const activeReceives = new Map(); // jobId -> { abort }
  // Resilient multi-flow rolling-join: an ACTIVE multi-flow receive exposes a
  // { addFlow, setCtrl } sink keyed by its rendezvous sessionId (== the group's
  // groupId), so a late/replacement flow the group rendezvous admits after the
  // group already fired can be routed into the live receiver (main's onFlowJoin
  // -> getReceiveFlowSink -> addFlow/setCtrl). Registered only once the receive
  // is ACTIVE ('accepted') — Task 5: addFlow is a no-op before the router exists,
  // so registering earlier would silently drop the join. Removed on teardown.
  const receiveFlowSinks = new Map(); // sessionId -> { addFlow, setCtrl }

  // Contact consents already granted, keyed by VERIFIED-peer-key + jobId, valued
  // by the fingerprint of the manifest the human actually approved. An
  // auto-resumed transfer re-offers the same jobId; re-prompting on every network
  // drop makes an overnight transfer hands-on. Keyed by the device-keypair-verified
  // public key because jobId is chosen by the SENDER — binding to jobId alone would
  // let another contact replay an accepted id. In-memory only: a restart re-prompts
  // once, which is fine (and safer than persisting a consent).
  //
  // SECURITY (memo alone is NOT enough to skip a prompt): jobId is entirely
  // sender-chosen, so (key, jobId) alone means "the same job" only because the
  // sender SAYS so. A verified contact who got ONE small transfer approved could
  // re-offer that same jobId later with a completely different (bigger) manifest
  // and — with only the (key, jobId) memo — have it silently accepted: an
  // unlimited, unprompted write channel for the process's lifetime after a single
  // approval. Skipping the prompt on a memo hit therefore additionally requires,
  // checked at the point of use below: (a) the OFFERED manifest fingerprint
  // matches the one recorded at accept time, and (b) the receiver's OWN
  // persisted record for this jobId says the job is genuinely unfinished
  // ('active'/'interrupted', not 'done'/'canceled'/absent) — receiver-side
  // truth, not the sender's assertion. Both self-expire the memo with no manual
  // cleanup: a completed or canceled job can never ride it again.
  const acceptedContactJobs = new Map(); // `${publicKey}::${jobId}` -> approved manifest fingerprint

  function emit(jobId, direction, ev) {
    onEvent({ ...ev, jobId, direction });
  }

  // Minimal, correct peer threading (SP3 coherence contract #4): a send knows
  // its target's id; only persist it when target is really the {id,password}
  // shape the apps use (not the opaque strings some tests pass), so we never
  // invent data we don't have.
  function peerFor(target) {
    if (!target || typeof target !== 'object' || typeof target.id !== 'string') return {};
    // Keep the stable account deviceId when present (own-fleet) — auto-resume matches
    // a presence entry by deviceId and re-resolves the CURRENT (ephemeral) signalingId.
    return typeof target.deviceId === 'string' ? { id: target.id, deviceId: target.deviceId } : { id: target.id };
  }

  // SP3 Phase 4: own-fleet (linked) sends are recorded tier:'fleet' — they
  // authenticated via the device keypair, not a session password, and are the
  // only tier eligible for presence-driven auto-resume (see transfer-resume.js).
  function tierFor(target) {
    if (target && target.contact) return 'contact';
    return (target && target.linked) ? 'fleet' : 'adhoc';
  }

  function saveSendRecord({ jobId, manifest, createdAt, jobState, peer, tier = 'adhoc', sourceRoots = [], flowCount }) {
    return store.save({
      jobId,
      dir: 'send',
      tier,
      peer: peer || {},
      // The original root paths, persisted so an interrupted own-fleet send can be
      // re-walked and resumed after an app restart (across-restart auto-resume).
      sourceRoots,
      destRoot: null,
      manifest,
      perFile: manifest.entries.map((e) => ({ fileId: e.fileId, status: jobState === 'done' ? 'done' : jobState === 'error' ? 'error' : 'pending' })),
      jobState,
      createdAt,
      // Persisted so an auto-resumed send re-establishes with the SAME flow
      // count instead of silently reverting to single-flow (see reestablish()
      // below, which reads this back into the resume target) -- undefined for
      // a legacy/absent value, so resolveFlowCount's own fallback-to-1 still
      // applies unchanged.
      flowCount,
    });
  }

  async function runSend(jobId) {
    const entry = pendingSends.get(jobId);
    const { manifest, sources, target, createdAt, sourceRoots } = entry;
    const peer = peerFor(target);
    const tier = tierFor(target);
    // Persist BEFORE any bytes move (field bug — see MEMORY/task notes): a send
    // used to live only in the in-memory pendingSends Map until it SETTLED, so a
    // killed process (crash, kill, or even a graceful quit whose async settle-save
    // never completed) left NO record at all — invisible in the Transfers list
    // and invisible to the resume watcher's listInterrupted (which reads
    // store.list()). Writing 'active' here, at the top of runSend (not
    // startSend — a queued-but-never-started job has moved no bytes and needs no
    // record), makes a durable record exist for the whole lifetime of a running
    // send. Best-effort: a store write failure here must not abort a transfer
    // that would otherwise work.
    try { await saveSendRecord({ jobId, manifest, createdAt, jobState: 'active', peer, tier, sourceRoots, flowCount: target && target.flowCount }); } catch { /* best effort */ }
    let close = null;
    let onRendezvousError = null;
    let result;
    // Guards so a send never sits "waiting for approval" forever: a rendezvous
    // failure (openChannel surfaces the signaling reason) aborts immediately with
    // that reason; otherwise a timer fires if the peer never ACCEPTS. Both are
    // disarmed the instant the transfer becomes active (the 'accepted' event).
    let accepted = false;
    let approvalTimer = null;
    const disarmApprovalTimer = () => { if (approvalTimer) { clearTimeout(approvalTimer); approvalTimer = null; } };
    try {
      // Plan 3 Task 3: flowCount>1 (per-target override, else the service
      // default) drives the multi-flow branch below via a multi-flow openChannel
      // call; flowCount<=1 is the existing call/path, byte-for-byte unchanged.
      const flowCount = resolveFlowCount(target && target.flowCount, serviceFlowCount);
      const openArgs = flowCount > 1 ? { role: 'initiate', target, flowCount } : { role: 'initiate', target };
      const opened = await openChannel(openArgs);
      ({ close, onRendezvousError } = opened);
      if (pendingSends.has(jobId)) {
        // Still wanted: cancel() may have already removed it while the
        // channel was opening (see cancel() below) — don't start sending.
        activeClose = close;
        const onSendEvent = (ev) => {
          // 'prompting' = the host is showing the consent prompt (alive, awaiting
          // a human). 'accepted' = the user said yes. Either one means the peer
          // responded, so stop the approval timeout — a person deciding must not
          // read as "host didn't respond".
          if (ev.type === 'accepted') { accepted = true; disarmApprovalTimer(); }
          else if (ev.type === 'prompting') { disarmApprovalTimer(); }
          emit(jobId, 'send', ev);
        };
        // Consume whichever shape openChannel actually returned (Plan 3 Task 4's
        // grouped N-worker assembly resolves {ctrl,flows,...}; single-flow/legacy
        // resolves the existing {channel,...}) rather than trusting our own
        // flowCount decision blindly -- defensive against a partially-wired main.
        const multi = !!(opened.ctrl && Array.isArray(opened.flows));
        const sender = multi
          ? createMultiFlowSender({
              ctrl: opened.ctrl, flows: opened.flows, jobId, manifest,
              // The real connected flow count (may differ from the requested one
              // if main opened fewer) is more honest on the wire OFFER than the
              // request we made.
              flowCount: opened.flows.length || flowCount,
              groupId: (target && typeof target.groupId === 'string') ? target.groupId : newJobId(),
              readerFor: readerForSources(sources),
              // Resilient multi-flow: the supervisor's starvation waiter, so the
              // pool waits for a resupplied/late flow instead of failing when the
              // live flow set momentarily empties (staggered dial / a flow death).
              awaitFlow: opened.awaitFlow,
              // Task 9: the supervisor's cumulative re-dial counter (via
              // assembleSendFlows), surfaced in the aggregate progress event's
              // `redials` field. undefined here (a caller/fixture with no
              // supervisor wired) falls back to createMultiFlowSender's own
              // `() => 0` default.
              redialCount: opened.redialCount,
              onEvent: onSendEvent,
            })
          : createSender({ channel: opened.channel, jobId, manifest, sources, onEvent: onSendEvent });
        // Resilient multi-flow: when the supervisor re-dials a dead slot 0, hand
        // the sender the fresh ctrl channel so the control plane (OFFER/
        // range_report/complete) survives a slot-0 death. Registered AFTER the
        // sender exists (the assembly buffers a swap that fired earlier).
        if (multi && typeof opened.onCtrlReplaced === 'function') {
          opened.onCtrlReplaced((newCtrl) => { try { sender.setCtrl(newCtrl); } catch { /* best-effort */ } });
        }
        // Signaling-level rendezvous errors (host_offline, bad_password,
        // transfer_timeout, …) surface here BEFORE any accept — fail fast with
        // the real reason instead of hanging until the timeout.
        if (typeof onRendezvousError === 'function') {
          onRendezvousError((reason) => {
            if (accepted) return;
            disarmApprovalTimer();
            emit(jobId, 'send', { type: 'error', reason: reason || 'rendezvous_failed' });
            sender.abort(reason || 'rendezvous_failed');
          });
        }
        if (rendezvousTimeoutMs > 0) {
          approvalTimer = setTimeout(() => {
            if (accepted) return;
            approvalTimer = null;
            emit(jobId, 'send', { type: 'error', reason: 'no_response' });
            sender.abort('no_response');
          }, rendezvousTimeoutMs);
          if (approvalTimer.unref) approvalTimer.unref();
        }
        // Single-flow createSender's start() resolves with NO value on success
        // (r === undefined -> r?.ok !== false -> true, unchanged). Multi-flow
        // createMultiFlowSender's start() can resolve { jobId, ok:false } on a
        // completed-with-failures receive (see its 'complete' ctrl handler
        // above) — honor that instead of hardcoding ok:true, so the persisted
        // record's top-level ok matches the 'completed' event's ok. jobState
        // stays 'done' either way — the send genuinely finished (not
        // resumable); per-file failures are what the receiver's own perFile
        // record captures.
        const r = await sender.start();
        result = { jobId, ok: r?.ok !== false };
        await saveSendRecord({ jobId, manifest, createdAt, jobState: 'done', peer, tier, sourceRoots, flowCount: target && target.flowCount });
      } else {
        result = { jobId, ok: false, canceled: true };
      }
    } catch (err) {
      const reason = errMessage(err);
      result = { jobId, ok: false, error: reason };
      // Own-fleet + a recoverable (transport) failure → resumable `interrupted`,
      // and poke the resume watcher to try again as soon as the peer is online.
      const recoverable = (tier === 'fleet' || tier === 'contact') && !isTerminalReason(reason);
      // A receiver-initiated cancel surfaces here as reason === 'canceled' (the
      // orchestrator's sole message for an inbound cancel frame — see
      // transfer-orchestrator.js). Persist the accurate 'canceled' state rather
      // than a generic 'error'; it's still excluded from RESUMABLE_STATES
      // (transfer-queue.js) and still terminal per isTerminalReason's `canceled`
      // match above, so `recoverable` is unaffected and this can never be
      // auto-resumed by the resume watcher.
      const jobState = recoverable ? 'interrupted' : (reason === 'canceled' ? 'canceled' : 'error');
      try { await saveSendRecord({ jobId, manifest, createdAt, jobState, peer, tier, sourceRoots, flowCount: target && target.flowCount }); } catch { /* best effort */ }
      if (recoverable) { emit(jobId, 'send', { type: 'interrupted' }); if (resumeWatcher) resumeWatcher.notify(); }
    } finally {
      disarmApprovalTimer();
      if (activeClose === close) activeClose = null; // don't clobber a NEWER job's handle
      if (close) { try { await close(); } catch { /* ignore close errors */ } }
    }

    if (!pendingSends.has(jobId)) return result; // already finalized by cancel()
    pendingSends.delete(jobId);
    queue.complete(jobId);
    sendRunning = false;
    entry.resolve(result);
    advanceSendQueue();
    return result;
  }

  function advanceSendQueue() {
    if (sendRunning) return;
    const active = queue.active();
    if (active && pendingSends.has(active)) {
      sendRunning = true;
      runSend(active).catch(() => {}); // runSend never rejects (settles `entry` itself)
    }
  }

  // cancel(jobId): the ACTIVE job's channel is torn down via its close() (in
  // addition to marking the store record 'canceled' right here — deterministic,
  // not dependent on the underlying sender promise ever settling). A waiting
  // (not-yet-active) job is simply dropped from the queue. A jobId not tracked
  // in memory at all (already finished, or persisted by a previous app run) just
  // gets its store record flipped.
  async function cancel(jobId) {
    // A live receive: abort it for real (the store-only fallback below would flip
    // the record while the receive kept running and later saved right back over it).
    if (activeReceives.has(jobId)) {
      const entry = activeReceives.get(jobId);
      activeReceives.delete(jobId);
      try { entry.abort('canceled'); } catch { /* best effort */ }
      // startReceive's finally tears the channel down once the receiver rejects.
      const job = await store.load(jobId);
      if (job) { try { await store.save({ ...job, jobState: 'canceled' }); } catch { /* best effort */ } }
      return { ok: true };
    }

    if (!pendingSends.has(jobId)) {
      const job = await store.load(jobId);
      if (!job) return { ok: false };
      if (job.jobState === 'done' || job.jobState === 'canceled') return { ok: true };
      await store.save({ ...job, jobState: 'canceled' });
      // Emit so the UI (status bar / rail / list) drops the segment — a store
      // flip alone leaves the renderer's live state stale (it only refreshes on
      // a transfer:event). A restart-resumed record carries its own direction.
      emit(jobId, job.dir === 'recv' ? 'recv' : 'send', { type: 'canceled' });
      return { ok: true };
    }

    const entry = pendingSends.get(jobId);
    const isActive = queue.active() === jobId;

    pendingSends.delete(jobId);
    queue.remove(jobId);
    if (isActive) {
      sendRunning = false;
      if (activeClose) { const c = activeClose; activeClose = null; try { await c(); } catch { /* ignore */ } }
    }

    try {
      await saveSendRecord({ jobId, manifest: entry.manifest, createdAt: entry.createdAt, jobState: 'canceled', peer: peerFor(entry.target), tier: tierFor(entry.target), sourceRoots: entry.sourceRoots, flowCount: entry.target && entry.target.flowCount });
    } catch { /* best effort */ }
    // Emit a terminal 'canceled' so the renderer's status bar / rail / list
    // refresh and drop this transfer. Without it, an early ad-hoc cancel (before
    // the receiver ever accepted) left the "↑ <name>" status-bar indicator stuck,
    // because that indicator only repaints on a transfer:event.
    emit(jobId, 'send', { type: 'canceled' });
    entry.resolve({ jobId, ok: false, canceled: true });
    if (isActive) advanceSendQueue();
    return { ok: true };
  }

  // A dir:'send' record still saying 'active' at process START is
  // impossible-by-definition — the process that owned it is gone (this app
  // just launched). Rewrite each one to a terminal-but-honest state, mirroring
  // the RECEIVE side's own inactivity watchdog exactly (transfer-orchestrator.js:
  // `resumable = tier === 'fleet' || tier === 'contact'`): a resumable tier
  // becomes 'interrupted' so the resume watcher re-establishes it; anything
  // else (adhoc) becomes 'error', because nothing will ever resume it and
  // showing "Interrupted — will resume" would be a lie. dir:'recv' records are
  // deliberately NOT touched here — the receive side has its own watchdog and
  // its own tier semantics; sweeping them here would be a second, uncoordinated
  // writer over the same records.
  async function recoverStaleSends() {
    let jobs = [];
    try { jobs = await store.list(); } catch { jobs = []; }
    for (const job of jobs) {
      if (!job || job.dir !== 'send' || job.jobState !== 'active') continue;
      const resumable = job.tier === 'fleet' || job.tier === 'contact';
      try { await store.save({ ...job, jobState: resumable ? 'interrupted' : 'error' }); } catch { /* best effort */ }
    }
  }

  // Own-fleet vs contact vs ad-hoc peer classification for an inbound receive's
  // consent prompt -- shared by the single-flow AND multi-flow receive paths
  // (Plan 3 Task 3: extracted so the multi-flow branch doesn't duplicate this
  // SECURITY-sensitive contact-memo logic verbatim; behavior is byte-for-byte
  // what startReceive already did inline). See the acceptedContactJobs SECURITY
  // comment above for why a memo hit alone must never skip the prompt.
  function makeReceiveConsent(peerAuth) {
    let resolvedTier = null; // set by the classify below; read lazily by the receiver
    const consentFn = async ({ jobId, manifest }) => {
      let tier = null;
      let publicKey = null;
      try {
        if (peerAuth) {
          let timerId = null;
          const timed = new Promise((res) => { timerId = setTimeout(() => res({ tier: null }), consentClassifyTimeoutMs); });
          try {
            const a = await Promise.race([peerAuth, timed]);
            tier = a.tier;
            publicKey = a.publicKey || null;
          } finally {
            clearTimeout(timerId);
          }
        }
      } catch { tier = null; publicKey = null; }
      resolvedTier = tier;
      if (tier === 'fleet') return true;   // own-fleet auto-accepts; contact/adhoc/timeout → prompt
      // Only a VERIFIED contact's consent is remembered. Ad-hoc/unverified (tier
      // null, no key) always prompts — there's no authenticated identity to bind
      // to, so a replayed jobId must not skip the prompt. Fail-closed intact.
      const memo = tier === 'contact' && publicKey ? `${publicKey}::${jobId}` : null;
      // A memo hit alone must NOT skip the prompt (see the SECURITY comment on
      // acceptedContactJobs above) — additionally require the offered manifest
      // to be byte-identical to the one approved, AND the receiver's OWN store
      // record to say this job is still genuinely unfinished. Any mismatch or
      // missing/terminal record falls through to a real prompt — fail closed.
      const fingerprint = manifestFingerprint(manifest);
      if (memo && acceptedContactJobs.get(memo) === fingerprint) {
        let rec = null;
        try { rec = await store.load(jobId); } catch { rec = null; }
        if (rec && rec.dir === 'recv' && (rec.jobState === 'active' || rec.jobState === 'interrupted')) {
          return true; // a resume of a job this peer already got approved: same manifest, still unfinished
        }
      }
      const ok = await consent({ jobId, manifest });
      if (ok && memo) acceptedContactJobs.set(memo, fingerprint);
      return ok;
    };
    return { consentFn, getTier: () => resolvedTier || 'adhoc' };
  }

  // Plan 3 Task 3: multi-flow receive. openChannel resolved {ctrl, flows, close,
  // peerAuth} (Plan 3 Task 4's grouped N-worker assembly) instead of the
  // single-flow {channel, ...} shape. Unlike single-flow createReceiver,
  // createMultiFlowReceiver takes jobId as a CONSTRUCTOR param and filters EVERY
  // ctrl frame -- including the OFFER itself -- by exact jobId match (see
  // transfer-orchestrator.js), but jobId is sender-chosen and only appears ON
  // the OFFER frame; nothing in the rendezvous (TRANSFER_REQUEST only carries
  // sessionId/groupId/flowIndex/flowCount/linked -- see transfer-group-
  // rendezvous.js) tells us jobId ahead of time. So: tap the raw ctrl first to
  // learn jobId from its first frame (buffering everything until then), THEN
  // construct the real receiver with that jobId, then flush the buffer into it.
  // While we're already tapping every frame, opportunistically reassemble the
  // manifest too (from offer/offer_begin/offer_entries/offer_end) purely for our
  // OWN bookkeeping -- this reassembly runs BEFORE the real receiver even
  // exists (jobId isn't known yet), so it can't wait for createMultiFlowReceiver's
  // own 'accepted' event (which does now carry the manifest, mirroring
  // single-flow's) -- the jobs-store record needs the manifest sooner than that.
  async function runMultiFlowReceive({ ctrl, flows, close, peerAuth, sessionId }) {
    // Important #2: a rolling-joined flow's worker is a hidden BrowserWindow that
    // is NOT one of the `close`-swept assembleReceiveGroup handles, so its close
    // must be retained here and swept on teardown or it leaks a window (holds the
    // app alive / single-instance lock — CLAUDE.md). Each retained close is the
    // idempotent worker.close(), so a double-sweep is harmless.
    const joinedHandleCloses = [];
    let currentJobId = null;
    let currentManifest = null;
    let offerAccum = null;
    let forwardToReceiver = null;
    const buffered = [];
    let resolveJobId;
    const jobIdKnown = new Promise((res) => { resolveJobId = res; });

    // Registered synchronously, before any await, so no frame can arrive
    // unobserved between openChannel resolving and this handler being live.
    ctrl.onCtrl((str) => {
      const f = parseCtrlFrame(str);
      if (f) {
        if (currentJobId === null && typeof f.jobId === 'string') { currentJobId = f.jobId; resolveJobId(f.jobId); }
        if (f.t === 'offer') {
          try { currentManifest = buildManifest(f.entries); } catch { /* malformed; the real receiver's own validation rejects it */ }
        } else if (f.t === 'offer_begin') {
          offerAccum = { entries: [] };
        } else if (f.t === 'offer_entries') {
          if (offerAccum) for (const e of f.entries) offerAccum.entries.push(e);
        } else if (f.t === 'offer_end') {
          if (offerAccum) { try { currentManifest = buildManifest(offerAccum.entries); } catch { /* ditto */ } offerAccum = null; }
        }
      }
      if (forwardToReceiver) forwardToReceiver(str);
      else buffered.push(str);
    });

    const wrappedCtrl = {
      sendCtrl: (s) => ctrl.sendCtrl(s),
      onCtrl(cb) {
        forwardToReceiver = cb;
        const pending = buffered.splice(0);
        for (const s of pending) cb(s);
      },
    };

    // Final-review #3: bound the wait for the sender's OFFER (which carries the
    // jobId). A phantom late group has no sender on the other end, so jobIdKnown
    // would never resolve and this receive would hang forever — leaking the
    // attach worker's hidden BrowserWindow (holds the app alive / single-instance
    // lock). On timeout, close the attach worker(s) + any rolling-joined handles
    // and reject cleanly. (Nothing else has been registered yet — activeReceives/
    // receiveFlowSinks are populated only AFTER the receiver is constructed below,
    // and joinedHandleCloses is empty until a post-accept rolling-join — so this
    // cleanup is complete.)
    let jobId;
    let jobIdTimer = null;
    const jobIdTimeout = new Promise((_res, reject) => {
      jobIdTimer = setTimer(() => reject(new Error('no_offer')), jobIdTimeoutMs);
      if (jobIdTimer && jobIdTimer.unref) jobIdTimer.unref();
    });
    try {
      jobId = await Promise.race([jobIdKnown, jobIdTimeout]);
    } catch (err) {
      try { await close(); } catch { /* ignore close errors */ }
      await Promise.all(joinedHandleCloses.splice(0).map((c) => {
        try { return Promise.resolve(c()).catch(() => {}); } catch { return undefined; }
      }));
      throw err;
    } finally {
      if (jobIdTimer) clearTimer(jobIdTimer);
    }
    // Sparse/positional resume state (see readPersistedRanges) -- fetched ONCE,
    // synchronously handed to the receiver: createReceiveRouter reads
    // initialRanges as a plain object (`initialRanges[e.fileId]`), not a
    // promise, so this must resolve before the receiver is constructed.
    const persistedRanges = await readPersistedRanges(store, jobId);
    const { consentFn: receiveConsent, getTier } = makeReceiveConsent(peerAuth);
    const destRoot = (typeof transferDir === 'function' ? transferDir() : transferDir);
    // Per-file failure isolation: track which fileIds the router terminally
    // gave up on (I/O retries exhausted — reported via onEvent, not by
    // reaching into the router directly) so the jobs-store perFile status can
    // record 'error' for exactly those files, distinct from a verify-mismatch
    // 'file-failed' (no `reason`), which stays retryable and must NOT be
    // recorded as a terminal error here.
    const failedFileIds = new Set();
    // createMultiFlowReceiver resolves {jobId, ok} from exactly two call
    // sites: beginReceive's decline path (ok:false, before any transfer
    // activity — 'accepted' never fires) and maybeComplete (a genuine
    // completion, possibly WITH per-file failures — ok can be true or false).
    // 'accepted' only fires on the latter path, so it's a reliable signal
    // (without changing the resolved value's shape, which would break exact-
    // match assertions elsewhere) that a resolve is "done reconciling", not
    // "declined" — used below to keep a completed-with-failures receive
    // recorded 'done' rather than 'error' (SP3 per-file-isolation).
    let accepted = false;

    const receiver = createMultiFlowReceiver({
      ctrl: wrappedCtrl, flows, jobId, consent: receiveConsent,
      openPart: (relPath) => createSparsePartFile({ destRoot, relPath }),
      verifyAndFinalize: ({ path, expectedHash, mtime }) => finalizeReceivedPath({ destRoot, relPath: path, expectedHash, mtime }),
      initialRangesFor: () => persistedRanges,
      persistRanges: (files) => {
        if (!currentManifest) return; // no OFFER reassembled yet; nothing to persist against
        // Returning the write's promise (not fire-and-forget) lets
        // createMultiFlowReceiver's `lastPersist` track it, so a settle
        // (cancel/stall/error) landing while this write is still in flight
        // waits for it before resolving/rejecting — otherwise a caller that
        // deletes destRoot/the store dir right after cancel can race an
        // open tmp-file fd on Windows (ENOTEMPTY/EBUSY), the same class of
        // bug as the .part fd leak this all guards against.
        return saveReceiveRecordWithRanges({
          store, jobId, tier: getTier(), peer: {}, destRoot,
          manifest: currentManifest, jobState: 'active', files, failedFileIds,
        }).catch(() => { /* best effort, matches single-flow saveRecord's discipline */ });
      },
      onEvent: (ev) => {
        if (ev.type === 'accepted') {
          accepted = true;
          // Now ACTIVE (router exists): expose the rolling-join sink so the
          // group rendezvous' onFlowJoin can add a late/replacement flow.
          if (sessionId) receiveFlowSinks.set(sessionId, {
            addFlow: (ch, idx) => receiver.addFlow(ch, idx),
            setCtrl: (ch) => receiver.setCtrl(ch),
            // main registers a rolling-joined handle's close here so this
            // receive's teardown sweep closes its hidden worker window too.
            retain: (closeFn) => { if (typeof closeFn === 'function') joinedHandleCloses.push(closeFn); },
          });
        }
        if (ev.type === 'file-failed' && ev.reason === 'io_error') failedFileIds.add(ev.fileId);
        emit(jobId, 'recv', ev);
      },
    });

    activeReceives.set(jobId, { abort: (r) => receiver.abort(r) });
    try {
      const result = await receiver.start();
      // createMultiFlowReceiver's own persistRanges cadence stops once it
      // settles (stopReporter()) -- persist the TERMINAL state once more here so
      // a completed/failed job's record reflects final coverage, not whatever
      // the last periodic tick happened to catch.
      if (currentManifest) {
        // `accepted` means this resolve came from maybeComplete (a genuine
        // completion, possibly WITH per-file failures — result.ok is false in
        // that case) rather than beginReceive's decline path. A completed-
        // with-failures receive is still DONE, not an error: the receiver has
        // already finished reconciling, so it isn't resumable/retryable. A
        // non-accepted resolve (declined before any transfer activity) keeps
        // the old ok-derived jobState.
        const jobState = accepted ? 'done' : (result.ok ? 'done' : 'error');
        const files = currentManifest.entries.map((e) => ({
          fileId: e.fileId,
          ivals: failedFileIds.has(e.fileId) ? [] : ((accepted || result.ok) ? [[0, e.size]] : []),
        }));
        try {
          await saveReceiveRecordWithRanges({
            store, jobId, tier: getTier(), peer: {}, destRoot,
            manifest: currentManifest, jobState, files, failedFileIds,
          });
        } catch { /* best effort */ }
      }
      return result;
    } finally {
      activeReceives.delete(jobId);
      // Deregister the sink BEFORE the grace/close so no further rolling-join can
      // race in against a receiver that's tearing down.
      if (sessionId) receiveFlowSinks.delete(sessionId);
      // Same completion-ack grace as the single-flow path (see startReceive).
      if (receiveCloseGraceMs > 0) { try { await delay(receiveCloseGraceMs); } catch { /* ignore */ } }
      try { await close(); } catch { /* ignore close errors */ }
      // Important #2: close every rolling-joined handle's worker window too. The
      // close is idempotent, so this can't double-crash even if one already went.
      await Promise.all(joinedHandleCloses.splice(0).map((c) => {
        try { return Promise.resolve(c()).catch(() => {}); } catch { return undefined; }
      }));
    }
  }

  const api = {
    recoverStaleSends,

    startSend({ jobId, manifest, sources, target, sourceRoots = [] }) {
      return new Promise((resolve, reject) => {
        pendingSends.set(jobId, { manifest, sources, target, sourceRoots, createdAt: Date.now(), resolve, reject });
        queue.add(jobId);
        advanceSendQueue();
      });
    },

    cancel,

    async startReceive({ rendezvous }) {
      // Canonical openChannel shape (SP3 coherence contract #1): always
      // { role, target, sessionId }. A receive's sessionId may arrive here
      // either as a plain string or as { sessionId } (host main.js's
      // transfer:incoming passes the latter) — normalize to a plain string.
      const sessionId = typeof rendezvous === 'string' ? rendezvous : rendezvous?.sessionId;
      // SP3 Phase 4: an own-fleet (linked) transfer request tells the attacher to
      // run the host-role device-keypair handshake and fail closed if it doesn't
      // pass — the signaling server relays `linked` in TRANSFER_REQUEST.
      const linked = (rendezvous && typeof rendezvous === 'object') ? !!rendezvous.linked : false;
      const opened = await openChannel({ role: 'attach', sessionId, linked });
      // Plan 3 Task 3: openChannel resolves either the existing single-flow
      // {channel, close, peerAuth} shape, or the multi-flow {ctrl, flows, close,
      // peerAuth} shape (Plan 3 Task 4's grouped N-worker assembly, driven by the
      // group-rendezvous coordinator -- NOT by anything this service decides).
      // Consume whichever shape actually came back.
      if (opened && opened.ctrl && Array.isArray(opened.flows)) {
        return runMultiFlowReceive({ ...opened, sessionId });
      }
      const { channel, close, peerAuth } = opened;
      let currentJobId = null;
      let receiverRef = null;
      const tapped = tapJobId(channel, (id) => {
        // Every ctrl frame carrying a jobId re-invokes this callback (file_begin,
        // file_end, job_done, …), not just the OFFER — only register once per
        // jobId, otherwise every inbound frame after the OFFER needlessly mints
        // and re-sets a fresh { abort } closure into activeReceives (review
        // finding 3; functionally harmless since the closure just reads
        // receiverRef, but there's no reason to churn it on every frame).
        if (currentJobId === id) return;
        currentJobId = id;
        activeReceives.set(id, { abort: (r) => { if (receiverRef) receiverRef.abort(r); } });
      });
      // SP3 Phase 5 Task 6: an own-fleet transfer is auto-accepted — logging into
      // your account on this machine is the standing consent, exactly as for
      // own-fleet unattended control (2026-07-15 decision). A contact — and any
      // ad-hoc/unverified peer — always PROMPTs. Classification comes from the
      // device-keypair handshake's verified peer key (openChannel's `peerAuth`,
      // resolved by main via classifyPublicKey), NOT the blanket `linked` flag —
      // `linked` only says the rendezvous ran the handshake, not who it verified.
      // `peerAuth` only resolves after an UNBOUNDED network call (classifyPublicKey
      // against auth.sovexa.org) — race it against a timeout so a stalled/offline
      // auth server can't hang the receive forever. Fail-closed means falling
      // through to the human `consent` prompt, never auto-accepting.
      const { consentFn: receiveConsent, getTier } = makeReceiveConsent(peerAuth);
      const receiver = createReceiver({
        channel: tapped, destRoot: (typeof transferDir === 'function' ? transferDir() : transferDir), store, consent: receiveConsent,
        getTier,
        onEvent: (ev) => emit(currentJobId, 'recv', ev),
      });
      receiverRef = receiver;
      try {
        return await receiver.start();
      } finally {
        if (currentJobId) activeReceives.delete(currentJobId);
        // Grace before tearing down the worker so the receiver's `complete` ack
        // has time to flush to the sender over the wire — otherwise destroying the
        // window discards it and the sender waits out its whole completion timeout.
        if (receiveCloseGraceMs > 0) { try { await delay(receiveCloseGraceMs); } catch { /* ignore */ } }
        try { await close(); } catch { /* ignore close errors */ }
      }
    },

    // Resilient multi-flow rolling-join: the { addFlow, setCtrl } face of an
    // ACTIVE multi-flow receive, keyed by its rendezvous sessionId (== groupId).
    // main's onFlowJoin uses it to route a late/replacement flow into the live
    // receiver; null when no receive is active for that session yet (the caller
    // then closes the orphan handle — the sender re-dials).
    getReceiveFlowSink(sessionId) {
      return receiveFlowSinks.get(sessionId) || null;
    },

    async listJobs() {
      return store.list();
    },

    // Forget a job — delete its persisted record so it leaves the Transfers list.
    // Refuses while the job is still live in THIS process (a send in flight or an
    // active receive): those must be cancel()'d first, so the UI only offers this
    // on terminal jobs. Idempotent — removing an unknown/already-gone job is ok.
    async removeJob(jobId) {
      if (typeof jobId !== 'string' || !jobId) return { ok: false, error: 'invalid_request' };
      if (pendingSends.has(jobId) || activeReceives.has(jobId)) return { ok: false, error: 'active' };
      try { await store.remove(jobId); } catch { /* best effort — treat as gone */ }
      return { ok: true };
    },

    async resumable() {
      return selectResumable(await store.list());
    },

    startResumeWatcher() { if (resumeWatcher) resumeWatcher.start(); },
    stopResumeWatcher() { if (resumeWatcher) resumeWatcher.stop(); },
    // Trigger one immediate resume sweep (used by tests; also handy to force a
    // retry). No-op if auto-resume isn't configured.
    resumeSweepNow() { return resumeWatcher ? resumeWatcher.sweep() : Promise.resolve(); },
  };

  // Own-fleet auto-resume: re-walk an interrupted job's source roots and re-run the
  // linked send to the peer's CURRENT signalingId. The receiver skip-existings every
  // file already on disk (rsync-like), so only the remainder transfers.
  if (typeof getFleet === 'function') {
    const listInterrupted = async () =>
      (await store.list()).filter((j) => j.jobState === 'interrupted' && (j.tier === 'fleet' || j.tier === 'contact') && j.dir === 'send');
    const reestablish = async (job, signalingId) => {
      let walked = null;
      try { walked = await walkSource((job.sourceRoots || []).map((p) => ({ path: p }))); } catch { walked = null; }
      if (!walked || !walked.entries.length) {
        try { await store.save({ ...job, jobState: 'error' }); } catch { /* best effort */ }
        return;
      }
      emit(job.jobId, 'send', { type: 'reconnecting' });
      await api.startSend({
        jobId: job.jobId,
        manifest: buildManifest(walked.entries),
        sources: walked.sources,
        sourceRoots: job.sourceRoots,
        // Carry the original flowCount forward so an auto-resumed send re-opens
        // with the SAME parallelism instead of silently reverting to
        // single-flow (resolveFlowCount defaults a missing target.flowCount to
        // 1) -- undefined on a legacy record resumes single-flow exactly as
        // before.
        target: { id: signalingId, deviceId: job.peer && job.peer.deviceId, linked: true, contact: job.tier === 'contact', flowCount: job.flowCount },
      });
    };
    resumeWatcher = createResumeWatcher({ listInterrupted, getFleet, reestablish, ...resumeOpts });
  }

  return api;
}
