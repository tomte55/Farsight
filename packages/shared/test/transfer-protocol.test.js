import { expect, test } from 'vitest';
import {
  TRANSFER_PROTOCOL_VERSION,
  offerFrame, acceptFrame, rejectFrame, fileBeginFrame, fileEndFrame,
  jobDoneFrame, pauseFrame, resumeFrame, cancelFrame, errorFrame,
  fsReqFrame, fsResFrame, parseCtrlFrame,
} from '../src/transfer-protocol.js';

// A real jobId (as minted by transfer-queue.js's newJobId(): randomUUID with
// dashes stripped -- exactly 32 lowercase hex chars). parseCtrlFrame requires
// this exact shape (review finding: sender-chosen jobId used unsanitized in a
// receiver-side fs path) so every fixture below must be this shape, not the
// short human-readable ids ('j1' etc.) this file used before that fix.
const JID = '6caeba444797a281a0110e0c80ad5814';

test('offer/accept/file frames round-trip through parseCtrlFrame', () => {
  const entries = [{ fileId: 0, path: 'a.txt', size: 3, mtime: 1 }];
  expect(parseCtrlFrame(offerFrame({ jobId: JID, entries, totalBytes: 3, totalFiles: 1 }))).toEqual({
    t: 'offer', jobId: JID, protoVer: TRANSFER_PROTOCOL_VERSION, entries, totalBytes: 3, totalFiles: 1,
  });
  expect(parseCtrlFrame(acceptFrame({ jobId: JID, resume: [{ fileId: 0, haveBytes: 2 }] }))).toEqual({
    t: 'accept', jobId: JID, resume: [{ fileId: 0, haveBytes: 2 }],
  });
  expect(parseCtrlFrame(fileBeginFrame({ jobId: JID, fileId: 0, offset: 2 }))).toEqual({
    t: 'file_begin', jobId: JID, fileId: 0, offset: 2,
  });
  expect(parseCtrlFrame(fileEndFrame({ jobId: JID, fileId: 0, hash: 'abc' }))).toEqual({
    t: 'file_end', jobId: JID, fileId: 0, hash: 'abc',
  });
});

test('control + fs frames round-trip', () => {
  expect(parseCtrlFrame(jobDoneFrame({ jobId: JID }))).toEqual({ t: 'job_done', jobId: JID });
  expect(parseCtrlFrame(pauseFrame(JID))).toEqual({ t: 'pause', jobId: JID });
  expect(parseCtrlFrame(resumeFrame(JID))).toEqual({ t: 'resume', jobId: JID });
  expect(parseCtrlFrame(cancelFrame(JID))).toEqual({ t: 'cancel', jobId: JID });
  expect(parseCtrlFrame(rejectFrame({ jobId: JID, reason: 'no room' }))).toEqual({ t: 'reject', jobId: JID, reason: 'no room' });
  expect(parseCtrlFrame(errorFrame({ jobId: JID, code: 'ENOSPC' }))).toEqual({ t: 'error', jobId: JID, code: 'ENOSPC' });
  expect(parseCtrlFrame(fsReqFrame({ reqId: 7, op: 'list', args: { path: 'C:/', limit: 100 } }))).toEqual({
    t: 'fs_req', reqId: 7, op: 'list', args: { path: 'C:/', limit: 100 },
  });
  expect(parseCtrlFrame(fsResFrame({ reqId: 7, ok: true, data: { entries: [] } }))).toEqual({
    t: 'fs_res', reqId: 7, ok: true, data: { entries: [] }, error: undefined,
  });
});

test('parseCtrlFrame is tolerant of bad JSON and malformed frames', () => {
  expect(parseCtrlFrame('not json{')).toBeNull();
  expect(parseCtrlFrame('null')).toBeNull();
  expect(parseCtrlFrame(42)).toBeNull();
  expect(parseCtrlFrame(JSON.stringify({ t: 'nope' }))).toBeNull();
  expect(parseCtrlFrame(JSON.stringify({ t: 'offer', jobId: '', entries: [], totalBytes: 0, totalFiles: 0 }))).toBeNull();
  expect(parseCtrlFrame(JSON.stringify({ t: 'file_begin', jobId: 'j', fileId: -1, offset: 0 }))).toBeNull();
  expect(parseCtrlFrame(JSON.stringify({ t: 'accept', jobId: 'j', resume: [{ fileId: 0 }] }))).toBeNull();
  expect(parseCtrlFrame(JSON.stringify({ t: 'fs_req', reqId: 1, op: 'list' }))).toBeNull();
});

// Review finding (security, pre-existing): jobId is sender-chosen and the
// RECEIVER path-joins it into a jobs-store filename after the human consents
// -- a peer could send a traversal-shaped jobId ('../victim') and get an
// arbitrary-path .json write/overwrite primitive. Fixed by requiring every
// jobId to match newJobId()'s exact shape (32 lowercase hex chars) at the
// protocol boundary, so a malformed/hostile jobId never gets past parsing.
test('parseCtrlFrame rejects a traversal or oddly-shaped jobId, but still parses a real newJobId()-shaped one', () => {
  const entries = [{ fileId: 0, path: 'a.txt', size: 3, mtime: 1 }];
  const base = { entries, totalBytes: 3, totalFiles: 1 };

  // Path-traversal-shaped jobIds -- the exact attack the finding demonstrated.
  expect(parseCtrlFrame(offerFrame({ jobId: '../victim', ...base }))).toBeNull();
  expect(parseCtrlFrame(offerFrame({ jobId: '..\\victim', ...base }))).toBeNull();
  expect(parseCtrlFrame(offerFrame({ jobId: '/etc/passwd', ...base }))).toBeNull();
  expect(parseCtrlFrame(offerFrame({ jobId: 'C:\\Windows\\evil', ...base }))).toBeNull();
  // Not traversal, but still not newJobId()'s shape -- too short, uppercase,
  // non-hex characters, or an empty string.
  expect(parseCtrlFrame(offerFrame({ jobId: 'j1', ...base }))).toBeNull();
  expect(parseCtrlFrame(offerFrame({ jobId: JID.toUpperCase(), ...base }))).toBeNull();
  expect(parseCtrlFrame(offerFrame({ jobId: `${JID}x`, ...base }))).toBeNull();
  expect(parseCtrlFrame(offerFrame({ jobId: '', ...base }))).toBeNull();
  // Other frame types go through the same guard.
  expect(parseCtrlFrame(pauseFrame('../victim'))).toBeNull();
  expect(parseCtrlFrame(acceptFrame({ jobId: '../victim', resume: [] }))).toBeNull();

  // A real newJobId()-shaped id still parses normally.
  expect(parseCtrlFrame(offerFrame({ jobId: JID, ...base }))).toEqual({
    t: 'offer', jobId: JID, protoVer: TRANSFER_PROTOCOL_VERSION, ...base,
  });
});
