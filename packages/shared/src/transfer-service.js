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
import { createSender, createReceiver } from './transfer-orchestrator.js';
import { createQueue, selectResumable } from './transfer-queue.js';
import { parseCtrlFrame } from './transfer-protocol.js';
import { walkSource } from './transfer-io.js';
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

// A send failure is TERMINAL (won't fix itself on retry) or recoverable (a
// transport/availability problem). Recoverable own-fleet failures become a
// resumable `interrupted`; everything else is `error`.
function isTerminalReason(reason) {
  return /rejected:|receiver_incomplete|canceled|aborted|bad_manifest|nospace|proto|declined/.test(String(reason || ''));
}

export function createTransferService({ store, transferDir, consent, openChannel, onEvent = () => {}, rendezvousTimeoutMs = 30000, receiveCloseGraceMs = 2000, consentClassifyTimeoutMs = 8000, delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  // SP3 Phase 4 auto-resume: when provided, an own-fleet interrupted send is
  // re-established via the resume watcher (getFleet resolves the peer's current
  // signalingId by deviceId). resumeOpts injects the watcher's timers for tests.
  getFleet, resumeOpts = {} }) {
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

  function saveSendRecord({ jobId, manifest, createdAt, jobState, peer, tier = 'adhoc', sourceRoots = [] }) {
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
    try { await saveSendRecord({ jobId, manifest, createdAt, jobState: 'active', peer, tier, sourceRoots }); } catch { /* best effort */ }
    let channel = null;
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
      ({ channel, close, onRendezvousError } = await openChannel({ role: 'initiate', target }));
      if (pendingSends.has(jobId)) {
        // Still wanted: cancel() may have already removed it while the
        // channel was opening (see cancel() below) — don't start sending.
        activeClose = close;
        const sender = createSender({
          channel, jobId, manifest, sources,
          onEvent: (ev) => {
            // 'prompting' = the host is showing the consent prompt (alive, awaiting
            // a human). 'accepted' = the user said yes. Either one means the peer
            // responded, so stop the approval timeout — a person deciding must not
            // read as "host didn't respond".
            if (ev.type === 'accepted') { accepted = true; disarmApprovalTimer(); }
            else if (ev.type === 'prompting') { disarmApprovalTimer(); }
            emit(jobId, 'send', ev);
          },
        });
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
        await sender.start(); // resolves with no value on success, rejects/throws on failure
        result = { jobId, ok: true };
        await saveSendRecord({ jobId, manifest, createdAt, jobState: 'done', peer, tier, sourceRoots });
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
      try { await saveSendRecord({ jobId, manifest, createdAt, jobState, peer, tier, sourceRoots }); } catch { /* best effort */ }
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
      await saveSendRecord({ jobId, manifest: entry.manifest, createdAt: entry.createdAt, jobState: 'canceled', peer: peerFor(entry.target), tier: tierFor(entry.target), sourceRoots: entry.sourceRoots });
    } catch { /* best effort */ }
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
      const { channel, close, peerAuth } = await openChannel({ role: 'attach', sessionId, linked });
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
      let resolvedTier = null; // set by the consent classify below; read lazily by the receiver
      const receiveConsent = async ({ jobId, manifest }) => {
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
      const receiver = createReceiver({
        channel: tapped, destRoot: transferDir, store, consent: receiveConsent,
        getTier: () => resolvedTier || 'adhoc',
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
        target: { id: signalingId, deviceId: job.peer && job.peer.deviceId, linked: true, contact: job.tier === 'contact' },
      });
    };
    resumeWatcher = createResumeWatcher({ listInterrupted, getFleet, reestablish, ...resumeOpts });
  }

  return api;
}
