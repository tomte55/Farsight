// SP3 transfer-orchestrator: send/receive drivers over an abstract channel.
import { expect, test, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSender } from '../src/transfer-orchestrator.js';
import { parseCtrlFrame, acceptFrame, rejectFrame, completeFrame } from '@farsight/shared/transfer-protocol';
// Fix-round-3 regression test needs to gate transfer-io's finalizeReceivedFile
// mid-call (see below) — a passthrough vi.mock lets a single test spy over one
// export while every other test in this file still gets the REAL io module.
import * as transferIo from '../src/transfer-io.js';
vi.mock('../src/transfer-io.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

// Poll until a predicate holds (the sender's pump runs async after accept).
async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 1)); }
}

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
  await until(() => ch.ctrlOut.some((f) => f.t === 'job_done')); // pump finished sending
  await ch.feedCtrl(completeFrame({ jobId: 'j1', ok: true }));    // receiver acks delivery
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
  await until(() => ch.ctrlOut.some((f) => f.t === 'job_done'));
  await ch.feedCtrl(completeFrame({ jobId: 'j1', ok: true }));
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
  await until(() => ch.ctrlOut.some((f) => f.t === 'job_done'));
  await ch.feedCtrl(completeFrame({ jobId: 'j2', ok: true }));
  await finished;
  expect(ch.bulkOut.length).toBe(0); // nothing streamed
  expect(ch.ctrlOut.map((f) => f.t)).toEqual(['offer', 'job_done']);
});

test('createSender waits for the receiver\'s complete ack before resolving (delivery, not just send)', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  writeFileSync(f, Buffer.from('data'.repeat(50)));
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 200, mtime: 5 }], totalBytes: 200, totalFiles: 1 };
  const events = [];
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'w1', manifest, sources: new Map([[0, f]]), chunkSize: 64, onEvent: (ev) => events.push(ev) });
  let resolved = false;
  const finished = sender.start().then(() => { resolved = true; });
  await ch.feedCtrl(acceptFrame({ jobId: 'w1', resume: [{ fileId: 0, haveBytes: 0 }] }));
  await until(() => ch.ctrlOut.some((f) => f.t === 'job_done'));
  await new Promise((r) => setTimeout(r, 20));
  // All bytes are SENT (all-sent emitted) but NOT yet acked — must NOT resolve.
  expect(events.some((e) => e.type === 'all-sent')).toBe(true);
  expect(resolved).toBe(false);
  // The receiver confirms every file received + hash-verified -> resolve.
  await ch.feedCtrl(completeFrame({ jobId: 'w1', ok: true }));
  await finished;
  expect(resolved).toBe(true);
  expect(events.some((e) => e.type === 'completed')).toBe(true);
});

test('createSender fails when the receiver reports incomplete (complete ok:false)', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  writeFileSync(f, Buffer.from('x'.repeat(80)));
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 80, mtime: 5 }], totalBytes: 80, totalFiles: 1 };
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'w2', manifest, sources: new Map([[0, f]]), chunkSize: 64 });
  const finished = sender.start();
  await ch.feedCtrl(acceptFrame({ jobId: 'w2', resume: [{ fileId: 0, haveBytes: 0 }] }));
  await until(() => ch.ctrlOut.some((f) => f.t === 'job_done'));
  await ch.feedCtrl(completeFrame({ jobId: 'w2', ok: false }));
  await expect(finished).rejects.toThrow(/receiver_incomplete/);
});

test('createSender fails with no_confirmation if the complete ack never arrives (completion timeout backstop)', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  writeFileSync(f, Buffer.from('y'.repeat(60)));
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 60, mtime: 5 }], totalBytes: 60, totalFiles: 1 };
  let fire = null;
  const setTimer = (fn) => { fire = fn; return { unref() {} }; };
  const ch = fakeChannel();
  const sender = createSender({ channel: ch, jobId: 'w3', manifest, sources: new Map([[0, f]]), chunkSize: 64, completionTimeoutMs: 100, setTimer, clearTimer: () => {} });
  const finished = sender.start();
  await ch.feedCtrl(acceptFrame({ jobId: 'w3', resume: [{ fileId: 0, haveBytes: 0 }] }));
  await until(() => ch.ctrlOut.some((f) => f.t === 'job_done'));
  await until(() => typeof fire === 'function'); // completion backstop timer armed
  fire(); // the ack never came
  await expect(finished).rejects.toThrow(/no_confirmation/);
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
  // Fresh transfer → no non-zero resume offsets, so the accept omits them (keeps
  // the frame tiny; the sender defaults any missing file to offset 0).
  expect(accept.resume).toEqual([]);

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

test('multi-chunk files survive ctrl/bulk cross-channel skew (FILE_BEGIN arriving AFTER the bytes)', async () => {
  const srcRoot = tmp();
  const src = join(srcRoot, 'many');
  mkdirSync(src, { recursive: true });
  // Several MULTI-chunk files (each spans multiple chunks, distinct content) —
  // the exact shape that corrupted on a real 2-machine transfer (98 x ~1.5MB:
  // files 1-6 fine, 7-98 all hash-failed) once the ctrl channel lagged the bulk.
  for (let i = 0; i < 10; i++) writeFileSync(join(src, `f${i}.bin`), Buffer.alloc(5000 + i * 271, (i * 37 + 3) % 251));
  const { entries, sources } = await walkSource([{ path: src }]);
  const manifest = buildManifestReal(entries);
  const dest = tmp();

  const { sender: sCh, receiver: rCh } = loopback();
  // SKEW: deliver ctrl frames to the receiver a macrotask LATER than bulk, so a
  // file's bytes routinely arrive before its FILE_BEGIN — exactly what happens
  // over the wire once the (small, prompt) ctrl channel falls behind the
  // (large, backpressured) bulk channel.
  const skewed = {
    sendCtrl: (s) => rCh.sendCtrl(s),
    sendBulk: (b) => rCh.sendBulk(b),
    onCtrl: (cb) => rCh.onCtrl((s) => setTimeout(() => cb(s), 3)),
    onBulk: (cb) => rCh.onBulk((b) => cb(b)),
  };
  const rx = createReceiver({ channel: skewed, destRoot: dest, store: memStore(), consent: async () => true });
  const rxDone = rx.start();
  const tx = createSender({ channel: sCh, jobId: 'skew1', manifest, sources, chunkSize: 1000 });
  tx.start().catch(() => {});
  const res = await rxDone;

  expect(res.ok).toBe(true); // every file received and hash-verified despite the skew
  for (const e of manifest.entries) {
    expect(readFileSync(join(dest, ...e.path.split('/')))).toEqual(readFileSync(sources.get(e.fileId)));
  }
});

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

test('receiver emits throttled progress events as bulk bytes arrive — not just at file boundaries', async () => {
  const dest = tmp();
  const payload = Buffer.alloc(4000, 7);
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'big.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const events = [];
  let clock = 0;
  const rx = createReceiver({
    channel: ch, destRoot: dest, store: memStore(), consent: async () => true,
    progressIntervalMs: 100, now: () => clock, onEvent: (ev) => events.push(ev),
  });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 'p1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  // Four 1000-byte chunks of ONE file, each a throttle-interval apart.
  for (let i = 0; i < 4; i += 1) { clock += 100; await recvBulk(payload.subarray(i * 1000, (i + 1) * 1000)); }
  await recvCtrl(fileEndFrame({ jobId: 'p1', fileId: 0, hash }));
  await recvCtrl(jobDoneFrame({ jobId: 'p1' }));
  await done;
  const prog = events.filter((e) => e.type === 'progress');
  expect(prog.length).toBeGreaterThan(1); // NOT one snapshot at the end — a 100GB file needs movement
  const bytes = prog.map((e) => e.progress.received);
  expect(bytes).toEqual([...bytes].sort((a, b) => a - b)); // monotonic
  expect(bytes[bytes.length - 1]).toBeGreaterThan(0);
});

test('receiver progress emission is throttled by progressIntervalMs', async () => {
  const dest = tmp();
  const payload = Buffer.alloc(4000, 9);
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'big.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const events = [];
  const rx = createReceiver({
    channel: ch, destRoot: dest, store: memStore(), consent: async () => true,
    progressIntervalMs: 100_000, now: () => 0, // a clock that never advances past the interval
    onEvent: (ev) => events.push(ev),
  });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 'p2', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  for (let i = 0; i < 4; i += 1) await recvBulk(payload.subarray(i * 1000, (i + 1) * 1000));
  await recvCtrl(fileEndFrame({ jobId: 'p2', fileId: 0, hash }));
  await recvCtrl(jobDoneFrame({ jobId: 'p2' }));
  await done;
  // Every chunk pokes emitProgress; the throttle admits at most one. (Per-chunk
  // IPC on a 100GB send would be ~800k messages.)
  expect(events.filter((e) => e.type === 'progress').length).toBeLessThanOrEqual(1);
});

test('sender emits throttled progress events as chunks go out', async () => {
  const root = tmp();
  const f = join(root, 'a.bin');
  const data = Buffer.alloc(4000, 3);
  writeFileSync(f, data);
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: data.length, mtime: 5 }], totalBytes: data.length, totalFiles: 1 };
  const events = [];
  let clock = 0;
  const ch = fakeChannel();
  // Advance the clock past the throttle on every chunk handed to the channel.
  const origSendBulk = ch.sendBulk.bind(ch);
  ch.sendBulk = async (b) => { clock += 100; return origSendBulk(b); };
  const sender = createSender({
    channel: ch, jobId: 'sp1', manifest, sources: new Map([[0, f]]), chunkSize: 1000,
    progressIntervalMs: 100, now: () => clock, onEvent: (ev) => events.push(ev),
  });
  const finished = sender.start();
  await ch.feedCtrl(acceptFrame({ jobId: 'sp1', resume: [] }));
  await until(() => ch.ctrlOut.some((fr) => fr.t === 'job_done'));
  await ch.feedCtrl(completeFrame({ jobId: 'sp1', ok: true }));
  await finished;
  const prog = events.filter((e) => e.type === 'progress');
  expect(prog.length).toBeGreaterThan(1);
  expect(prog[prog.length - 1].progress.sent).toBeGreaterThan(0);
});

// SP3 P4: real receiver terminal events + tier-aware interrupted persistence.

test('receiver emits a real completed event when it acks delivery', async () => {
  const dest = tmp();
  const payload = Buffer.from('done-bytes'.repeat(20));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const events = [];
  const rx = createReceiver({ channel: ch, destRoot: dest, store: memStore(), consent: async () => true, onEvent: (ev) => events.push(ev) });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 'c1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await recvBulk(payload);
  await recvCtrl(fileEndFrame({ jobId: 'c1', fileId: 0, hash }));
  await recvCtrl(jobDoneFrame({ jobId: 'c1' }));
  await done;
  const completed = events.filter((e) => e.type === 'completed');
  expect(completed.length).toBe(1); // the UI no longer has to infer this from fraction >= 1
  expect(completed[0].ok).toBe(true);
  expect(completed[0].progress.fraction).toBe(1);
});

test('receiver persists the REAL tier, not a hardcoded adhoc', async () => {
  const dest = tmp();
  const payload = Buffer.from('tiered'.repeat(20));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const store = memStore();
  const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true, getTier: () => 'contact' });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 't1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await recvBulk(payload);
  await recvCtrl(fileEndFrame({ jobId: 't1', fileId: 0, hash }));
  await recvCtrl(jobDoneFrame({ jobId: 't1' }));
  await done;
  expect(store.saved.length).toBeGreaterThan(0);
  expect(store.saved.every((r) => r.tier === 'contact')).toBe(true);
});

test('a stalled fleet receive persists interrupted (resumable), not a permanent error', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 100, mtime: 1700000000000 }], totalBytes: 100, totalFiles: 1 };
  let recvCtrl = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const events = [];
  const store = memStore();
  // Capture the watchdog timer instead of waiting on a real one (the file's
  // established pattern — see the completionTimeoutMs test at :160-172).
  let fire = null;
  const setTimer = (fn) => { fire = fn; return { unref() {} }; };
  const rx = createReceiver({
    channel: ch, destRoot: dest, store, consent: async () => true,
    getTier: () => 'fleet', inactivityMs: 10, setTimer, clearTimer: () => {},
    onEvent: (ev) => events.push(ev),
  });
  const settled = rx.start().catch((e) => e.message);
  await recvCtrl(offerFrame({ jobId: 'i1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await until(() => typeof fire === 'function'); // watchdog armed at accept
  fire(); // the sender went silent
  expect(await settled).toBe('stalled');
  const interrupted = events.find((e) => e.type === 'interrupted');
  expect(interrupted.resumable).toBe(true); // the sender's resume watcher WILL re-establish this jobId
  expect(store.saved[store.saved.length - 1].jobState).toBe('interrupted');
});

test('a stalled adhoc receive stays a terminal error (nothing will resume it)', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 100, mtime: 1700000000000 }], totalBytes: 100, totalFiles: 1 };
  let recvCtrl = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const events = [];
  const store = memStore();
  let fire = null;
  const setTimer = (fn) => { fire = fn; return { unref() {} }; };
  const rx = createReceiver({
    channel: ch, destRoot: dest, store, consent: async () => true,
    getTier: () => 'adhoc', inactivityMs: 10, setTimer, clearTimer: () => {},
    onEvent: (ev) => events.push(ev),
  });
  const settled = rx.start().catch((e) => e.message);
  await recvCtrl(offerFrame({ jobId: 'i2', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await until(() => typeof fire === 'function');
  fire();
  expect(await settled).toBe('stalled');
  expect(events.find((e) => e.type === 'interrupted').resumable).toBe(false);
  expect(store.saved[store.saved.length - 1].jobState).toBe('error');
});

test('receiver abort sends a cancel frame the sender honors, and rejects', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 100, mtime: 1700000000000 }], totalBytes: 100, totalFiles: 1 };
  let recvCtrl = () => {};
  const sentToSender = [];
  const ch = { sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const events = [];
  const rx = createReceiver({ channel: ch, destRoot: dest, store: memStore(), consent: async () => true, onEvent: (ev) => events.push(ev) });
  const settled = rx.start().catch((e) => e.message);
  await recvCtrl(offerFrame({ jobId: 'x1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  rx.abort('canceled');
  expect(await settled).toBe('canceled');
  const cancel = sentToSender.find((f) => f.t === 'cancel');
  expect(cancel).toBeTruthy();
  expect(cancel.jobId).toBe('x1'); // the sender's inbound-cancel branch (:103) reads exactly this
  expect(events.find((e) => e.type === 'canceled')).toBeTruthy();
});

test('receiver abort before any offer is harmless', async () => {
  const dest = tmp();
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl() {}, onBulk() {} };
  const rx = createReceiver({ channel: ch, destRoot: dest, store: memStore(), consent: async () => true });
  const settled = rx.start().catch((e) => e.message);
  rx.abort('canceled'); // no jobId yet — must not throw, must still settle
  expect(await settled).toBe('canceled');
});

test('receiver abort after settling is a no-op', async () => {
  const dest = tmp();
  const payload = Buffer.from('short'.repeat(10));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const rx = createReceiver({ channel: ch, destRoot: dest, store: memStore(), consent: async () => true });
  const done = rx.start();
  await recvCtrl(offerFrame({ jobId: 'n1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await recvBulk(payload);
  await recvCtrl(fileEndFrame({ jobId: 'n1', fileId: 0, hash }));
  await recvCtrl(jobDoneFrame({ jobId: 'n1' }));
  expect((await done).ok).toBe(true);
  expect(() => rx.abort('canceled')).not.toThrow(); // already resolved — must not re-settle
});

// Review findings on Task 5 (61bbc55): the abort-vs-clobber bug this task fixed
// resurrected via the pre-accept path (beginReceive has no cancellation-awareness)
// and via a run()-queued handler that's already past its own entry guard (abort()
// runs outside the serializer). See docs/private .../task-5-report.md fix round 1.

test('review fix (finding 1): a cancel while the consent prompt is still pending never persists an active record, and never sends accept once the stale consent later resolves', async () => {
  const dest = tmp();
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: 10, mtime: 1 }], totalBytes: 10, totalFiles: 1 };
  let recvCtrl = () => {};
  const sentToSender = [];
  const ch = { sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk() {} };
  const events = [];
  const store = memStore();
  let releaseConsent;
  const rx = createReceiver({
    channel: ch, destRoot: dest, store, onEvent: (ev) => events.push(ev),
    // Never resolves on its own — models the human consent prompt sitting open
    // (per the finding, this can stay pending arbitrarily long).
    consent: () => new Promise((r) => { releaseConsent = r; }),
  });
  const settled = rx.start().catch((e) => e.message);
  // Don't await — the offer handler parks on the (never-resolving until we
  // release it) consent promise, so awaiting here would hang the test.
  recvCtrl(offerFrame({ jobId: 'cp1', entries: manifest.entries, totalBytes: 10, totalFiles: 1 }));
  await new Promise((r) => setTimeout(r, 20)); // let beginReceive reach (and park on) the consent await
  expect(typeof releaseConsent).toBe('function');

  // transfer-service's cancel() does exactly this while the offer is still
  // awaiting a human decision.
  rx.abort('canceled');
  expect(await settled).toBe('canceled');
  expect(events.some((e) => e.type === 'canceled')).toBe(true);

  // The stale prompt (or an own-fleet auto-accept race) later resolves true.
  // Before the fix, beginReceive would resume and unconditionally saveRecord
  // ('active') — the FIRST AND ONLY store write for this jobId — then send accept
  // on the already-torn-down channel.
  releaseConsent(true);
  await new Promise((r) => setTimeout(r, 20)); // let any (buggy) resumed work run to completion

  expect(store.saved.length).toBe(0); // no record was ever persisted for this jobId
  expect(sentToSender.some((f) => f.t === 'accept')).toBe(false); // no accept on a torn-down channel
});

// A jobs-store stand-in whose save() blocks on 'done' writes until released —
// used to land an abort() precisely WHILE a run()-queued handler's saveRecord
// call is already in flight (past its own `if (settled) return` entry guard),
// per finding 2. Other jobState writes (e.g. 'active') resolve immediately.
function gatedDoneStore() {
  const saved = [];
  let releaseDone;
  const doneGate = new Promise((r) => { releaseDone = r; });
  return {
    saved,
    async save(j) {
      if (j.jobState === 'done') await doneGate;
      saved.push(JSON.parse(JSON.stringify(j)));
    },
    async load() { return null; },
    async list() { return saved; },
    releaseDone: () => releaseDone(),
  };
}

test('review fix (finding 2): an abort racing an in-flight saveRecord(done) does not emit a stray completed event or send a complete frame after canceled', async () => {
  const dest = tmp();
  const payload = Buffer.from('race-payload'.repeat(20));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'a.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const sentToSender = [];
  const ch = { sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const events = [];
  const store = gatedDoneStore();
  const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true, onEvent: (ev) => events.push(ev) });
  const settled = rx.start().catch((e) => e.message);

  await recvCtrl(offerFrame({ jobId: 'race1', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  expect(sentToSender.some((f) => f.t === 'accept')).toBe(true); // consented + accepted -> 'active' saved (ungated)

  await recvBulk(payload);
  await recvCtrl(fileEndFrame({ jobId: 'race1', fileId: 0, hash })); // finalizes the only file -> pending empty

  // job_done -> maybeComplete() -> saveRecord('done'), now blocked on doneGate —
  // the exact "run()-queued handler already past its entry guard" window from
  // finding 2. Deliberately NOT awaited yet: we need to abort while it's parked.
  const jobDoneHandled = recvCtrl(jobDoneFrame({ jobId: 'race1' }));
  await new Promise((r) => setTimeout(r, 20)); // let it reach (and block on) the gated save

  rx.abort('canceled'); // races the in-flight saveRecord('done')
  store.releaseDone();  // let the gated save proceed now that we're settled
  await jobDoneHandled;

  expect(await settled).toBe('canceled'); // the abort — not the completion — is what won
  expect(events.some((e) => e.type === 'canceled')).toBe(true);
  expect(events.some((e) => e.type === 'completed')).toBe(false); // no stray completed after canceled
  expect(sentToSender.some((f) => f.t === 'complete')).toBe(false); // no delivery ack on a torn-down channel
});

// Re-review on aa35d46 (fix round 1): the same bug class — "cancel flips the
// receiver to settled, but queued work keeps running real side effects anyway" —
// survived on a THIRD, unguarded path: onBulk (byte writes) and tryFinalize
// (fsync/rename onto the real destination + file-done event) had no `settled`
// awareness at all. Unlike findings 1/2 above, this needs no race/gating —
// ordinary call ordering proves it: deliver bulk/file_end/job_done WITHOUT
// awaiting (each just enqueues onto the run() serializer as a microtask), then
// call abort() synchronously — outside the serializer — so it settles the
// receiver as 'canceled' before any of the three queued handlers even begin.
test('review fix round 2: onBulk/tryFinalize have no settled guard — bulk/file_end/job_done queued behind a synchronous abort() must not write the file to disk or emit events after canceled', async () => {
  const dest = tmp();
  const payload = Buffer.from('round2-payload'.repeat(30));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'r2.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const sentToSender = [];
  const ch = { sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const events = [];
  const store = memStore();
  const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true, onEvent: (ev) => events.push(ev) });
  const settled = rx.start().catch((e) => e.message);

  await recvCtrl(offerFrame({ jobId: 'r2', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  expect(sentToSender.some((f) => f.t === 'accept')).toBe(true); // accepted normally, watchdog armed

  // NOT awaited: each call only enqueues its handler onto the shared serializer
  // chain as a microtask — it does not run yet. abort() then runs synchronously,
  // settling the receiver BEFORE the JS engine drains the microtask queue, so all
  // three queued handlers see `settled === true` the moment they finally run.
  const p1 = recvBulk(payload);
  const p2 = recvCtrl(fileEndFrame({ jobId: 'r2', fileId: 0, hash }));
  const p3 = recvCtrl(jobDoneFrame({ jobId: 'r2' }));
  rx.abort('canceled');
  await Promise.all([p1, p2, p3]); // let the (now no-op) queued handlers actually run

  expect(await settled).toBe('canceled');
  // No real bytes ever landed anywhere on disk — onBulk must bail before even
  // opening/writing the .part file, and tryFinalize must bail before fsync/rename.
  expect(existsSync(join(dest, 'r2.bin'))).toBe(false);
  expect(existsSync(join(dest, 'r2.bin.part'))).toBe(false);

  const iCanceled = events.findIndex((e) => e.type === 'canceled');
  expect(iCanceled).toBeGreaterThanOrEqual(0);
  const after = events.slice(iCanceled + 1);
  expect(after.some((e) => e.type === 'file-done')).toBe(false);
  expect(after.some((e) => e.type === 'progress')).toBe(false);
  expect(after.some((e) => e.type === 'completed')).toBe(false);
  // Audit finding beyond the brief's required assertions: job_done's own
  // `onEvent({type:'verifying'})` (unrelated to tryFinalize) is reachable
  // whenever `pending` is non-empty — which it always is post-cancel, since a
  // guarded tryFinalize never reaches its own `pending.delete(...)`. Must not
  // leak either.
  expect(after.some((e) => e.type === 'verifying')).toBe(false);
});

// Re-review on aa35d46/2773717 (fix rounds 1-2): the same bug class survives a
// THIRD time — round 2 only guarded tryFinalize/onBulk/onCtrl at their own
// ENTRY, not after their own internal awaits. tryFinalize's
// `await item.partFile.fsync()`, `.close()`, and — critically —
// `await finalizeReceivedFile(...)` (the real rename onto the destination
// path) were unguarded: a cancel landing while PARKED INSIDE any of them still
// resumed straight into the unconditional `pending.delete(...)` +
// `onEvent('file-done')`.
//
// Round 2's own regression test (above) cannot catch this: it proves the bug
// via pure call-ORDERING (queue bulk/file_end/job_done, then abort()
// synchronously before any of them even start) — but that ordering trick
// aborts before onBulk/tryFinalize ever begin running, so it can never observe
// a cancel landing genuinely PARKED inside a real in-flight async op. This
// test uses the gate-mock technique instead: mock finalizeReceivedFile to
// pause on a controllable gate (calling through to the REAL implementation
// once released, so the real hash+rename actually happens), drive a real
// single-file receive until tryFinalize is genuinely parked awaiting it, abort
// while parked, THEN release the gate — reproducing the exact race the
// reviewer found.
test('review fix round 3: a cancel landing while genuinely parked inside finalizeReceivedFile must not leave the file at its final destination or emit events after canceled', async () => {
  const dest = tmp();
  const payload = Buffer.from('round3-payload'.repeat(30));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'r3.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const sentToSender = [];
  const ch = { sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); }, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const events = [];
  const store = memStore();

  // Gate the REAL finalizeReceivedFile: the mock calls straight through to the
  // actual implementation (real hash + real rename) once released, so this
  // proves the fix against the genuine disk operation, not a synthetic stand-in.
  let releaseGate, gateEntered = false;
  const gate = new Promise((r) => { releaseGate = r; });
  const realFinalize = transferIo.finalizeReceivedFile;
  const spy = vi.spyOn(transferIo, 'finalizeReceivedFile').mockImplementation(async (args) => {
    gateEntered = true;
    await gate;
    return realFinalize(args);
  });

  try {
    const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true, onEvent: (ev) => events.push(ev) });
    const settled = rx.start().catch((e) => e.message);

    await recvCtrl(offerFrame({ jobId: 'r3', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
    await recvBulk(payload); // bytes land; FILE_END hasn't arrived yet so tryFinalize just defers (hash == null)

    // NOT awaited: file_end's handler drives into tryFinalize -> the gated
    // finalizeReceivedFile and parks there until we release it.
    const fileEndHandled = recvCtrl(fileEndFrame({ jobId: 'r3', fileId: 0, hash }));
    await until(() => gateEntered); // genuinely parked INSIDE finalizeReceivedFile, not just queued behind it

    rx.abort('canceled'); // lands while the real hash+rename is in flight
    releaseGate(); // let it actually run now (real hash + real rename onto the final path)
    await fileEndHandled; // let tryFinalize's continuation (the fix) run to completion

    expect(await settled).toBe('canceled');

    const iCanceled = events.findIndex((e) => e.type === 'canceled');
    expect(iCanceled).toBeGreaterThanOrEqual(0);
    const after = events.slice(iCanceled + 1);
    // Round 4 (reverts round 3's compensating undo — see transfer-orchestrator.js
    // tryFinalize): a cancel landing while genuinely parked inside
    // finalizeReceivedFile must not fire any of these events afterward — that
    // part of the regression still holds. What round 3 additionally asserted
    // (no file at the final destination; the .part left in its place) has been
    // deliberately REMOVED: that behavior came from a rename-back that destroys
    // a pre-existing destination file with different content (see the tryFinalize
    // comment) — it was a data-loss bug, not a guarantee worth protecting. An
    // already-verified file landing at its real destination despite a raced
    // cancel is the correct, accepted outcome now.
    expect(after.some((e) => e.type === 'file-done')).toBe(false);
    expect(after.some((e) => e.type === 'progress')).toBe(false);
    expect(after.some((e) => e.type === 'completed')).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

// Round 4 (fd-leak fix): onBulk opens item.partFile via createPartFile; the only
// close() used to be inside tryFinalize, which never runs for a file that's still
// mid-flight (byte-incomplete) when the receive settles — so canceling mid-file
// leaked the open fd. Spy on createPartFile (module-mocked passthrough already set
// up at the top of this file) to wrap the REAL returned partFile's close() with a
// counter, so this proves the actual close() the orchestrator calls internally —
// not a synthetic stand-in — fires exactly once after abort.
test('review fix round 4: aborting mid-file closes the open .part file handle (no leak)', async () => {
  const dest = tmp();
  const payload = Buffer.from('mid-file-fd-leak-payload'.repeat(20));
  const half = payload.subarray(0, Math.floor(payload.length / 2));
  const manifest = { entries: [{ fileId: 0, path: 'leak.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const store = memStore();

  const realCreatePartFile = transferIo.createPartFile;
  let closeCalls = 0;
  const spy = vi.spyOn(transferIo, 'createPartFile').mockImplementation(async (args) => {
    const real = await realCreatePartFile(args);
    const origClose = real.close.bind(real);
    real.close = async () => { closeCalls += 1; return origClose(); };
    return real;
  });

  try {
    const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true });
    const settled = rx.start().catch((e) => e.message);

    await recvCtrl(offerFrame({ jobId: 'r4', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
    await recvBulk(half); // byte-incomplete: no FILE_END, tryFinalize never runs for this item

    rx.abort('canceled');
    expect(await settled).toBe('canceled');

    // The close is queued through the run() serializer (fire-and-forget), so poll
    // for it rather than asserting synchronously right after abort().
    await until(() => closeCalls > 0);
    expect(closeCalls).toBe(1); // not double-closed

    // Unchanged contract: the .part stays on disk (with exactly the bytes written
    // so far) for a later resume — only the fd is released, nothing is deleted.
    expect(existsSync(join(dest, 'leak.bin.part'))).toBe(true);
    expect(readFileSync(join(dest, 'leak.bin.part'))).toEqual(half);
    expect(existsSync(join(dest, 'leak.bin'))).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

// Companion to the above: a NORMAL (uncanceled) receive must still close exactly
// once via tryFinalize's own close — the fd-leak fix's closeOpenPartFiles() must
// not find anything left to close (item.finalizing is already true by then) and
// must not double-close an already-closed handle.
test('review fix round 4: a normal completed receive closes the .part handle exactly once', async () => {
  const dest = tmp();
  const payload = Buffer.from('normal-completion-payload'.repeat(20));
  const hash = createHash('sha256').update(payload).digest('hex');
  const manifest = { entries: [{ fileId: 0, path: 'ok.bin', size: payload.length, mtime: 1700000000000 }], totalBytes: payload.length, totalFiles: 1 };
  let recvCtrl = () => {}, recvBulk = () => {};
  const ch = { sendCtrl() {}, async sendBulk() {}, onCtrl(cb) { recvCtrl = cb; }, onBulk(cb) { recvBulk = cb; } };
  const store = memStore();

  const realCreatePartFile = transferIo.createPartFile;
  let closeCalls = 0;
  const spy = vi.spyOn(transferIo, 'createPartFile').mockImplementation(async (args) => {
    const real = await realCreatePartFile(args);
    const origClose = real.close.bind(real);
    real.close = async () => { closeCalls += 1; return origClose(); };
    return real;
  });

  try {
    const rx = createReceiver({ channel: ch, destRoot: dest, store, consent: async () => true });
    const settled = rx.start();

    await recvCtrl(offerFrame({ jobId: 'r4ok', entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
    await recvBulk(payload);
    await recvCtrl(fileEndFrame({ jobId: 'r4ok', fileId: 0, hash }));
    await recvCtrl(jobDoneFrame({ jobId: 'r4ok' }));
    await settled;

    expect(closeCalls).toBe(1); // fd-leak fix's closeOpenPartFiles() found nothing to do
    expect(existsSync(join(dest, 'ok.bin'))).toBe(true);
    expect(readFileSync(join(dest, 'ok.bin'))).toEqual(payload);
  } finally {
    spy.mockRestore();
  }
});
