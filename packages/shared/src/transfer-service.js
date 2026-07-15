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

export function createTransferService({ store, transferDir, consent, openChannel, onEvent = () => {} }) {
  const queue = createQueue();
  const pendingSends = new Map(); // jobId -> { manifest, sources, target, createdAt, resolve, reject }
  let sendRunning = false;

  function emit(jobId, direction, ev) {
    onEvent({ ...ev, jobId, direction });
  }

  function saveSendRecord({ jobId, manifest, createdAt, jobState }) {
    return store.save({
      jobId,
      dir: 'send',
      tier: 'adhoc',
      peer: {},
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
    let channel = null;
    let close = null;
    let result;
    try {
      ({ channel, close } = await openChannel({ role: 'initiate', target }));
      const sender = createSender({
        channel, jobId, manifest, sources,
        onEvent: (ev) => emit(jobId, 'send', ev),
      });
      await sender.start(); // resolves with no value on success, rejects/throws on failure
      result = { jobId, ok: true };
      await saveSendRecord({ jobId, manifest, createdAt, jobState: 'done' });
    } catch (err) {
      result = { jobId, ok: false, error: errMessage(err) };
      try { await saveSendRecord({ jobId, manifest, createdAt, jobState: 'error' }); } catch { /* best effort */ }
    } finally {
      if (close) { try { await close(); } catch { /* ignore close errors */ } }
    }

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

  return {
    startSend({ jobId, manifest, sources, target }) {
      return new Promise((resolve, reject) => {
        pendingSends.set(jobId, { manifest, sources, target, createdAt: Date.now(), resolve, reject });
        queue.add(jobId);
        advanceSendQueue();
      });
    },

    async startReceive({ rendezvous }) {
      const { channel, close } = await openChannel({ role: 'attach', rendezvous });
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
