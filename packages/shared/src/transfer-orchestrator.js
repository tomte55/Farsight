// packages/shared/src/transfer-orchestrator.js
// SP3 MAIN-ONLY send/receive drivers over an abstract channel (ft-ctrl JSON +
// ft-bulk bytes). Coordinates the pure engine + io + jobs-store + protocol.
// ft-ctrl and ft-bulk are INDEPENDENTLY ordered — the receiver routes bulk by
// counting against manifest sizes, and all handlers are serialized. See spec §5/§6.
import {
  offerFrame, fileBeginFrame, fileEndFrame, jobDoneFrame, acceptFrame, rejectFrame, promptingFrame,
  parseCtrlFrame, TRANSFER_PROTOCOL_VERSION,
} from './transfer-protocol.js';
import { buildManifest, skipExisting } from './transfer-manifest.js';
import { createSendJob, createReceiveJob } from './transfer-engine.js';
import { sendFile, createPartFile, finalizeReceivedFile, hasFreeSpace, confineDestPath } from './transfer-io.js';
import { stat } from 'node:fs/promises';

// Serialize async event handlers so awaited writes never interleave. Handler
// exceptions are surfaced to onErr (a `fail(err)`) instead of being swallowed —
// a swallowed exception here previously left the driver's promise hanging forever.
function serializer(onErr) {
  let chain = Promise.resolve();
  return (fn) => { chain = chain.then(fn).catch(onErr); return chain; };
}

export function createSender({ channel, jobId, manifest, sources, chunkSize = 131072, onEvent = () => {} }) {
  let job = null;
  let canceled = false;
  let settled = false;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
  const resolveOnce = (v) => { if (!settled) { settled = true; resolve(v); } };
  const fail = (e) => { if (!settled) { settled = true; reject(e); } };
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
    resolveOnce();
  }

  channel.onCtrl((str) => run(async () => {
    const f = parseCtrlFrame(str);
    if (!f || f.jobId !== jobId) return;
    // The receiver is prompting the user — it's alive and awaiting a human
    // decision. Surface it so the app can cancel the approval timeout (a person
    // deciding must NOT read as "host didn't respond").
    if (f.t === 'prompting') { onEvent({ type: 'prompting' }); return; }
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
      channel.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
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
  // `queue` is the ORDERED byte-routing structure (spec §5 correctness rule 1):
  // bulk chunks are counted against the head file's remaining bytes regardless
  // of ctrl-channel arrival order. `pending` maps fileId -> item so file_end can
  // attach a hash to an item that has ALREADY been fully written (bulk and ctrl
  // are independently ordered — bytes routinely finish before FILE_END arrives).
  // Routing advancement (queue.shift) must NOT wait on the hash, or a late
  // FILE_END would stall the queue head forever and hang routing for every file
  // queued behind it.
  const queue = []; // {entry, expected, received, partFile, hash, finalizing}
  const pending = new Map(); // fileId -> item
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
  // AND every file has finished routing (queue empty) AND finalized (pending
  // empty) — job_done and the last file's bulk bytes/FILE_END are independently
  // ordered, so job_done can arrive first and must NOT resolve early.
  async function maybeComplete() {
    if (settled) return;
    if (jobDoneSeen && queue.length === 0 && pending.size === 0) {
      await saveRecord('done');
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
    if (item.finalizing || item.received < item.expected || item.hash == null) return;
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
    let chunk = Buffer.from(buf);
    while (chunk.length > 0 && queue.length > 0) {
      const item = queue[0];
      const need = item.expected - item.received;
      const take = chunk.subarray(0, need);
      await item.partFile.write(take);
      item.received += take.length;
      job.onBytes(item.entry.fileId, take.length);
      chunk = chunk.subarray(take.length);
      if (item.received >= item.expected) {
        queue.shift(); // byte-complete: advance routing NOW, independent of hash arrival
        await tryFinalize(item); // finalizes only if FILE_END's hash already landed
      }
    }
    // Any bytes still left in `chunk` here mean the queue ran empty (no file is
    // currently expecting bytes) — deliberately discarded silently; not an error.
  }));

  channel.onCtrl((str) => run(async () => {
    pokeWatchdog(); // fresh ctrl frame — the transfer is alive
    const f = parseCtrlFrame(str);
    if (!f) return;
    if (f.t === 'offer') {
      if (job) return;
      if (typeof f.protoVer === 'number' && f.protoVer > TRANSFER_PROTOCOL_VERSION) {
        channel.sendCtrl(rejectFrame({ jobId: f.jobId, reason: 'proto' }));
        resolveOnce({ jobId: f.jobId, ok: false, rejected: 'proto' });
        return;
      }
      let m;
      try { m = buildManifest(f.entries); } catch {
        channel.sendCtrl(rejectFrame({ jobId: f.jobId, reason: 'bad_manifest' }));
        resolveOnce({ jobId: f.jobId, ok: false, rejected: 'bad_manifest' });
        return;
      }
      jobId = f.jobId; manifest = m;
      if (!(await hasFreeSpace(destRoot, m.totalBytes))) {
        channel.sendCtrl(rejectFrame({ jobId, reason: 'nospace' }));
        resolveOnce({ jobId, ok: false, rejected: 'nospace' });
        return;
      }
      // Thread the REAL transfer jobId (assigned by the sender via the OFFER
      // frame) into consent — not a locally-minted correlation id — so the
      // renderer's accept/reject round-trip and the persisted jobs-store
      // record agree on one id end to end (SP3 coherence contract #2).
      // Tell the sender we're now prompting a human, so it stops its approval
      // timeout (deciding is not "no response"). Sent BEFORE the await so it goes
      // out immediately, however long the user then takes.
      channel.sendCtrl(promptingFrame({ jobId }));
      if (!(await consent({ jobId, manifest: m }))) {
        channel.sendCtrl(rejectFrame({ jobId, reason: 'declined' }));
        resolveOnce({ jobId, ok: false, rejected: 'declined' });
        return;
      }
      const have = {};
      for (const e of m.entries) have[e.fileId] = await resumeOffsetFor(destRoot, e);
      job = createReceiveJob({ manifest: m, have });
      await saveRecord('active');
      channel.sendCtrl(acceptFrame({ jobId, resume: job.resumePlan() }));
      watching = true; pokeWatchdog(); // now expecting a steady stream of bytes
      return;
    }
    if (!jobId || f.jobId !== jobId) return;
    if (f.t === 'file_begin') {
      const e = manifest.entries.find((x) => x.fileId === f.fileId);
      if (!e) return;
      if (pending.has(f.fileId)) return; // duplicate FILE_BEGIN — a part file is already tracked, ignore
      job.onFileBegin({ fileId: f.fileId, offset: f.offset });
      const partFile = await createPartFile({ destRoot, relPath: e.path, resumeFrom: f.offset, hashLive: true });
      const item = { entry: e, expected: e.size - f.offset, received: 0, partFile, hash: null, finalizing: false };
      pending.set(e.fileId, item);
      if (item.expected > 0) queue.push(item);
      else await tryFinalize(item); // zero remaining bytes (e.g. fully-resumed tail); waits on file_end's hash
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
