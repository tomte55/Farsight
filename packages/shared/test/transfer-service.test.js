// SP3 transfer-service: the MAIN-only pipeline that assembles the sender/
// receiver orchestrator, jobs-store, and serial send queue into an app-facing
// service. Exercised via loopback channels — no Electron, no real WebRTC.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransferService } from '../src/transfer-service.js';
import { createReceiver } from '@farsight/shared/transfer-orchestrator';
import { walkSource } from '@farsight/shared/transfer-io';
import { buildManifest as buildManifestReal } from '@farsight/shared/transfer-manifest';
import { createJobsStore } from '@farsight/shared/jobs-store';
import { newJobId } from '@farsight/shared/transfer-queue';

const dirs = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'ftsvc-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

// Same cross-wired fake channel pattern as transfer-orchestrator.test.js's
// loopback(), generalized to produce fresh named sides on each call so a test
// can mint an independent pair per job.
function loopback() {
  const A = makeSide(), B = makeSide();
  A.peer = B; B.peer = A;
  return { sideA: A, sideB: B };
  function makeSide() {
    const side = {
      ctrlCb: null, bulkCb: null, peer: null,
      sendCtrl(s) { queueMicrotask(() => side.peer.ctrlCb && side.peer.ctrlCb(s)); },
      sendBulk(b) { const buf = Buffer.from(b); return new Promise((r) => queueMicrotask(() => { side.peer.bulkCb && side.peer.bulkCb(buf); r(); })); },
      onCtrl(cb) { side.ctrlCb = cb; }, onBulk(cb) { side.bulkCb = cb; },
    };
    return side;
  }
}

const memStore = () => ({ saved: [], async save(j) { this.saved.push(JSON.parse(JSON.stringify(j))); }, async load() { return null; }, async list() { return this.saved; } });

test('loopback send -> receive through the service layer lands files byte-identical and records done', async () => {
  const srcRoot = tmp();
  const src = join(srcRoot, 'payload');
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'a.txt'), Buffer.from('alpha-payload-'.repeat(500)));
  writeFileSync(join(src, 'sub', 'b.bin'), Buffer.alloc(4096, 3));

  const { entries, sources } = await walkSource([{ path: src }]);
  const manifest = buildManifestReal(entries);

  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  const sendStore = createJobsStore({ dir: tmp() });
  const { sideA, sideB } = loopback();

  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest, consent: async () => true,
    openChannel: async () => ({ channel: sideB, close: async () => {} }),
  });
  const senderSvc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: sideA, close: async () => {} }),
  });

  const jobId = newJobId();
  const recvPromise = receiverSvc.startReceive({ rendezvous: 'r1' });
  const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'device-t1', password: 'pw' } });
  const recvResult = await recvPromise;

  expect(sendResult.ok).toBe(true);
  expect(recvResult.ok).toBe(true);
  for (const e of manifest.entries) {
    const got = readFileSync(join(dest, ...e.path.split('/')));
    const want = readFileSync(sources.get(e.fileId));
    expect(got).toEqual(want);
  }

  const recvJobs = await recvStore.list();
  expect(recvJobs.some((j) => j.jobState === 'done')).toBe(true);
  // SP3 coherence contract #4: the send record threads the real peer id;
  // the receive record stays {} (no initiator id is relayed to the receiver
  // in this phase — see TRANSFER_REQUEST in the signaling server).
  expect(recvJobs.find((j) => j.jobState === 'done').peer).toEqual({});
  const sendJobs = await sendStore.list();
  const sendRec = sendJobs.find((j) => j.jobId === jobId && j.jobState === 'done');
  expect(sendRec).toBeTruthy();
  expect(sendRec.peer).toEqual({ id: 'device-t1' });
});

// A channel that never feeds anything back — models a peer that never attaches/
// accepts (offline host, dropped rendezvous).
function deadChannel() {
  return { sendCtrl() {}, async sendBulk() {}, onCtrl() {}, onBulk() {} };
}
async function oneFileSource() {
  const src = join(tmp(), 'payload');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.txt'), Buffer.from('x'.repeat(64)));
  const { entries, sources } = await walkSource([{ path: src }]);
  return { manifest: buildManifestReal(entries), sources };
}

test('a send that is never accepted fails after the rendezvous timeout and surfaces an error event (no infinite "waiting for approval")', async () => {
  const { manifest, sources } = await oneFileSource();
  const events = [];
  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: deadChannel(), close: async () => {} }),
    onEvent: (ev) => events.push(ev),
    rendezvousTimeoutMs: 80,
  });
  const res = await svc.startSend({ jobId: 'jt', manifest, sources, target: { id: 'off' } });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/no_response/);
  expect(events.some((e) => e.type === 'error' && e.reason === 'no_response')).toBe(true);
});

test('a rendezvous error from the channel (e.g. bad_password) fails the send with that reason and an error event, without waiting for the timeout', async () => {
  const { manifest, sources } = await oneFileSource();
  const events = [];
  let fireError = null;
  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({
      channel: deadChannel(), close: async () => {},
      onRendezvousError: (cb) => { fireError = cb; },
    }),
    onEvent: (ev) => events.push(ev),
    rendezvousTimeoutMs: 60000, // long — the error path must fire well before this
  });
  const p = svc.startSend({ jobId: 'jb', manifest, sources, target: { id: 'x', password: 'wrong' } });
  await new Promise((r) => setTimeout(r, 20)); // let openChannel register the callback
  expect(typeof fireError).toBe('function');
  fireError('bad_password'); // signaling rejected the password
  const res = await p;
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/bad_password/);
  expect(events.some((e) => e.type === 'error' && e.reason === 'bad_password')).toBe(true);
});

test('a prompting frame cancels the approval timeout — a slow human decision is not "no_response"', async () => {
  const { manifest, sources } = await oneFileSource();
  const events = [];
  let ctrlCb = null;
  // Channel that answers the OFFER with a prompting frame (host is showing the
  // consent prompt) but never accepts — models a human taking their time.
  const channel = {
    sendCtrl(s) {
      const f = JSON.parse(s);
      if (f.t === 'offer') queueMicrotask(() => ctrlCb && ctrlCb(JSON.stringify({ t: 'prompting', jobId: f.jobId })));
    },
    async sendBulk() {},
    onCtrl(cb) { ctrlCb = cb; }, onBulk() {},
  };
  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel, close: async () => {} }),
    onEvent: (ev) => events.push(ev), rendezvousTimeoutMs: 50,
  });
  let settled = null;
  svc.startSend({ jobId: 'jp', manifest, sources, target: { id: 'x' } }).then((r) => { settled = r; });
  await new Promise((r) => setTimeout(r, 160)); // well past the 50ms approval timeout
  expect(events.some((e) => e.type === 'prompting')).toBe(true);
  expect(events.some((e) => e.type === 'error' && e.reason === 'no_response')).toBe(false);
  expect(settled).toBe(null); // still awaiting the (never-coming) accept — NOT failed
  await svc.cancel('jp'); // clean up the in-flight send
});

test('serial queue: two enqueued sends never have more than one active channel at once, both complete', async () => {
  let openCount = 0;
  let activeCount = 0;
  let maxActive = 0;
  const dests = {};
  const rxDone = [];

  async function openChannel({ target }) {
    openCount++;
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    const { sideA, sideB } = loopback();
    const dest = tmp();
    dests[target] = dest;
    const rx = createReceiver({ channel: sideB, destRoot: dest, store: memStore(), consent: async () => true });
    rxDone.push(rx.start()); // driven independently of the service under test; awaited below
    return { channel: sideA, close: async () => { activeCount--; } };
  }

  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true, openChannel,
  });

  const src1 = tmp();
  writeFileSync(join(src1, 'x.bin'), Buffer.alloc(2000, 1));
  const w1 = await walkSource([{ path: join(src1, 'x.bin') }]);
  const m1 = buildManifestReal(w1.entries);

  const src2 = tmp();
  writeFileSync(join(src2, 'y.bin'), Buffer.alloc(2000, 2));
  const w2 = await walkSource([{ path: join(src2, 'y.bin') }]);
  const m2 = buildManifestReal(w2.entries);

  const p1 = svc.startSend({ jobId: 'jobA', manifest: m1, sources: w1.sources, target: 't1' });
  const p2 = svc.startSend({ jobId: 'jobB', manifest: m2, sources: w2.sources, target: 't2' });

  const [r1, r2] = await Promise.all([p1, p2]);
  await Promise.all(rxDone); // don't assert on-disk state until the receivers actually finalize

  expect(r1.ok).toBe(true);
  expect(r2.ok).toBe(true);
  expect(openCount).toBe(2);
  expect(maxActive).toBe(1); // never overlapped: the queue serialized the sends
  expect(readFileSync(join(dests.t1, 'x.bin'))).toEqual(readFileSync(w1.sources.get(0)));
  expect(readFileSync(join(dests.t2, 'y.bin'))).toEqual(readFileSync(w2.sources.get(0)));
});

// SP3 coherence contract #3: cancel(jobId) on the ACTIVE job tears the channel
// down (calls the openChannel-returned close()) and marks the persisted record
// 'canceled' deterministically — not left to whatever the underlying sender
// promise eventually does.
test('cancel() on the active send closes its channel and marks the record canceled', async () => {
  const src = tmp();
  writeFileSync(join(src, 'x.bin'), Buffer.alloc(5000, 1));
  const { entries, sources } = await walkSource([{ path: join(src, 'x.bin') }]);
  const manifest = buildManifestReal(entries);
  const sendStore = createJobsStore({ dir: tmp() });

  let closed = false;
  const svc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({
      // A channel nobody drives further (no receiver ACKs the OFFER) — the
      // send is genuinely stuck "active" until canceled.
      channel: { sendCtrl() {}, async sendBulk() {}, onCtrl() {}, onBulk() {} },
      close: async () => { closed = true; },
    }),
  });

  const jobId = newJobId();
  const p = svc.startSend({ jobId, manifest, sources, target: { id: 'device-9' } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); // let runSend open the channel and go active

  const c = await svc.cancel(jobId);
  expect(c.ok).toBe(true);
  expect(closed).toBe(true);

  const result = await p;
  expect(result.ok).toBe(false);
  expect(result.canceled).toBe(true);

  const jobs = await sendStore.list();
  const rec = jobs.find((j) => j.jobId === jobId);
  expect(rec.jobState).toBe('canceled');
  expect(rec.peer).toEqual({ id: 'device-9' });
});

test('cancel() on a waiting (not-yet-active) send removes it from the queue without opening a channel', async () => {
  const src1 = tmp();
  writeFileSync(join(src1, 'a.bin'), Buffer.alloc(4000, 1));
  const w1 = await walkSource([{ path: join(src1, 'a.bin') }]);
  const m1 = buildManifestReal(w1.entries);

  const src2 = tmp();
  writeFileSync(join(src2, 'b.bin'), Buffer.alloc(10, 2));
  const w2 = await walkSource([{ path: join(src2, 'b.bin') }]);
  const m2 = buildManifestReal(w2.entries);

  const sendStore = createJobsStore({ dir: tmp() });
  let opens = [];
  const svc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true,
    openChannel: async ({ target }) => {
      opens.push(target);
      // Job A's channel never progresses (no receiver), so job B stays queued
      // behind it until we cancel B directly out of the queue.
      return { channel: { sendCtrl() {}, async sendBulk() {}, onCtrl() {}, onBulk() {} }, close: async () => {} };
    },
  });

  const pA = svc.startSend({ jobId: 'jobA', manifest: m1, sources: w1.sources, target: { id: 'devA' } });
  const pB = svc.startSend({ jobId: 'jobB', manifest: m2, sources: w2.sources, target: { id: 'devB' } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  expect(opens.map((t) => t.id)).toEqual(['devA']); // sanity: only jobA's channel opened so far

  const c = await svc.cancel('jobB');
  expect(c.ok).toBe(true);
  const resultB = await pB;
  expect(resultB.ok).toBe(false);
  expect(resultB.canceled).toBe(true);

  const jobs = await sendStore.list();
  const recB = jobs.find((j) => j.jobId === 'jobB');
  expect(recB.jobState).toBe('canceled');
  expect(recB.peer).toEqual({ id: 'devB' });
  expect(opens.length).toBe(1); // jobB's channel was never opened

  await svc.cancel('jobA'); // cleanup so the test doesn't leave a dangling promise
  await pA.catch(() => {});
});

test('cancel() on an unknown jobId with no persisted record returns ok:false', async () => {
  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => { throw new Error('not used in this test'); },
  });
  const c = await svc.cancel('no-such-job');
  expect(c.ok).toBe(false);
});

test('receiver declining consent resolves ok:false with no file written, and settles the sender without hanging', async () => {
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  const sendStore = createJobsStore({ dir: tmp() });
  const { sideA, sideB } = loopback();

  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest, consent: async () => false,
    openChannel: async () => ({ channel: sideB, close: async () => {} }),
  });
  const senderSvc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: sideA, close: async () => {} }),
  });

  const srcRoot = tmp();
  writeFileSync(join(srcRoot, 'refused.bin'), Buffer.alloc(500, 9));
  const { entries, sources } = await walkSource([{ path: join(srcRoot, 'refused.bin') }]);
  const manifest = buildManifestReal(entries);

  const recvPromise = receiverSvc.startReceive({ rendezvous: 'r3' });
  const sendResult = await senderSvc.startSend({ jobId: newJobId(), manifest, sources, target: 't3' });
  const recvResult = await recvPromise;

  expect(recvResult.ok).toBe(false);
  expect(existsSync(join(dest, 'refused.bin'))).toBe(false);
  expect(sendResult.ok).toBe(false);
});

test('resumable() returns only jobs whose persisted state is active/paused/interrupted', async () => {
  const store = createJobsStore({ dir: tmp() });
  const blankManifest = { entries: [], totalBytes: 0, totalFiles: 0 };
  await store.save({ jobId: 'j-active', dir: 'send', manifest: blankManifest, perFile: [], jobState: 'active', createdAt: 1 });
  await store.save({ jobId: 'j-paused', dir: 'send', manifest: blankManifest, perFile: [], jobState: 'paused', createdAt: 2 });
  await store.save({ jobId: 'j-interrupted', dir: 'recv', manifest: blankManifest, perFile: [], jobState: 'interrupted', createdAt: 3 });
  await store.save({ jobId: 'j-done', dir: 'send', manifest: blankManifest, perFile: [], jobState: 'done', createdAt: 4 });
  await store.save({ jobId: 'j-error', dir: 'send', manifest: blankManifest, perFile: [], jobState: 'error', createdAt: 5 });

  const svc = createTransferService({
    store, transferDir: tmp(), consent: async () => true,
    openChannel: async () => { throw new Error('not used in this test'); },
  });

  const all = await svc.listJobs();
  expect(all.length).toBe(5);

  const resumable = await svc.resumable();
  expect(resumable.map((j) => j.jobId).sort()).toEqual(['j-active', 'j-interrupted', 'j-paused']);
});
