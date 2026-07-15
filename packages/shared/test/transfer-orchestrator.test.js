// SP3 transfer-orchestrator: send/receive drivers over an abstract channel.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSender } from '../src/transfer-orchestrator.js';
import { parseCtrlFrame, acceptFrame } from '@farsight/shared/transfer-protocol';

const dirs = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'ftorc-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

// A one-directional fake channel that records what the sender emits and lets the
// test feed ctrl frames back in.
function fakeChannel() {
  let ctrlCb = () => {}, bulkCb = () => {};
  return {
    ctrlOut: [], bulkOut: [],
    sendCtrl(s) { this.ctrlOut.push(parseCtrlFrame(s)); },
    async sendBulk(b) { this.bulkOut.push(Buffer.from(b)); },
    onCtrl(cb) { ctrlCb = cb; }, onBulk(cb) { bulkCb = cb; },
    feedCtrl(s) { return ctrlCb(s); }, feedBulk(b) { return bulkCb(b); },
  };
}

test('createSender offers, then streams a file and finishes on accept', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  const data = Buffer.from('hello-world-payload'.repeat(100));
  writeFileSync(f, data);
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: data.length, mtime: 5 }], totalBytes: data.length, totalFiles: 1 };
  const sources = new Map([[0, f]]);
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'j1', manifest, sources, chunkSize: 64 });
  const finished = sender.start();

  // First emitted frame is the OFFER.
  expect(ch.ctrlOut[0].t).toBe('offer');
  expect(ch.ctrlOut[0].jobId).toBe('j1');
  // Accept everything from 0.
  await ch.feedCtrl(acceptFrame({ jobId: 'j1', resume: [{ fileId: 0, haveBytes: 0 }] }));
  await finished;

  // It emitted FILE_BEGIN, bulk bytes, FILE_END(hash), JOB_DONE.
  const types = ch.ctrlOut.map((f) => f.t);
  expect(types).toEqual(['offer', 'file_begin', 'file_end', 'job_done']);
  expect(Buffer.concat(ch.bulkOut)).toEqual(data);
  const end = ch.ctrlOut.find((f) => f.t === 'file_end');
  expect(end.hash).toBe(createHash('sha256').update(data).digest('hex'));
});

test('createSender skips a file the receiver already has fully', async () => {
  const root = tmp();
  const f = join(root, 'b.bin');
  const data = Buffer.alloc(500, 7);
  writeFileSync(f, data);
  const manifest = { entries: [{ fileId: 0, path: 'b.bin', size: 500, mtime: 1 }], totalBytes: 500, totalFiles: 1 };
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'j2', manifest, sources: new Map([[0, f]]), chunkSize: 128 });
  const finished = sender.start();
  await ch.feedCtrl(acceptFrame({ jobId: 'j2', resume: [{ fileId: 0, haveBytes: 500 }] })); // already complete
  await finished;
  expect(ch.bulkOut.length).toBe(0); // nothing streamed
  expect(ch.ctrlOut.map((f) => f.t)).toEqual(['offer', 'job_done']);
});
