import { expect, test } from 'vitest';
import { createReceiveJob } from '../src/transfer-engine.js';

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
