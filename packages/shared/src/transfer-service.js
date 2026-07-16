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
import { createSender, createReceiver } from './transfer-orchestrator.js';
import { createQueue, selectResumable } from './transfer-queue.js';
import { parseCtrlFrame } from './transfer-protocol.js';

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

export function createTransferService({ store, transferDir, consent, openChannel, onEvent = () => {}, rendezvousTimeoutMs = 30000 }) {
  const queue = createQueue();
  const pendingSends = new Map(); // jobId -> { manifest, sources, target, createdAt, resolve, reject }
  let sendRunning = false;
  // Handle to the ACTIVE send's openChannel-returned close(), so cancel(jobId)
  // can actually tear the channel down (SP3 coherence contract #3) instead of
  // only flipping the persisted record while the transfer keeps running.
  let activeClose = null;

  function emit(jobId, direction, ev) {
    onEvent({ ...ev, jobId, direction });
  }

  // Minimal, correct peer threading (SP3 coherence contract #4): a send knows
  // its target's id; only persist it when target is really the {id,password}
  // shape the apps use (not the opaque strings some tests pass), so we never
  // invent data we don't have.
  function peerFor(target) {
    return (target && typeof target === 'object' && typeof target.id === 'string') ? { id: target.id } : {};
  }

  function saveSendRecord({ jobId, manifest, createdAt, jobState, peer }) {
    return store.save({
      jobId,
      dir: 'send',
      tier: 'adhoc',
      peer: peer || {},
      destRoot: null,
      manifest,
      perFile: manifest.entries.map((e) => ({ fileId: e.fileId, status: jobState === 'done' ? 'done' : jobState === 'error' ? 'error' : 'pending' })),
      jobState,
      createdAt,
    });
  }

  async function runSend(jobId) {
    const entry = pendingSends.get(jobId);
    const { manifest, sources, target, createdAt } = entry;
    const peer = peerFor(target);
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
            if (ev.type === 'accepted') { accepted = true; disarmApprovalTimer(); }
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
        await saveSendRecord({ jobId, manifest, createdAt, jobState: 'done', peer });
      } else {
        result = { jobId, ok: false, canceled: true };
      }
    } catch (err) {
      result = { jobId, ok: false, error: errMessage(err) };
      try { await saveSendRecord({ jobId, manifest, createdAt, jobState: 'error', peer }); } catch { /* best effort */ }
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
      await saveSendRecord({ jobId, manifest: entry.manifest, createdAt: entry.createdAt, jobState: 'canceled', peer: peerFor(entry.target) });
    } catch { /* best effort */ }
    entry.resolve({ jobId, ok: false, canceled: true });
    if (isActive) advanceSendQueue();
    return { ok: true };
  }

  return {
    startSend({ jobId, manifest, sources, target }) {
      return new Promise((resolve, reject) => {
        pendingSends.set(jobId, { manifest, sources, target, createdAt: Date.now(), resolve, reject });
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
      const { channel, close } = await openChannel({ role: 'attach', sessionId });
      let currentJobId = null;
      const tapped = tapJobId(channel, (id) => { currentJobId = id; });
      const receiver = createReceiver({
        channel: tapped, destRoot: transferDir, store, consent,
        onEvent: (ev) => emit(currentJobId, 'recv', ev),
      });
      try {
        return await receiver.start();
      } finally {
        try { await close(); } catch { /* ignore close errors */ }
      }
    },

    async listJobs() {
      return store.list();
    },

    async resumable() {
      return selectResumable(await store.list());
    },
  };
}
