// SP3 transfer-service: the MAIN-only pipeline that assembles the sender/
// receiver orchestrator, jobs-store, and serial send queue into an app-facing
// service. Exercised via loopback channels — no Electron, no real WebRTC.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransferService } from '../src/transfer-service.js';
import { createReceiver, createSender } from '@farsight/shared/transfer-orchestrator';
import { walkSource } from '@farsight/shared/transfer-io';
import { buildManifest as buildManifestReal } from '@farsight/shared/transfer-manifest';
import { createJobsStore } from '@farsight/shared/jobs-store';
import { newJobId } from '@farsight/shared/transfer-queue';
import { offerFrame, parseCtrlFrame } from '@farsight/shared/transfer-protocol';

const dirs = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'ftsvc-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

// Poll until a predicate holds (same helper as transfer-orchestrator.test.js:11-15).
async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 1)); }
}
// Same, but for an async predicate (e.g. awaiting a store.load()).
async function untilAsync(pred, ms = 2000) {
  const t0 = Date.now();
  while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('untilAsync: timed out'); await new Promise((r) => setTimeout(r, 1)); }
}

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

// A loopback that mimics a real WebRTC data channel's max message size: a ctrl
// frame larger than maxBytes is DROPPED (as the real send() throws + kills the
// channel), and the largest frame seen is recorded.
function sizedLoopback(maxBytes) {
  const A = makeSide(), B = makeSide(); A.peer = B; B.peer = A;
  const stats = { maxCtrl: 0, dropped: 0 };
  return { sideA: A, sideB: B, stats };
  function makeSide() {
    const side = {
      ctrlCb: null, bulkCb: null, peer: null,
      sendCtrl(s) {
        stats.maxCtrl = Math.max(stats.maxCtrl, s.length);
        if (s.length > maxBytes) { stats.dropped += 1; return; } // oversized → lost
        queueMicrotask(() => side.peer.ctrlCb && side.peer.ctrlCb(s));
      },
      sendBulk(b) { const buf = Buffer.from(b); return new Promise((r) => queueMicrotask(() => { side.peer.bulkCb && side.peer.bulkCb(buf); r(); })); },
      onCtrl(cb) { side.ctrlCb = cb; }, onBulk(cb) { side.bulkCb = cb; },
    };
    return side;
  }
}

test('SP3 bugfix: a large-manifest OFFER is chunked so it fits the data-channel message limit (a big folder no longer kills ft-ctrl)', async () => {
  // Repro of the field bug: a 2974-file folder packed the whole manifest into ONE
  // ft-ctrl OFFER (~300KB), overran the ~256KB channel limit, and the send killed
  // ft-ctrl before delivery → receiver never saw the OFFER → controller stuck.
  const srcDir = tmp();
  const N = 60;
  for (let i = 0; i < N; i++) {
    writeFileSync(join(srcDir, `file-with-a-moderately-long-name-${String(i).padStart(4, '0')}.dat`), Buffer.from('x'.repeat(24)));
  }
  const { entries, sources } = await walkSource([{ path: srcDir }]);
  const manifest = buildManifestReal(entries);
  const dest = tmp();
  const MAX = 4096; // pretend data-channel message limit (legacy single OFFER > this)
  const { sideA, sideB, stats } = sizedLoopback(MAX);
  const rx = createReceiver({ channel: sideB, destRoot: dest, store: memStore(), consent: async () => true, inactivityMs: 1500 });
  const sender = createSender({ channel: sideA, jobId: 'jbig', manifest, sources, chunkSize: 512, offerBatchBytes: 1024, completionTimeoutMs: 5000 });
  const rxP = rx.start();
  const sndP = sender.start();

  const rxRes = await rxP;              // legacy single OFFER would be dropped → this would stall
  await sndP;
  expect(rxRes.ok).toBe(true);
  expect(stats.dropped).toBe(0);        // no frame exceeded the channel limit
  expect(stats.maxCtrl).toBeLessThanOrEqual(MAX);
  for (const e of manifest.entries) expect(existsSync(join(dest, ...e.path.split('/')))).toBe(true);
});

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
    receiveCloseGraceMs: 0,
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

test('SP3 P4: an own-fleet (linked) send passes target.linked to openChannel and records tier:fleet', async () => {
  const { manifest, sources } = await oneFileSource();
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  const sendStore = createJobsStore({ dir: tmp() });
  const { sideA, sideB } = loopback();
  let sendOpenArgs = null;

  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest, consent: async () => true,
    openChannel: async () => ({ channel: sideB, close: async () => {} }),
    receiveCloseGraceMs: 0,
  });
  const senderSvc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true,
    openChannel: async (args) => { sendOpenArgs = args; return { channel: sideA, close: async () => {} }; },
  });

  const jobId = newJobId();
  const recvPromise = receiverSvc.startReceive({ rendezvous: 'rlink' });
  const sendResult = await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev-sig', deviceId: 'dev-abc', linked: true } });
  await recvPromise;

  expect(sendResult.ok).toBe(true);
  // openChannel receives the whole target (incl. linked) so main can pair
  // password-free and run the device-keypair handshake.
  expect(sendOpenArgs.target).toMatchObject({ id: 'dev-sig', linked: true });
  const sendRec = (await sendStore.list()).find((j) => j.jobId === jobId);
  expect(sendRec.tier).toBe('fleet');
});

test('a contact send records tier:contact and still passes linked:true to openChannel', async () => {
  const { manifest, sources } = await oneFileSource();
  const sendStore = memStore();
  let sendOpenArgs;
  const svc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true,
    openChannel: async (args) => { sendOpenArgs = args; return { channel: deadChannel(), close: async () => {} }; },
    getFleet: async () => [],
    rendezvousTimeoutMs: 60,
  });
  await svc.startSend({ jobId: 'jc', manifest, sources,
    target: { id: 'sig-1', deviceId: 'devC', linked: true, contact: true }, sourceRoots: [] })
    .catch(() => {}); // deadChannel → send fails; we only assert the recorded tier + openChannel args
  expect(sendOpenArgs.target).toMatchObject({ id: 'sig-1', linked: true, contact: true });
  const rec = sendStore.saved.find((s) => s.jobId === 'jc');
  expect(rec.tier).toBe('contact');
  expect(rec.peer).toEqual({ id: 'sig-1', deviceId: 'devC' });
});

test('SP3 P4: an own-fleet (linked) receive auto-accepts — no consent prompt (consent callback bypassed)', async () => {
  const srcDir = tmp();
  writeFileSync(join(srcDir, 'a.txt'), Buffer.from('own-fleet payload '.repeat(40)));
  const { entries, sources } = await walkSource([{ path: srcDir }]);
  const manifest = buildManifestReal(entries);
  const dest = tmp();
  const { sideA, sideB } = loopback();
  let consentCalled = false;

  const receiverSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: dest,
    // If fleet auto-accept works, this decliner must NEVER be consulted.
    consent: async () => { consentCalled = true; return false; },
    // SP3 Task 6: auto-accept is driven by peerAuth's resolved tier, not the
    // blanket `linked` flag — model the handshake having verified this peer
    // as an own-fleet device.
    openChannel: async () => ({ channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'fleet' }) }),
    receiveCloseGraceMs: 0,
  });
  const senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: sideA, close: async () => {} }),
  });

  const recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 'own', linked: true } });
  const sendResult = await senderSvc.startSend({ jobId: newJobId(), manifest, sources, target: { id: 'dev', linked: true } });
  const recvResult = await recvPromise;

  expect(sendResult.ok).toBe(true);
  expect(recvResult.ok).toBe(true);
  expect(consentCalled).toBe(false); // linked → no prompt
  for (const e of manifest.entries) {
    expect(readFileSync(join(dest, ...e.path.split('/')))).toEqual(readFileSync(sources.get(e.fileId)));
  }
});

test('SP3 P5 Task 6: consent branches on the verified peer tier — fleet auto-accepts, contact and ad-hoc prompt', async () => {
  // Task 6: openChannel's peerAuth resolves the device-keypair-verified peer's
  // tier ('fleet' | 'contact' | null). startReceive must consult it directly —
  // not the blanket `linked` flag — so a contact (or an unverified ad-hoc peer)
  // is always prompted, and only my own device is auto-accepted.
  async function runWithTier(tier) {
    const { manifest, sources } = await oneFileSource();
    const dest = tmp();
    const { sideA, sideB } = loopback();
    let consentCalled = false;

    const receiverSvc = createTransferService({
      store: createJobsStore({ dir: tmp() }), transferDir: dest,
      consent: async () => { consentCalled = true; return true; },
      openChannel: async () => ({ channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier }) }),
      receiveCloseGraceMs: 0,
    });
    const senderSvc = createTransferService({
      store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
      openChannel: async () => ({ channel: sideA, close: async () => {} }),
    });

    // linked:true for every case (a contact can still ride the own-fleet-only
    // linked rendezvous transport) — the OLD blanket `linked ? true : consent`
    // would wrongly auto-accept the contact/null cases too; only the peerAuth
    // tier must gate consent.
    const recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's', linked: true } });
    const sendResult = await senderSvc.startSend({ jobId: newJobId(), manifest, sources, target: { id: 'dev', linked: true } });
    const recvResult = await recvPromise;

    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    return consentCalled;
  }

  expect(await runWithTier('fleet')).toBe(false); // own-fleet → auto-accepted, no prompt
  expect(await runWithTier('contact')).toBe(true); // contact → prompted
  expect(await runWithTier(null)).toBe(true); // ad-hoc / unverified → prompted
});

test('SECURITY: REPLAY AFTER COMPLETION — a contact re-offering a FINISHED jobId must be re-prompted', async () => {
  // Was 'SP3: a contact resuming the SAME job is not re-prompted' and asserted
  // prompts stayed at 1 across this exact sequence — but that sequence (full
  // completion, THEN the same jobId re-offered with the same manifest) is
  // precisely the replay-after-completion hole: jobId is sender-chosen, so once
  // a job reaches 'done' there is nothing left to "resume" — a re-offer of it is
  // a NEW write request that happens to reuse an old id, and must go through a
  // real prompt like any other. The receiver's own persisted record now gates
  // this: a 'done' record no longer qualifies the memo, so the human is asked
  // again. (A real accepted-and-actually-unfinished resume is covered by the
  // "happy path" test below, using an 'active'/'interrupted' record instead.)
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      // Each receive gets a fresh channel pair, as a real re-establish does.
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'contact', publicKey: 'PK-DAD' }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const { manifest, sources } = await oneFileSource();

  // First run: prompts once, dad accepts, and the transfer runs to completion
  // (jobState 'done' persisted).
  let recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } });
  let senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true, contact: true } });
  await recvPromise;
  expect(prompts).toBe(1);
  expect((await recvStore.load(jobId)).jobState).toBe('done');

  // The SAME jobId + SAME manifest, re-offered after the job already finished
  // → MUST prompt again (pre-fix this stayed at 1; that was the vulnerability).
  recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } });
  senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true, contact: true } });
  await recvPromise;
  expect(prompts).toBe(2); // re-prompted — a finished job cannot ride the old consent
});

test('SECURITY: happy path — a contact resuming a genuinely UNFINISHED job with the SAME manifest is not re-prompted', async () => {
  // A real resume: the sender's OFFER lands, the human approves, the receiver
  // persists jobState:'active' (accept-time save, before any bytes flow), and
  // then the connection drops before job_done. A fresh re-offer of the SAME
  // jobId with the IDENTICAL manifest (an unchanged source re-walked) must NOT
  // re-prompt — this is the whole point of the SP3 consent-memo feature.
  // Frames are driven by hand (not a real createSender) so the first "peer" can
  // be stopped deliberately right after ACCEPT, before any file bytes/job_done —
  // producing a genuinely 'active' (not 'done') persisted record, which a full
  // real send would not let us observe from outside.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'contact', publicKey: 'PK-DAD' }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const { manifest } = await oneFileSource(); // 1 file, 64 bytes

  // First "connection": OFFER goes out, human approves — then silence (no
  // file bytes, no job_done). The accept-time saveRecord('active') has already
  // landed by the time we observe it in the store.
  receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } }).catch(() => {});
  await untilAsync(() => lastSenderSide != null);
  lastSenderSide.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.entries.length }));
  await untilAsync(async () => {
    const rec = await recvStore.load(jobId);
    return !!rec && rec.jobState === 'active';
  });
  expect(prompts).toBe(1);

  // A fresh channel (a real re-establish) re-offers the SAME jobId with the
  // IDENTICAL manifest → must NOT re-prompt.
  lastSenderSide = null;
  receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } }).catch(() => {});
  await untilAsync(() => lastSenderSide != null);
  let sawAccept = false;
  lastSenderSide.onCtrl((s) => { const f = parseCtrlFrame(s); if (f && f.t === 'accept') sawAccept = true; });
  lastSenderSide.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.entries.length }));
  await until(() => sawAccept); // proves the receive proceeded past consent without prompting
  expect(prompts).toBe(1); // still 1 — no second prompt for the same, unfinished, unchanged job
});

test('SECURITY (ESCALATION — reviewer demo): a contact re-offering the SAME jobId with a DIFFERENT manifest must prompt again, and the undeclared files are not silently written', async () => {
  // The finding: the memo bound (peer key, jobId) but not the manifest. Once a
  // human approved ONE small transfer for a contact, that contact (or anyone who
  // later controls that jobId on the wire) could re-offer the SAME jobId with a
  // COMPLETELY DIFFERENT, bigger manifest and have it silently accepted — an
  // unlimited unprompted write channel for the process's lifetime. This
  // reproduces that exact shape and proves the fix: the offered manifest must be
  // byte-identical to the one approved, or a real prompt fires.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    // The (simulated) human approves the innocent first request, but would
    // DECLINE the evil one if actually shown it — proving the prompt reached is
    // a REAL gate, not a rubber stamp: if the fix regressed to skipping the
    // prompt, this decline is never reached and the evil files land anyway.
    consent: async () => { prompts += 1; return prompts === 1; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'contact', publicKey: 'PK-DAD' }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const innocent = buildManifestReal([{ fileId: 0, path: 'innocent.txt', size: 16, mtime: Date.now() }]);

  // Innocent OFFER: human approves; connection then drops before completion
  // (same "active, unfinished" shape as the happy-path test above).
  receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } }).catch(() => {});
  await untilAsync(() => lastSenderSide != null);
  lastSenderSide.sendCtrl(offerFrame({ jobId, entries: innocent.entries, totalBytes: innocent.totalBytes, totalFiles: innocent.entries.length }));
  await untilAsync(async () => {
    const rec = await recvStore.load(jobId);
    return !!rec && rec.jobState === 'active';
  });
  expect(prompts).toBe(1);

  // The SAME jobId is re-offered, but with a BIGGER, DIFFERENT manifest (3 evil
  // files). Pre-fix: memo hit on (key, jobId) alone → auto-accepted, no prompt,
  // files written. Post-fix: manifest fingerprint mismatch → real prompt.
  lastSenderSide = null;
  receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } }).catch(() => {});
  await untilAsync(() => lastSenderSide != null);
  const evil = buildManifestReal([
    { fileId: 0, path: 'evil1.bin', size: 5000, mtime: Date.now() },
    { fileId: 1, path: 'evil2.bin', size: 5000, mtime: Date.now() },
    { fileId: 2, path: 'evil3.bin', size: 5000, mtime: Date.now() },
  ]);
  let sawReject = false;
  lastSenderSide.onCtrl((s) => { const f = parseCtrlFrame(s); if (f && f.t === 'reject') sawReject = true; });
  lastSenderSide.sendCtrl(offerFrame({ jobId, entries: evil.entries, totalBytes: evil.totalBytes, totalFiles: evil.entries.length }));
  // Try to sneak the evil bytes in immediately too (attacker doesn't wait for an
  // accept) — the receiver must never build a job/pending set for a declined
  // offer, so these bytes have nowhere to land regardless.
  for (const e of evil.entries) { await lastSenderSide.sendBulk(Buffer.alloc(e.size, 7)); }
  await until(() => sawReject);

  expect(prompts).toBe(2); // re-prompted — the different manifest was NOT silently accepted
  const written = evil.entries.map((e) => existsSync(join(dest, e.path)));
  expect(written).toEqual([false, false, false]); // evil files NOT silently written to disk
});

test('SECURITY: ACCEPT-THEN-CANCEL — a canceled job re-offered under the same jobId must be re-prompted', async () => {
  // The human accepted, then canceled before it finished. The persisted record
  // flips to 'canceled' — the same peer re-offering that jobId later must not
  // ride the old approval; a canceled job is not "unfinished", it's declined.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'contact', publicKey: 'PK-DAD' }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const { manifest } = await oneFileSource();

  receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } }).catch(() => {});
  await untilAsync(() => lastSenderSide != null);
  lastSenderSide.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.entries.length }));
  await untilAsync(async () => {
    const rec = await recvStore.load(jobId);
    return !!rec && rec.jobState === 'active';
  });
  expect(prompts).toBe(1);

  // The user cancels before it finishes.
  await receiverSvc.cancel(jobId);
  expect((await recvStore.load(jobId)).jobState).toBe('canceled');

  // Re-offered under the same jobId, identical manifest → MUST prompt again.
  lastSenderSide = null;
  receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } }).catch(() => {});
  await untilAsync(() => lastSenderSide != null);
  lastSenderSide.sendCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.entries.length }));
  await until(() => prompts === 2);
  expect(prompts).toBe(2);
});

test('SECURITY: a VERIFIED key whose classify returned tier:null is never remembered (coverage gap: existing ad-hoc test used no publicKey)', async () => {
  // Reachable in production: packages/host/src/main.js makes a SECOND,
  // independent classifyPublicKey call AFTER the device-keypair handshake
  // already passed — a transient auth-server error or token expiry can yield
  // { tier: null, publicKey: <a real verified key> }. The existing "ad-hoc
  // replay" guard only exercises { tier: null } with NO publicKey, so it never
  // pinned the `tier === 'contact'` half of the memo guard — mutating the guard
  // to `publicKey ? ... : null` (i.e. remembering ANY verified key regardless of
  // tier) still passes that test and the rest of the 339-test shared suite.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      // tier:null WITH a real verified key — the classify call itself failed
      // transiently, even though the handshake proved this key.
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: null, publicKey: 'PK-DAD' }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  let senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  const { manifest, sources } = await oneFileSource();

  let recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  expect(prompts).toBe(1);

  // Same jobId again, same peer key, tier still null → must prompt again: a
  // tier:null classification (even with a real key) is never memoized.
  recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } });
  senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  expect(prompts).toBe(2);
});

test('SECURITY: a DIFFERENT contact cannot reuse an accepted jobId to skip the prompt', async () => {
  // jobId is chosen by the SENDER. Binding the memory to the VERIFIED peer key is
  // what stops contact B replaying a jobId that contact A got approved.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  let peerAuthToUse = { tier: 'contact', publicKey: 'PK-DAD' };
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve(peerAuthToUse) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const { manifest, sources } = await oneFileSource();

  // First peer (contact A / "dad"): prompts once, accepts.
  let recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } });
  let senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true, contact: true } });
  await recvPromise;
  expect(prompts).toBe(1);

  // A DIFFERENT verified contact replays the SAME jobId — must still be prompted.
  peerAuthToUse = { tier: 'contact', publicKey: 'PK-SOMEONE-ELSE' };
  recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } });
  senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true, contact: true } });
  await recvPromise;
  expect(prompts).toBe(2); // the second peer IS prompted — jobId replay does not skip consent
});

test('SECURITY: an ad-hoc/unverified peer is always prompted, even for a repeated jobId', async () => {
  // peerAuth resolves { tier: null } (no verified identity to bind to) — the same
  // jobId twice must prompt twice.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: null }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const { manifest, sources } = await oneFileSource();

  let recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } });
  let senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  expect(prompts).toBe(1);

  // Same jobId again, still ad-hoc/unverified → must prompt again.
  recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } });
  senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  expect(prompts).toBe(2);
});

test('own-fleet still auto-accepts and never prompts', async () => {
  // peerAuth { tier:'fleet' } — regression guard: the new memory must not
  // disturb the fleet branch, which returns before it.
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let prompts = 0;
  let lastSenderSide = null;
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest,
    consent: async () => { prompts += 1; return true; },
    openChannel: async () => {
      const { sideA, sideB } = loopback();
      lastSenderSide = sideA;
      return { channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'fleet' }) };
    },
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const { manifest, sources } = await oneFileSource();

  let recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's1', linked: true } });
  let senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  expect(prompts).toBe(0);

  recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's2', linked: true } });
  senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: lastSenderSide, close: async () => {} }),
  });
  await senderSvc.startSend({ jobId, manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  expect(prompts).toBe(0);
});

test('review fix: a peerAuth that never resolves (classifyPublicKey stuck) times out and falls through to the consent prompt, never auto-accepts', async () => {
  // peerAuth only resolves after openChannel's main-process classifyPublicKey
  // network call. If that call hangs (auth server slow/down), awaiting it
  // directly would hang the receive forever. consentClassifyTimeoutMs bounds
  // it — the race must resolve to tier:null (prompt), not hang and not
  // auto-accept.
  const { manifest, sources } = await oneFileSource();
  const dest = tmp();
  const { sideA, sideB } = loopback();
  let consentCalled = false;

  const receiverSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: dest,
    consent: async () => { consentCalled = true; return true; },
    // Never resolves — models a stuck/offline classifyPublicKey call.
    openChannel: async () => ({ channel: sideB, close: async () => {}, peerAuth: new Promise(() => {}) }),
    receiveCloseGraceMs: 0,
    consentClassifyTimeoutMs: 20,
  });
  const senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: sideA, close: async () => {} }),
  });

  const recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's', linked: true } });
  const sendResult = await senderSvc.startSend({ jobId: newJobId(), manifest, sources, target: { id: 'dev', linked: true } });
  const recvResult = await recvPromise;

  expect(sendResult.ok).toBe(true);
  expect(recvResult.ok).toBe(true);
  expect(consentCalled).toBe(true); // timed out → fell through to prompt, did not hang, did not auto-accept
});

test('SP3 P4: startReceive threads the verified peer tier into the persisted receive record', async () => {
  // The receiver hardcoded tier:'adhoc', so a stalled own-fleet/contact receive
  // recorded a permanent 'error' even though the SENDER auto-resumes it.
  const { manifest, sources } = await oneFileSource();
  const dest = tmp();
  const { sideA, sideB } = loopback();
  const recvStore = createJobsStore({ dir: tmp() });
  const receiverSvc = createTransferService({
    store: recvStore, transferDir: dest, consent: async () => true,
    openChannel: async () => ({ channel: sideB, close: async () => {}, peerAuth: Promise.resolve({ tier: 'contact' }) }),
    receiveCloseGraceMs: 0,
  });
  const senderSvc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: sideA, close: async () => {} }),
  });
  const recvPromise = receiverSvc.startReceive({ rendezvous: { sessionId: 's', linked: true } });
  await senderSvc.startSend({ jobId: newJobId(), manifest, sources, target: { id: 'dev', linked: true } });
  await recvPromise;
  const records = await recvStore.list();
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((r) => r.tier === 'contact')).toBe(true); // was hardcoded 'adhoc'
});

test('SP3 P4: the resume watcher re-walks sourceRoots and re-sends an interrupted own-fleet job to completion', async () => {
  const srcDir = tmp();
  const srcFile = join(srcDir, 'resume-me.txt');
  writeFileSync(srcFile, Buffer.from('resume payload '.repeat(60)));
  const { entries, sources } = await walkSource([{ path: srcFile }]);
  const manifest = buildManifestReal(entries);
  const dest = tmp();
  const sendStore = createJobsStore({ dir: tmp() });
  const recvStore = createJobsStore({ dir: tmp() });

  let attempt = 0;
  let liveReceiver = null;
  const svc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true, rendezvousTimeoutMs: 60,
    // The fleet reports the device online at its CURRENT signalingId (not the stale one).
    getFleet: async () => [{ deviceId: 'dev-1', signalingId: 'sig-CURRENT', online: true }],
    openChannel: async () => {
      attempt += 1;
      if (attempt === 1) return { channel: deadChannel(), close: async () => {} }; // 1st: drop
      const { sideA, sideB } = loopback(); // 2nd: live channel + a receiver
      const rxSvc = createTransferService({ store: recvStore, transferDir: dest, consent: async () => true, openChannel: async () => ({ channel: sideB, close: async () => {} }), receiveCloseGraceMs: 0 });
      liveReceiver = rxSvc.startReceive({ rendezvous: { sessionId: 's', linked: true } });
      return { channel: sideA, close: async () => {} };
    },
  });
  svc.startResumeWatcher();

  await svc.startSend({ jobId: 'jr', manifest, sources, target: { id: 'sig-OLD', deviceId: 'dev-1', linked: true }, sourceRoots: [srcFile] });
  expect((await sendStore.list()).find((j) => j.jobId === 'jr').jobState).toBe('interrupted');

  await svc.resumeSweepNow();                       // re-walk + re-send; resolves after it settles
  await liveReceiver;

  const rec = (await sendStore.list()).find((j) => j.jobId === 'jr');
  expect(rec.jobState).toBe('done');                // re-established send completed
  expect(readFileSync(join(dest, 'resume-me.txt'))).toEqual(readFileSync(srcFile));
  svc.stopResumeWatcher();
});

test('SP3 P4: the resume watcher preserves contact:true when re-sending an interrupted CONTACT job', async () => {
  const srcDir = tmp();
  const srcFile = join(srcDir, 'resume-contact.txt');
  writeFileSync(srcFile, Buffer.from('contact resume payload '.repeat(20)));
  const sendStore = createJobsStore({ dir: tmp() });

  // Seed the store directly with an already-interrupted CONTACT send record
  // (as if a prior send dropped) rather than driving it through a real send.
  await sendStore.save({
    jobId: 'jc-resume',
    dir: 'send',
    tier: 'contact',
    peer: { id: 'sig-OLD', deviceId: 'devC' },
    sourceRoots: [srcFile],
    destRoot: null,
    manifest: { entries: [] },
    perFile: [],
    jobState: 'interrupted',
    createdAt: Date.now(),
  });

  let capturedTarget = null;
  const svc = createTransferService({
    store: sendStore, transferDir: tmp(), consent: async () => true, rendezvousTimeoutMs: 60,
    // The fleet reports the contact device online at its CURRENT signalingId.
    getFleet: async () => [{ deviceId: 'devC', signalingId: 'sig-NEW', online: true }],
    openChannel: async (args) => { capturedTarget = args.target; return { channel: deadChannel(), close: async () => {} }; },
  });
  svc.startResumeWatcher();

  await svc.resumeSweepNow();
  svc.stopResumeWatcher();

  expect(capturedTarget).toMatchObject({ id: 'sig-NEW', deviceId: 'devC', linked: true, contact: true });
});

test('SP3 P4: a recoverable own-fleet drop records interrupted; a terminal reason records error', async () => {
  const { manifest, sources } = await oneFileSource();
  const store = createJobsStore({ dir: tmp() });
  const svc = createTransferService({ store, transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: deadChannel(), close: async () => {} }), rendezvousTimeoutMs: 60 });
  const jobId = newJobId();
  const res = await svc.startSend({ jobId, manifest, sources, target: { id: 'sig', deviceId: 'dev', linked: true }, sourceRoots: ['/r'] });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/no_response/); // recoverable transport failure
  expect((await store.list()).find((j) => j.jobId === jobId).jobState).toBe('interrupted');

  // Ad-hoc (no deviceId, not linked) → the same recoverable failure stays terminal 'error'.
  const store2 = createJobsStore({ dir: tmp() });
  const svc2 = createTransferService({ store: store2, transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: deadChannel(), close: async () => {} }), rendezvousTimeoutMs: 60 });
  const jobId2 = newJobId();
  await svc2.startSend({ jobId: jobId2, manifest, sources, target: { id: 'sig', password: 'pw' } });
  expect((await store2.list()).find((j) => j.jobId === jobId2).jobState).toBe('error');
});

test('SP3 P4: a send record persists sourceRoots + peer.deviceId (for across-restart resume)', async () => {
  const { manifest, sources } = await oneFileSource();
  const store = createJobsStore({ dir: tmp() });
  const { sideA, sideB } = loopback();
  const rx = createTransferService({ store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true, openChannel: async () => ({ channel: sideB, close: async () => {} }), receiveCloseGraceMs: 0 });
  const tx = createTransferService({ store, transferDir: tmp(), consent: async () => true, openChannel: async () => ({ channel: sideA, close: async () => {} }) });
  const jobId = newJobId();
  const rp = rx.startReceive({ rendezvous: { sessionId: 's', linked: true } });
  await tx.startSend({ jobId, manifest, sources, target: { id: 'sig-1', deviceId: 'dev-1', linked: true }, sourceRoots: ['/src/root'] });
  await rp;
  const rec = (await store.list()).find((j) => j.jobId === jobId);
  expect(rec.peer).toEqual({ id: 'sig-1', deviceId: 'dev-1' });
  expect(rec.sourceRoots).toEqual(['/src/root']);
  expect(rec.tier).toBe('fleet');
});

test('SP3 P4: startReceive threads the own-fleet linked flag into openChannel', async () => {
  let recvOpenArgs = null;
  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async (args) => { recvOpenArgs = args; return { channel: deadChannel(), close: async () => {} }; },
    rendezvousTimeoutMs: 0,
  });
  // startReceive never resolves here (deadChannel), so don't await it; just let
  // openChannel run and capture its args.
  svc.startReceive({ rendezvous: { sessionId: 's-link', linked: true } });
  await new Promise((r) => setTimeout(r, 20));
  expect(recvOpenArgs).toMatchObject({ role: 'attach', sessionId: 's-link', linked: true });
});

test('SP3 bugfix: a file the receiver ALREADY HAS (skip-existing) completes instead of hanging, and leaves no .part', async () => {
  // Repro of the field bug: sending a file whose name already exists in the dest
  // (identical size+mtime) → the sender skips it entirely (no FILE_END), but the
  // receiver used to park it in `pending` awaiting a FILE_END that never comes →
  // stalled receive + orphaned .part + sender hung on the delivery ack.
  const srcDir = tmp();
  const srcFile = join(srcDir, 'note.txt');
  writeFileSync(srcFile, Buffer.from('identical content '.repeat(80)));
  const { entries, sources } = await walkSource([{ path: srcFile }]);
  const manifest = buildManifestReal(entries);
  const entry = manifest.entries[0];

  // Dest already holds an identical file with matching size+mtime → skip-existing.
  const dest = tmp();
  writeFileSync(join(dest, entry.path), readFileSync(srcFile));
  const secs = entry.mtime / 1000;
  utimesSync(join(dest, entry.path), secs, secs);

  const { sideA, sideB } = loopback();
  const rx = createReceiver({ channel: sideB, destRoot: dest, store: memStore(), consent: async () => true, inactivityMs: 800 });
  const sender = createSender({ channel: sideA, jobId: 'jdup', manifest, sources, chunkSize: 64, completionTimeoutMs: 3000 });
  const rxP = rx.start();
  const sndP = sender.start();

  const rxRes = await rxP;                 // must RESOLVE (not reject 'stalled')
  expect(rxRes).toEqual({ jobId: 'jdup', ok: true });
  await sndP;                              // sender resolves only on the complete ack
  expect(existsSync(join(dest, entry.path + '.part'))).toBe(false); // no orphan .part
  expect(readFileSync(join(dest, entry.path))).toEqual(readFileSync(srcFile));
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
    receiveCloseGraceMs: 0,
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

test('SP3 P4: cancel aborts a LIVE receive, not just the store record', async () => {
  // Before this, cancel(recvJobId) fell into the store-only branch: it flipped the
  // record to 'canceled', returned ok, and the receive kept running — then saved
  // 'done'/'error' right back over it. A hand-driven channel here: nothing ever
  // completes the transfer, so the ONLY way the receive settles is a real abort.
  const { manifest } = await oneFileSource();
  const dest = tmp();
  const recvStore = createJobsStore({ dir: tmp() });
  let recvCtrl = null;
  const sentToSender = [];
  const channel = {
    sendCtrl(s) { sentToSender.push(parseCtrlFrame(s)); },
    async sendBulk() {},
    onCtrl(cb) { recvCtrl = cb; }, onBulk() {},
  };
  const svc = createTransferService({
    store: recvStore, transferDir: dest, consent: async () => true,
    openChannel: async () => ({ channel, close: async () => {} }),
    receiveCloseGraceMs: 0,
  });
  const jobId = newJobId();
  const recvPromise = svc.startReceive({ rendezvous: { sessionId: 's' } }).catch((e) => e.message);
  await until(() => recvCtrl !== null); // the receiver has attached to the channel
  await recvCtrl(offerFrame({ jobId, entries: manifest.entries, totalBytes: manifest.totalBytes, totalFiles: manifest.totalFiles }));
  await until(() => sentToSender.some((f) => f.t === 'accept')); // consented + accepted → live

  expect(await svc.cancel(jobId)).toEqual({ ok: true });
  expect(await recvPromise).toBe('canceled'); // the receive REALLY stopped
  expect(sentToSender.some((f) => f.t === 'cancel')).toBe(true); // and the sender was told
  const rec = (await recvStore.list()).find((r) => r.jobId === jobId);
  expect(rec.jobState).toBe('canceled');
});

test('SP3 P4: cancel on an unknown jobId still falls back to the store-only branch', async () => {
  const svc = createTransferService({
    store: createJobsStore({ dir: tmp() }), transferDir: tmp(), consent: async () => true,
    openChannel: async () => ({ channel: loopback().sideA, close: async () => {} }),
  });
  expect(await svc.cancel('never-existed')).toEqual({ ok: false });
});
