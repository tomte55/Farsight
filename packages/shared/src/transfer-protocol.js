// Pure wire-protocol framers + tolerant parser for the SP3 'ft-ctrl' channel
// (spec §5). Bulk file bytes ride 'ft-bulk' header-less and are NOT framed here.
// NO fs/WebRTC/DOM. Parser returns null on any malformed/hostile input.

export const TRANSFER_PROTOCOL_VERSION = 1;

function isStr(x) { return typeof x === 'string' && x.length > 0; }
function nn(x) { return Number.isInteger(x) && x >= 0; }
// Every legitimate jobId is minted by newJobId() (transfer-queue.js):
// randomUUID().replace(/-/g, '') -> exactly 32 lowercase hex chars. jobId is
// sender-chosen on the wire and the RECEIVER ends up path-joining it into the
// jobs-store filename (jobs-store.js) after the human consents to the transfer
// -- a jobId that isn't this exact shape can never have come from a genuine
// peer, so reject it here at the protocol boundary like any other malformed
// frame (review finding: sender-chosen jobId used unsanitized in a fs path).
const JOB_ID_RE = /^[0-9a-f]{32}$/;
function isJobId(x) { return typeof x === 'string' && JOB_ID_RE.test(x); }

export function offerFrame({ jobId, entries, totalBytes, totalFiles, protoVer = TRANSFER_PROTOCOL_VERSION }) {
  return JSON.stringify({ t: 'offer', jobId, protoVer, entries, totalBytes, totalFiles });
}
// A manifest with many files serializes larger than the WebRTC data-channel max
// message size (~256KB), and sending it in ONE frame throws + kills ft-ctrl (field
// bug: a 2974-file folder died on the OFFER send). So a large OFFER is split into
// offer_begin → offer_entries* → offer_end, each entries batch kept well under the
// limit. Small manifests still use the single legacy `offer` (old-receiver-compatible).
export function offerBeginFrame({ jobId, totalBytes, totalFiles, protoVer = TRANSFER_PROTOCOL_VERSION }) {
  return JSON.stringify({ t: 'offer_begin', jobId, protoVer, totalBytes, totalFiles });
}
export function offerEntriesFrame({ jobId, entries }) { return JSON.stringify({ t: 'offer_entries', jobId, entries }); }
export function offerEndFrame({ jobId }) { return JSON.stringify({ t: 'offer_end', jobId }); }
// Receiver -> sender the moment the consent prompt is shown: tells the sender the
// host is alive and now waiting on a HUMAN decision, so the sender can stop its
// rendezvous/approval timeout (which must not fire while a person is deciding —
// otherwise the sender falsely reports "host didn't respond" while the prompt is
// still up, and a later Accept lands on a torn-down channel).
export function promptingFrame({ jobId }) { return JSON.stringify({ t: 'prompting', jobId }); }
export function acceptFrame({ jobId, resume }) { return JSON.stringify({ t: 'accept', jobId, resume }); }
export function rejectFrame({ jobId, reason = '' }) { return JSON.stringify({ t: 'reject', jobId, reason }); }
export function fileBeginFrame({ jobId, fileId, offset }) { return JSON.stringify({ t: 'file_begin', jobId, fileId, offset }); }
export function fileEndFrame({ jobId, fileId, hash }) { return JSON.stringify({ t: 'file_end', jobId, fileId, hash }); }
export function jobDoneFrame({ jobId }) { return JSON.stringify({ t: 'job_done', jobId }); }
// Receiver -> sender once EVERY file is received, verified and finalized on disk.
// This is the delivery acknowledgment: the sender must not resolve/close the
// connection until it arrives, otherwise it tears the channel down while the
// receiver is still draining buffered data and the tail is lost.
export function completeFrame({ jobId, ok }) { return JSON.stringify({ t: 'complete', jobId, ok: ok === true }); }
export function pauseFrame(jobId) { return JSON.stringify({ t: 'pause', jobId }); }
export function resumeFrame(jobId) { return JSON.stringify({ t: 'resume', jobId }); }
export function cancelFrame(jobId) { return JSON.stringify({ t: 'cancel', jobId }); }
export function errorFrame({ jobId, code }) { return JSON.stringify({ t: 'error', jobId, code }); }
export function fsReqFrame({ reqId, op, args }) { return JSON.stringify({ t: 'fs_req', reqId, op, args }); }
export function fsResFrame({ reqId, ok, data, error }) { return JSON.stringify({ t: 'fs_res', reqId, ok, data, error }); }

export function parseCtrlFrame(str) {
  if (typeof str !== 'string') return null;
  let o;
  try { o = JSON.parse(str); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  switch (o.t) {
    case 'offer':
      if (!isJobId(o.jobId) || !Array.isArray(o.entries) || !nn(o.totalBytes) || !nn(o.totalFiles)) return null;
      return { t: 'offer', jobId: o.jobId, protoVer: o.protoVer, entries: o.entries, totalBytes: o.totalBytes, totalFiles: o.totalFiles };
    case 'offer_begin':
      if (!isJobId(o.jobId) || !nn(o.totalBytes) || !nn(o.totalFiles)) return null;
      return { t: 'offer_begin', jobId: o.jobId, protoVer: o.protoVer, totalBytes: o.totalBytes, totalFiles: o.totalFiles };
    case 'offer_entries':
      if (!isJobId(o.jobId) || !Array.isArray(o.entries)) return null;
      return { t: 'offer_entries', jobId: o.jobId, entries: o.entries };
    case 'offer_end':
      if (!isJobId(o.jobId)) return null;
      return { t: 'offer_end', jobId: o.jobId };
    case 'accept':
      if (!isJobId(o.jobId) || !Array.isArray(o.resume)) return null;
      for (const r of o.resume) { if (!r || !nn(r.fileId) || !nn(r.haveBytes)) return null; }
      return { t: 'accept', jobId: o.jobId, resume: o.resume };
    case 'reject':
      if (!isJobId(o.jobId)) return null;
      return { t: 'reject', jobId: o.jobId, reason: typeof o.reason === 'string' ? o.reason : '' };
    case 'file_begin':
      if (!isJobId(o.jobId) || !nn(o.fileId) || !nn(o.offset)) return null;
      return { t: 'file_begin', jobId: o.jobId, fileId: o.fileId, offset: o.offset };
    case 'file_end':
      if (!isJobId(o.jobId) || !nn(o.fileId) || !isStr(o.hash)) return null;
      return { t: 'file_end', jobId: o.jobId, fileId: o.fileId, hash: o.hash };
    case 'job_done':
      if (!isJobId(o.jobId)) return null;
      return { t: 'job_done', jobId: o.jobId };
    case 'complete':
      if (!isJobId(o.jobId)) return null;
      return { t: 'complete', jobId: o.jobId, ok: o.ok === true };
    case 'prompting': case 'pause': case 'resume': case 'cancel':
      if (!isJobId(o.jobId)) return null;
      return { t: o.t, jobId: o.jobId };
    case 'error':
      if (!isJobId(o.jobId) || !isStr(o.code)) return null;
      return { t: 'error', jobId: o.jobId, code: o.code };
    case 'fs_req':
      if (!nn(o.reqId) || !isStr(o.op) || !o.args || typeof o.args !== 'object') return null;
      return { t: 'fs_req', reqId: o.reqId, op: o.op, args: o.args };
    case 'fs_res':
      if (!nn(o.reqId) || typeof o.ok !== 'boolean') return null;
      return { t: 'fs_res', reqId: o.reqId, ok: o.ok, data: o.data, error: o.error };
    default:
      return null;
  }
}
