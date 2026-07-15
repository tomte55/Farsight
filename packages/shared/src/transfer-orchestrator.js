// packages/shared/src/transfer-orchestrator.js
// SP3 MAIN-ONLY send/receive drivers over an abstract channel (ft-ctrl JSON +
// ft-bulk bytes). Coordinates the pure engine + io + jobs-store + protocol.
// ft-ctrl and ft-bulk are INDEPENDENTLY ordered — the receiver routes bulk by
// counting against manifest sizes, and all handlers are serialized. See spec §5/§6.
import {
  offerFrame, fileBeginFrame, fileEndFrame, jobDoneFrame, acceptFrame, rejectFrame,
  parseCtrlFrame, TRANSFER_PROTOCOL_VERSION,
} from './transfer-protocol.js';
import { buildManifest, skipExisting } from './transfer-manifest.js';
import { createSendJob, createReceiveJob } from './transfer-engine.js';
import { sendFile, createPartFile, finalizeReceivedFile, hasFreeSpace, confineDestPath } from './transfer-io.js';
import { stat } from 'node:fs/promises';

// Serialize async event handlers so awaited writes never interleave.
function serializer() {
  let chain = Promise.resolve();
  return (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };
}

export function createSender({ channel, jobId, manifest, sources, chunkSize = 131072, onEvent = () => {} }) {
  let job = null;
  let resolve, reject;
  const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
  const run = serializer();

  async function pump() {
    for (;;) {
      const nf = job.nextFile();
      if (!nf) break;
      channel.sendCtrl(fileBeginFrame({ jobId, fileId: nf.fileId, offset: nf.offset }));
      const { hash } = await sendFile({
        sourcePath: sources.get(nf.fileId), offset: nf.offset, chunkSize,
        onChunk: (buf) => channel.sendBulk(buf),
      });
      channel.sendCtrl(fileEndFrame({ jobId, fileId: nf.fileId, hash }));
      job.onFileSent(nf.fileId);
      onEvent({ type: 'file-sent', fileId: nf.fileId, progress: job.progress() });
    }
    channel.sendCtrl(jobDoneFrame({ jobId }));
    resolve();
  }

  channel.onCtrl((str) => run(async () => {
    const f = parseCtrlFrame(str);
    if (!f || f.jobId !== jobId) return;
    if (f.t === 'reject') { reject(new Error(`rejected: ${f.reason}`)); return; }
    if (f.t === 'cancel') { reject(new Error('canceled')); return; }
    if (f.t === 'accept' && !job) { job = createSendJob({ manifest, resume: f.resume }); await pump(); }
  }));

  return {
    start() {
      channel.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
      return finished;
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

export function createReceiver({ channel, destRoot, store, consent, onEvent = () => {} }) {
  let job = null, manifest = null, jobId = null, ok = true;
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
  let resolve;
  const finished = new Promise((res) => { resolve = res; });
  const run = serializer();

  async function saveRecord(jobState) {
    if (!store || !manifest) return;
    await store.save({
      jobId, dir: 'recv', tier: 'adhoc', peer: {}, destRoot,
      manifest,
      perFile: manifest.entries.map((e) => ({ fileId: e.fileId, status: 'pending', hashLive: true })),
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
    if (r.ok) { job.markVerified(item.entry.fileId); onEvent({ type: 'file-done', fileId: item.entry.fileId, progress: job.progress() }); }
    else { ok = false; job.markFailed(item.entry.fileId); onEvent({ type: 'file-failed', fileId: item.entry.fileId }); }
  }

  channel.onBulk((buf) => run(async () => {
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
  }));

  channel.onCtrl((str) => run(async () => {
    const f = parseCtrlFrame(str);
    if (!f) return;
    if (f.t === 'offer') {
      if (job) return;
      if (typeof f.protoVer === 'number' && f.protoVer > TRANSFER_PROTOCOL_VERSION) { channel.sendCtrl(rejectFrame({ jobId: f.jobId, reason: 'proto' })); return; }
      let m; try { m = buildManifest(f.entries); } catch { channel.sendCtrl(rejectFrame({ jobId: f.jobId, reason: 'bad_manifest' })); return; }
      jobId = f.jobId; manifest = m;
      if (!(await hasFreeSpace(destRoot, m.totalBytes))) { channel.sendCtrl(rejectFrame({ jobId, reason: 'nospace' })); return; }
      if (!(await consent({ manifest: m }))) { channel.sendCtrl(rejectFrame({ jobId, reason: 'declined' })); return; }
      const have = {};
      for (const e of m.entries) have[e.fileId] = await resumeOffsetFor(destRoot, e);
      job = createReceiveJob({ manifest: m, have });
      await saveRecord('active');
      channel.sendCtrl(acceptFrame({ jobId, resume: job.resumePlan() }));
      return;
    }
    if (!jobId || f.jobId !== jobId) return;
    if (f.t === 'file_begin') {
      const e = manifest.entries.find((x) => x.fileId === f.fileId);
      if (!e) return;
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
      await saveRecord('done');
      resolve({ jobId, ok });
    }
  }));

  return { start() { return finished; } };
}
