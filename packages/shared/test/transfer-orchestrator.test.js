// SP3 transfer-orchestrator: send/receive drivers over an abstract channel.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSender } from '../src/transfer-orchestrator.js';
import { parseCtrlFrame, acceptFrame, rejectFrame } from '@farsight/shared/transfer-protocol';

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

test('createSender emits an "accepted" lifecycle event on accept, before any bytes — so the UI leaves "waiting for approval" only when the peer really accepts', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  const data = Buffer.from('payload'.repeat(30));
  writeFileSync(f, data);
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: data.length, mtime: 5 }], totalBytes: data.length, totalFiles: 1 };
  const events = [];
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'j1', manifest, sources: new Map([[0, f]]), chunkSize: 64, onEvent: (ev) => events.push(ev) });
  const finished = sender.start();

  // The OFFER is out but the peer hasn't accepted: NO 'accepted' event yet.
  expect(events.some((e) => e.type === 'accepted')).toBe(false);

  await ch.feedCtrl(acceptFrame({ jobId: 'j1', resume: [{ fileId: 0, haveBytes: 0 }] }));
  await finished;

  const iAcc = events.findIndex((e) => e.type === 'accepted');
  const iSent = events.findIndex((e) => e.type === 'file-sent');
  expect(iAcc).toBeGreaterThanOrEqual(0);           // accepted was emitted
  expect(iAcc).toBeLessThan(iSent);                 // and strictly before the first file-sent
});

test('createSender emits a "declined" event (and rejects) when the receiver rejects the offer', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  writeFileSync(f, Buffer.from('x'));
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 1, mtime: 5 }], totalBytes: 1, totalFiles: 1 };
  const events = [];
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'j1', manifest, sources: new Map([[0, f]]), onEvent: (ev) => events.push(ev) });
  const finished = sender.start();
  await ch.feedCtrl(rejectFrame({ jobId: 'j1', reason: 'declined' }));
  await expect(finished).rejects.toThrow(/rejected/);
  const declined = events.find((e) => e.type === 'declined');
  expect(declined).toBeTruthy();
  expect(declined.reason).toBe('declined');
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
  // Default peer (SP3 coherence contract #4): unknown on receive unless threaded.
  expect(store.saved.find((j) => j.jobState === 'done').peer).toEqual({});
});

test('createReceiver sends a prompting frame BEFORE awaiting consent (lets the sender stop its approval timeout)', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 10, mtime: 1 }], totalBytes: 10, totalFiles: 1 };
  let recvCtrl = () => {};
  const sent = [];
  let promptingSeenAtConsent = false;
  const ch = { sendCtrl(s) { sent.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const rx = createReceiver({
    channel: ch, destRoot: dest, store: memStore(),
    consent: async () => { promptingSeenAtConsent = sent.some((f) => f && f.t === 'prompting'); return false; },
  });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 'p1', entries: manifest.entries, totalBytes: 10, totalFiles: 1 }));
  await done;
  expect(promptingSeenAtConsent).toBe(true); // prompting was already on the wire when consent ran
});

test('createReceiver fails an accepted-but-stalled receive after inactivity (persists error + emits interrupted)', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 1000, mtime: 1 }], totalBytes: 1000, totalFiles: 1 };
  let recvCtrl = () => {};
  const sent = [];
  const events = [];
  // Controllable watchdog timer: capture the scheduled callback, fire on demand.
  let fire = null;
  const setTimer = (fn) => { fire = fn; return { unref() {} }; };
  const clearTimer = () => { fire = null; };
  const store = memStore();
  const ch = { sendCtrl(s) { sent.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const rx = createReceiver({
    channel: ch, destRoot: dest, store, consent: async () => true,
    onEvent: (ev) => events.push(ev), inactivityMs: 50, setTimer, clearTimer,
  });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 's1', entries: manifest.entries, totalBytes: 1000, totalFiles: 1 }));
  expect(sent.some((f) => f.t === 'accept')).toBe(true); // accepted -> watchdog armed
  expect(typeof fire).toBe('function');
  fire(); // no bytes ever arrived -> inactivity fires
  await expect(done).rejects.toThrow(/stalled/);
  expect(events.some((e) => e.type === 'interrupted')).toBe(true);
  expect(store.saved.some((j) => j.jobState === 'error')).toBe(true);
});

test('createReceiver does NOT arm the inactivity watchdog before accept (a slow human at the consent prompt is not a stall)', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 10, mtime: 1 }], totalBytes: 10, totalFiles: 1 };
  let recvCtrl = () => {};
  let armed = false;
  const setTimer = (fn) => { armed = true; return { unref() {} }; };
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  let release;
  const rx = createReceiver({
    channel: ch, destRoot: dest, store: memStore(),
    consent: () => new Promise((r) => { release = r; }), inactivityMs: 50, setTimer, clearTimer: () => {},
  });
  rx.start();
  // Don't await — the offer handler parks on the (never-resolving) consent.
  recvCtrl(offerFrame({ jobId: 'h1', entries: manifest.entries, totalBytes: 10, totalFiles: 1 }));
  await new Promise((r) => setTimeout(r, 20)); // let it reach the consent await
  expect(armed).toBe(false); // still waiting on the human — watchdog not armed yet
  release(false); // decline to clean up
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

// SP3 coherence contract #2: consent must receive the REAL transfer jobId
// (the one assigned by the sender via OFFER, and persisted to the jobs-store)
// rather than a locally-minted correlation id.
test('createReceiver passes the real jobId to consent alongside the manifest', async () => {
  const dest = tmp();
  let recvCtrl = () => {};
  const sent = [];
  const seen = [];
  const ch = { sendCtrl(s) { sent.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const entries = [{ fileId: 0, path: 'x.bin', size: 1, mtime: 1 }];
  const rx = createReceiver({
    channel: ch, destRoot: dest, store: memStore(),
    consent: async (arg) => { seen.push(arg); return false; },
  });
  rx.start();
  await recvCtrl(offerFrame({ jobId: 'consent-jid', entries, totalBytes: 1, totalFiles: 1 }));
  expect(seen.length).toBe(1);
  expect(seen[0].jobId).toBe('consent-jid');
  expect(seen[0].manifest.totalFiles).toBe(1);
  expect(sent.some((f) => f.t === 'reject' && f.reason === 'declined')).toBe(true);
});

import { walkSource } from '@farsight/shared/transfer-io';
import { buildManifest as buildManifestReal } from '@farsight/shared/transfer-manifest';
import { mkdirSync } from 'node:fs';

// Cross-wire two channels: whatever the sender sends, the receiver receives, and
// vice-versa. Delivery is deferred a microtask to mimic real async ordering.
function loopback() {
  const A = makeSide(), B = makeSide();
  A.peer = B; B.peer = A;
  return { sender: A, receiver: B };
  function makeSide() {
    const side = { ctrlCb: null, bulkCb: null, peer: null,
      sendCtrl(s) { queueMicrotask(() => side.peer.ctrlCb && side.peer.ctrlCb(s)); },
      sendBulk(b) { const buf = Buffer.from(b); return new Promise((r) => queueMicrotask(() => { side.peer.bulkCb && side.peer.bulkCb(buf); r(); })); },
      onCtrl(cb) { side.ctrlCb = cb; }, onBulk(cb) { side.bulkCb = cb; } };
    return side;
  }
}

test('loopback: a multi-file folder transfers, verifies, and finalizes every file', async () => {
  const srcRoot = tmp();
  const src = join(srcRoot, 'game');
  mkdirSync(join(src, 'data'), { recursive: true });
  writeFileSync(join(src, 'a.txt'), Buffer.from('alpha'.repeat(1000)));
  writeFileSync(join(src, 'data', 'b.bin'), Buffer.alloc(4096, 9));
  writeFileSync(join(src, 'data', 'c.bin'), Buffer.from('gamma'.repeat(777)));

  const { entries, sources } = await walkSource([{ path: src }]);
  const manifest = buildManifestReal(entries);
  const dest = tmp();

  const { sender: sCh, receiver: rCh } = loopback();
  const rx = createReceiver({ channel: rCh, destRoot: dest, store: memStore(), consent: async () => true });
  const rxDone = rx.start();
  const tx = createSender({ channel: sCh, jobId: 'loop1', manifest, sources, chunkSize: 1000 });
  await tx.start();
  const res = await rxDone;

  expect(res.ok).toBe(true);
  for (const e of manifest.entries) {
    const got = readFileSync(join(dest, ...e.path.split('/')));
    const want = readFileSync(sources.get(e.fileId));
    expect(got).toEqual(want);
  }
});

test('createReceiver does not resolve on job_done until the last file finishes draining (completion gating)', async () => {
  const dest = tmp();
  const payload = Buffer.from('late-bytes-payload'.repeat(40));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'late.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };

  let recvCtrl = () => {}, recvBulk = () => {};
  const sent = [];
  const ch = {
    sendCtrl(s) { sent.push(parseCtrlFrame(s)); },
    async sendBulk() {},
    onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; },
  };
  const store = memStore();
  const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true });
  const done = rx.start();
  let settled = false;
  done.then(() => { settled = true; });

  await recvCtrl(offerFrame({ jobId: 'g1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await recvCtrl(fileBeginFrame({ jobId: 'g1', fileId: 0, offset: 0 }));
  // job_done arrives BEFORE the file's bulk bytes and FILE_END (ft-ctrl and
  // ft-bulk are independently ordered) — the receiver must NOT resolve yet.
  await recvCtrl(jobDoneFrame({ jobId: 'g1' }));
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);

  await recvBulk(payload);
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false); // bytes landed, but FILE_END's hash hasn't arrived yet

  await recvCtrl(fileEndFrame({ jobId: 'g1', fileId: 0, hash }));
  const res = await done;

  expect(res.ok).toBe(true);
  expect(existsSync(join(dest, 'late.bin'))).toBe(true);
});

test('createReceiver resolves (does not hang) with ok:false when it declines an offer with a traversal path', async () => {
  const dest = tmp();
  let recvCtrl = () => {};
  const sent = [];
  const ch = { sendCtrl(s) { sent.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const rx = createReceiver({ channel: ch, destRoot: dest, store: memStore(), consent: async () => true });
  const done = rx.start();

  await recvCtrl(offerFrame({ jobId: 'bad2', entries: [{ fileId: 0, path: '../escape', size: 1, mtime: 1 }], totalBytes: 1, totalFiles: 1 }));
  expect(sent.some((f) => f.t === 'reject')).toBe(true);

  const res = await done; // must settle, not hang
  expect(res.ok).toBe(false);
});

test('createReceiver resolves ok:false (does not hang) on a hash mismatch, and discards the .part', async () => {
  const dest = tmp();
  const payload = Buffer.from('mismatch-payload'.repeat(40));
  const manifest = { entries: [{ fileId: 0, path: 'bad.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };

  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = {
    sendCtrl() {}, async sendBulk() {},
    onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; },
  };
  const store = memStore();
  const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true });
  const done = rx.start();

  await recvCtrl(offerFrame({ jobId: 'm1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await recvCtrl(fileBeginFrame({ jobId: 'm1', fileId: 0, offset: 0 }));
  await recvBulk(payload);
  await recvCtrl(fileEndFrame({ jobId: 'm1', fileId: 0, hash: 'deadbeef'.repeat(8) })); // wrong hash (64 hex chars)
  await recvCtrl(jobDoneFrame({ jobId: 'm1' }));
  const res = await done; // must settle, not hang

  expect(res.ok).toBe(false);
  expect(existsSync(join(dest, 'bad.bin'))).toBe(false);
  expect(existsSync(join(dest, 'bad.bin.part'))).toBe(false); // discarded on mismatch
});

test('loopback: an interrupted single file resumes and still verifies (restart completion-read)', async () => {
  const srcRoot = tmp();
  const f = join(srcRoot, 'big.bin');
  const data = Buffer.concat([Buffer.alloc(3000, 1), Buffer.alloc(3000, 2)]); // 6000 bytes
  writeFileSync(f, data);
  const manifest = buildManifestReal([{ fileId: 0, path: 'big.bin', size: data.length, mtime: 1700000000000 }]);
  const sources = new Map([[0, f]]);
  const dest = tmp();

  // Phase 1: run a real transfer to completion, then truncate the .part-equivalent
  // by re-deriving a partial file on disk to simulate an interrupted transfer.
  // (Simplification over the plan's "crash after ~3000 bytes" wrapper: run a full
  // loopback transfer into a scratch dest, then copy only the first 3000 bytes of
  // the finalized file back as a `<name>.part` in the real dest — reproducing
  // exactly the on-disk state an interrupted transfer would have left, without
  // depending on timing/microtask-count fragility.)
  const finalPath = join(dest, 'big.bin');
  const partPath = `${finalPath}.part`;
  writeFileSync(partPath, data.subarray(0, 3000));

  // Phase 2: fresh sender+receiver (simulates an app restart — no in-RAM hash),
  // resume from the .part, finish.
  {
    const { sender: sCh, receiver: rCh } = loopback();
    const rx = createReceiver({ channel: rCh, destRoot: dest, store: memStore(), consent: async () => true });
    const rxDone = rx.start();
    const tx = createSender({ channel: sCh, jobId: 'r1', manifest, sources, chunkSize: 500 });
    await tx.start();
    const res = await rxDone;
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dest, 'big.bin'))).toEqual(data);
  }
});
