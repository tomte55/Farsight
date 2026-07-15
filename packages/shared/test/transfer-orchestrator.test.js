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

import { createReceiver } from '../src/transfer-orchestrator.js';
import { offerFrame, fileBeginFrame, fileEndFrame, jobDoneFrame } from '@farsight/shared/transfer-protocol';

const memStore = () => ({ saved: [], async save(j) { this.saved.push(JSON.parse(JSON.stringify(j))); }, async load() { return null; }, async list() { return []; } });

test('createReceiver validates the offer, accepts, writes bytes, verifies and finalizes', async () => {
  const dest = tmp();
  const payload = Buffer.from('receiver-side-bytes'.repeat(50));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'sub/x.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };

  // A fake channel the TEST drives as if it were the sender.
  let recvCtrl = () => {}, recvBulk = () => {};
  const sentToSender = [];
  const ch = {
    sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); },
    async sendBulk() {},
    onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; },
  };
  const store = memStore();
  const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true });
  const done = rx.start();

  await recvCtrl(offerFrame({ jobId: 'r1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  const accept = sentToSender.find((f) => f.t === 'accept');
  expect(accept).toBeTruthy();
  expect(accept.resume).toEqual([{ fileId: 0, haveBytes: 0 }]);

  await recvCtrl(fileBeginFrame({ jobId: 'r1', fileId: 0, offset: 0 }));
  await recvBulk(payload);
  await recvCtrl(fileEndFrame({ jobId: 'r1', fileId: 0, hash }));
  await recvCtrl(jobDoneFrame({ jobId: 'r1' }));
  const res = await done;

  expect(res.ok).toBe(true);
  expect(existsSync(join(dest, 'sub', 'x.bin'))).toBe(true);
  expect(readFileSync(join(dest, 'sub', 'x.bin'))).toEqual(payload);
  expect(existsSync(join(dest, 'sub', 'x.bin.part'))).toBe(false); // renamed
  expect(store.saved.some((j) => j.jobState === 'done')).toBe(true);
});

test('createReceiver rejects a manifest with a traversal path', async () => {
  const dest = tmp();
  let recvCtrl = () => {};
  const sent = [];
  const ch = { sendCtrl(s) { sent.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const rx = createReceiver({ channel: ch, destRoot: dest, store: memStore(), consent: async () => true });
  rx.start();
  // A hostile entry that Phase-1 buildManifest rejects.
  await recvCtrl(offerFrame({ jobId: 'bad', entries: [{ fileId: 0, path: '../escape', size: 1, mtime: 1 }], totalBytes: 1, totalFiles: 1 }));
  expect(sent.some((f) => f.t === 'reject')).toBe(true);
  expect(sent.some((f) => f.t === 'accept')).toBe(false);
});
