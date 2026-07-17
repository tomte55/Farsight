import { expect, test } from 'vitest';
import { createReceiveJob, createSendJob, nextJobState } from '../src/transfer-engine.js';

const manifest = {
  entries: [
    { fileId: 0, path: 'a', size: 10, mtime: 1 },
    { fileId: 1, path: 'b', size: 20, mtime: 1 },
  ],
  totalBytes: 30, totalFiles: 2,
};

test('resumePlan reports durable bytes; already-complete files start done', () => {
  const rx = createReceiveJob({ manifest, have: { 0: 4, 1: 20 } });
  expect(rx.resumePlan()).toEqual([{ fileId: 0, haveBytes: 4 }, { fileId: 1, haveBytes: 20 }]);
  expect(rx.progress().filesDone).toBe(1); // file 1 already full
});

test('onFileBegin/onBytes/onFileEnd + verify drive a file to done', () => {
  const rx = createReceiveJob({ manifest, have: { 0: 4 } });
  rx.onFileBegin({ fileId: 0, offset: 4 });
  expect(rx.onBytes(0, 6)).toBe(1); // 4 + 6 = 10 = size → fraction 1
  rx.onFileEnd({ fileId: 0 });
  expect(rx.isComplete()).toBe(false); // pending verify + file 1 outstanding
  rx.markVerified(0);
  expect(rx.progress().filesDone).toBe(1);
});

test('markFailed resets a file for re-request', () => {
  const rx = createReceiveJob({ manifest });
  rx.onFileBegin({ fileId: 0, offset: 0 });
  rx.onBytes(0, 10);
  rx.onFileEnd({ fileId: 0 });
  rx.markFailed(0);
  expect(rx.resumePlan()[0]).toEqual({ fileId: 0, haveBytes: 0 });
});

test('isComplete true only when every file verified', () => {
  const rx = createReceiveJob({ manifest, have: { 0: 10, 1: 20 } });
  expect(rx.isComplete()).toBe(true);
});

test('received bytes clamp to file size and never exceed', () => {
  // have larger than size clamps at init
  const rx = createReceiveJob({ manifest, have: { 0: 999 } });
  expect(rx.resumePlan()[0]).toEqual({ fileId: 0, haveBytes: 10 });
  // onBytes beyond remaining clamps and returns fraction 1 (not > 1)
  const rx2 = createReceiveJob({ manifest });
  rx2.onFileBegin({ fileId: 1, offset: 0 });
  expect(rx2.onBytes(1, 999)).toBe(1);
  expect(rx2.resumePlan()[1]).toEqual({ fileId: 1, haveBytes: 20 });
});

test('nextFile walks files sequentially, honoring resume offsets and skips', () => {
  const tx = createSendJob({ manifest, resume: [{ fileId: 0, haveBytes: 4 }, { fileId: 1, haveBytes: 20 }] });
  expect(tx.nextFile()).toEqual({ fileId: 0, offset: 4, size: 10 }); // file 1 fully present → skipped
  tx.onFileSent(0);
  expect(tx.nextFile()).toBeNull();
  expect(tx.isComplete()).toBe(true);
});

test('send with no resume starts every file at 0', () => {
  const tx = createSendJob({ manifest });
  expect(tx.nextFile()).toEqual({ fileId: 0, offset: 0, size: 10 });
  tx.onFileSent(0);
  expect(tx.nextFile()).toEqual({ fileId: 1, offset: 0, size: 20 });
});

test('send progress reports absolute bytes over the FULL manifest (not remaining-only)', () => {
  const tx = createSendJob({ manifest, resume: [{ fileId: 0, haveBytes: 4 }] });
  // total = whole manifest = 10 + 20 = 30 (was: remaining-to-send = 26)
  expect(tx.progress().total).toBe(30);
  // the resumed offset counts as already sent — absolute, comparable to the receiver
  expect(tx.progress().sent).toBe(4);
  tx.onFileSent(0);
  expect(tx.progress().sent).toBe(10); // file 0 fully sent (was: 6, the remaining-only delta)
  expect(tx.progress().filesSent).toBe(1);
});

test('send job reports absolute byte progress over the FULL manifest', () => {
  const manifest = { entries: [{ fileId: 1, size: 100 }, { fileId: 2, size: 300 }] };
  const job = createSendJob({ manifest });
  const p = job.progress();
  expect(p.total).toBe(400); // the whole manifest, not "what's left to do"
  expect(p.sent).toBe(0);
  expect(p.fraction).toBe(0);
});

test('send job counts a resumed offset as already sent (absolute, comparable to the receiver)', () => {
  const manifest = { entries: [{ fileId: 1, size: 100 }, { fileId: 2, size: 300 }] };
  const job = createSendJob({ manifest, resume: [{ fileId: 1, haveBytes: 100 }, { fileId: 2, haveBytes: 100 }] });
  const p = job.progress();
  expect(p.total).toBe(400);
  expect(p.sent).toBe(200);   // 100 (whole file 1) + 100 (partial file 2)
  expect(p.fraction).toBe(0.5);
  expect(p.filesSent).toBe(1); // only file 1 is complete
});

test('send job onBytes advances progress mid-file (the bar must move during one huge file)', () => {
  const manifest = { entries: [{ fileId: 1, size: 1000 }] };
  const job = createSendJob({ manifest });
  expect(job.onBytes(1, 250)).toBe(0.25); // returns this file's fraction
  expect(job.progress().sent).toBe(250);
  expect(job.progress().fraction).toBe(0.25);
  job.onBytes(1, 250);
  expect(job.progress().sent).toBe(500);
});

test('send job onBytes never exceeds the file size and ignores bad input', () => {
  const manifest = { entries: [{ fileId: 1, size: 100 }] };
  const job = createSendJob({ manifest });
  job.onBytes(1, 500); // more than the file — clamp
  expect(job.progress().sent).toBe(100);
  expect(job.onBytes(99, 10)).toBe(0);   // unknown fileId
  expect(job.onBytes(1, -5)).toBe(0);    // negative
  expect(job.progress().sent).toBe(100);
});

test('onFileSent snaps the file to fully sent even if no bytes were reported', () => {
  const manifest = { entries: [{ fileId: 1, size: 100 }, { fileId: 2, size: 100 }] };
  const job = createSendJob({ manifest });
  job.onFileSent(1);
  const p = job.progress();
  expect(p.sent).toBe(100);
  expect(p.filesSent).toBe(1);
});

test('a fully-resumed send job reads as complete', () => {
  const manifest = { entries: [{ fileId: 1, size: 100 }] };
  const job = createSendJob({ manifest, resume: [{ fileId: 1, haveBytes: 100 }] });
  expect(job.isComplete()).toBe(true);
  expect(job.progress().fraction).toBe(1);
});

test('nextJobState models the queue lifecycle', () => {
  expect(nextJobState('active', 'pause')).toBe('paused');
  expect(nextJobState('paused', 'resume')).toBe('active');
  expect(nextJobState('active', 'disconnect')).toBe('interrupted');
  expect(nextJobState('interrupted', 'reconnect')).toBe('active');
  expect(nextJobState('active', 'complete')).toBe('done');
  expect(nextJobState('active', 'fail')).toBe('error');
  expect(nextJobState('active', 'cancel')).toBe('canceled');
  expect(nextJobState('error', 'retry')).toBe('active');
});

test('nextJobState ignores impossible transitions', () => {
  expect(nextJobState('done', 'pause')).toBe('done');
  expect(nextJobState('canceled', 'resume')).toBe('canceled');
  expect(nextJobState('active', 'bogus')).toBe('active');
  expect(nextJobState('nonsense', 'pause')).toBe('nonsense');
});

test('a user-paused job stays paused across a disconnect (pause intent survives)', () => {
  expect(nextJobState('paused', 'disconnect')).toBe('paused');
  // and it does not auto-resume: a reconnect while paused is a no-op
  expect(nextJobState('paused', 'reconnect')).toBe('paused');
});
