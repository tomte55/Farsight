import { expect, test } from 'vitest';
import {
  TRANSFER_PROTOCOL_VERSION,
  offerFrame, acceptFrame, rejectFrame, fileBeginFrame, fileEndFrame,
  jobDoneFrame, pauseFrame, resumeFrame, cancelFrame, errorFrame,
  fsReqFrame, fsResFrame, parseCtrlFrame,
} from '../src/transfer-protocol.js';

test('offer/accept/file frames round-trip through parseCtrlFrame', () => {
  const entries = [{ fileId: 0, path: 'a.txt', size: 3, mtime: 1 }];
  expect(parseCtrlFrame(offerFrame({ jobId: 'j1', entries, totalBytes: 3, totalFiles: 1 }))).toEqual({
    t: 'offer', jobId: 'j1', protoVer: TRANSFER_PROTOCOL_VERSION, entries, totalBytes: 3, totalFiles: 1,
  });
  expect(parseCtrlFrame(acceptFrame({ jobId: 'j1', resume: [{ fileId: 0, haveBytes: 2 }] }))).toEqual({
    t: 'accept', jobId: 'j1', resume: [{ fileId: 0, haveBytes: 2 }],
  });
  expect(parseCtrlFrame(fileBeginFrame({ jobId: 'j1', fileId: 0, offset: 2 }))).toEqual({
    t: 'file_begin', jobId: 'j1', fileId: 0, offset: 2,
  });
  expect(parseCtrlFrame(fileEndFrame({ jobId: 'j1', fileId: 0, hash: 'abc' }))).toEqual({
    t: 'file_end', jobId: 'j1', fileId: 0, hash: 'abc',
  });
});

test('control + fs frames round-trip', () => {
  expect(parseCtrlFrame(jobDoneFrame({ jobId: 'j1' }))).toEqual({ t: 'job_done', jobId: 'j1' });
  expect(parseCtrlFrame(pauseFrame('j1'))).toEqual({ t: 'pause', jobId: 'j1' });
  expect(parseCtrlFrame(resumeFrame('j1'))).toEqual({ t: 'resume', jobId: 'j1' });
  expect(parseCtrlFrame(cancelFrame('j1'))).toEqual({ t: 'cancel', jobId: 'j1' });
  expect(parseCtrlFrame(rejectFrame({ jobId: 'j1', reason: 'no room' }))).toEqual({ t: 'reject', jobId: 'j1', reason: 'no room' });
  expect(parseCtrlFrame(errorFrame({ jobId: 'j1', code: 'ENOSPC' }))).toEqual({ t: 'error', jobId: 'j1', code: 'ENOSPC' });
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
