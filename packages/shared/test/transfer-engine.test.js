import { expect, test } from 'vitest';
import { createReceiveJob, createSendJob } from '../src/transfer-engine.js';

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

test('send progress counts remaining-to-send bytes', () => {
  const tx = createSendJob({ manifest, resume: [{ fileId: 0, haveBytes: 4 }] });
  // to-send = (10-4) + (20-0) = 26
  expect(tx.progress().total).toBe(26);
  tx.onFileSent(0);
  expect(tx.progress().sent).toBe(6);
  expect(tx.progress().filesSent).toBe(1);
});
