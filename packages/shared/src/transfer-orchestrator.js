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
