// packages/shared/test/transfer-multiflow-sender.test.js
import { describe, it, expect } from 'vitest';
import { createMultiFlowSender, createMultiFlowReceiver } from '../src/transfer-orchestrator.js';
import { decodeBulkFrame } from '../src/transfer-chunk.js';
import { parseCtrlFrame, acceptFrame, rangeReportFrame, completeFrame } from '../src/transfer-protocol.js';

const JOB = 'a'.repeat(32);

// A fake receiver wired to the sender's ctrl+flows: writes delivered bytes into a
// dest map keyed by fileId, tracks per-file received ranges, and drives the ctrl
// protocol (accept → periodic range_report → complete).
function wire({ manifest, sources, flowCount = 3, dropFileOffsets = new Set() }) {
  const dest = new Map(manifest.entries.map((e) => [e.fileId, new Uint8Array(e.size)]));
  const recv = new Map(manifest.entries.map((e) => [e.fileId, []])); // fileId -> [[s,e]]
  let ctrlOnMsg = null;
  let reportTimer = null;
  const ctrl = {
    sendCtrl: (s) => { const f = parseCtrlFrame(s); handleCtrl(f); },
    // The real receiver (connections-design spec: "the receiver periodically
    // reports its current received-ranges over the primary ctrl channel") reports
    // on its OWN cadence, independent of any sender ctrl frame — a chunk that
    // lands on a reconcile pass AFTER the one report triggered by file_end must
    // still surface without a second file_end/job_done (there isn't one: file_end
    // fires exactly once per file, and job_done only once the sender already
    // believes it's complete). Simulate that here instead of only reacting to
    // file_end/job_done, or a dropped-then-recovered chunk can never be reported.
    onCtrl: (cb) => {
      ctrlOnMsg = cb;
      if (!reportTimer) {
        reportTimer = setInterval(() => { if (ctrlOnMsg) rig.report(); }, 20);
        if (reportTimer.unref) reportTimer.unref();
      }
    },
  };
  const flows = Array.from({ length: flowCount }, () => ({
    isAlive: () => true,
    sendBulk: (buf) => {
      const d = decodeBulkFrame(buf);
      const key = `${d.fileId}:${d.offset}`;
      if (!dropFileOffsets.has(key)) {
        dest.get(d.fileId).set(d.payload, d.offset);
        recv.get(d.fileId).push([d.offset, d.offset + d.length]);
      }
      return Promise.resolve();
    },
  }));
  function coveredIvals(fileId) { // coalesce recv[fileId]
    const arr = [...recv.get(fileId)].sort((a, b) => a[0] - b[0]); const out = [];
    for (const [s, e] of arr) { const last = out[out.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]); }
    return out;
  }
  function isComplete() { return manifest.entries.every((e) => { const iv = coveredIvals(e.fileId); return iv.length === 1 && iv[0][0] === 0 && iv[0][1] >= e.size; }); }
  // NOTE: handleCtrl calls through `rig.report`/`rig.complete` (not a captured
  // local function reference) so that a test overriding `rig.report = ...` (to
  // un-drop a chunk after the first report, see the reconcile test below) is
  // actually honored on the next call — a direct closure reference would only
  // ever invoke the ORIGINAL function, silently ignoring the override.
  function handleCtrl(f) {
    if (!f) return;
    if (f.t === 'offer' || f.t === 'offer_end') { ctrlOnMsg && ctrlOnMsg(acceptFrame({ jobId: JOB, resume: [], ranges: [] })); }
    else if (f.t === 'file_end') { /* hash recorded implicitly by dest bytes */ setTimeout(() => rig.report(), 0); }
    else if (f.t === 'job_done') { if (isComplete()) { clearInterval(reportTimer); rig.complete(); } else setTimeout(() => rig.report(), 0); }
  }
  const rig = {
    ctrl, flows, dest, isComplete,
    report: () => ctrlOnMsg(rangeReportFrame({ jobId: JOB, files: manifest.entries.map((e) => ({ fileId: e.fileId, ivals: coveredIvals(e.fileId) })) })),
    complete: () => ctrlOnMsg(completeFrame({ jobId: JOB, ok: true })),
  };
  return rig;
}

const readerFor = (sources) => (fileId) => ({ readAt: (o, l) => Promise.resolve(sources.get(fileId).subarray(o, o + l)), close: () => {} });
const fakeHash = () => ({ update() {}, digest: () => 'H' });

describe('createMultiFlowSender', () => {
  // Plan 3 Task 6: a `limiter` passed to createMultiFlowSender is threaded into
  // the (single, per-transfer) send pool -- transfer-send-pool.js's ONE choke
  // point where every flow's sendBulk() is dispatched -- so take() is called
  // for every chunk regardless of which of the N flows it lands on, proving
  // ONE shared limiter instance paces the whole multi-flow transfer's
  // aggregate output (not a per-flow gate).
  it('threads a shared limiter into the send pool: take() called for chunks dispatched across every flow', async () => {
    const A = new Uint8Array(4096 * 3 + 7).map((_, i) => (i * 7) & 0xff);
    const B = new Uint8Array(500).map((_, i) => (i * 13) & 0xff);
    const sources = new Map([[0, A], [1, B]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }, { fileId: 1, size: B.length }] };
    const rig = wire({ manifest, sources });
    const takenCalls = [];
    const limiter = { take: (n) => { takenCalls.push(n); return Promise.resolve(); } };
    const sender = createMultiFlowSender({
      ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 3,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash, limiter,
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(Buffer.from(rig.dest.get(0)).equals(Buffer.from(A))).toBe(true);
    expect(Buffer.from(rig.dest.get(1)).equals(Buffer.from(B))).toBe(true);
    // Every chunk that went out over any flow was paced through the ONE limiter,
    // on its encoded frame's byte length (16-byte header + payload).
    expect(takenCalls.length).toBeGreaterThan(0);
    expect(takenCalls.reduce((a, b) => a + b, 0)).toBe(16 * takenCalls.length + A.length + B.length);
  });

  it('stripes a multi-file payload across flows; receiver ends byte-identical', async () => {
    const A = new Uint8Array(4096 * 3 + 7).map((_, i) => (i * 7) & 0xff);
    const B = new Uint8Array(500).map((_, i) => (i * 13) & 0xff);
    const sources = new Map([[0, A], [1, B]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }, { fileId: 1, size: B.length }] };
    const rig = wire({ manifest, sources });
    const sender = createMultiFlowSender({ ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 3, groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(Buffer.from(rig.dest.get(0)).equals(Buffer.from(A))).toBe(true);
    expect(Buffer.from(rig.dest.get(1)).equals(Buffer.from(B))).toBe(true);
  });

  // UI-event-wiring gap: the sender drove real bytes onto the wire but never
  // told the app UI — no 'progress', no 'file-sent' — so the sender's progress
  // bar never moved even though the receiver was confirming coverage the whole
  // time. Computed from the tracker (the sender's authoritative record of what
  // the RECEIVER has confirmed), so it only reflects real, confirmed delivery.
  it('applying a range_report emits progress with the aggregate shape {sent,total,fraction,filesSent,filesTotal,flowsLive,flowsTotal,redials}', async () => {
    const A = new Uint8Array(4096 * 2).map((_, i) => (i * 3) & 0xff);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }] };
    const rig = wire({ manifest, sources, flowCount: 1 });
    const events = [];
    const sender = createMultiFlowSender({
      ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash,
      onEvent: (ev) => events.push(ev),
      // Unthrottled here — this test is about the SHAPE + eventual full-coverage
      // value, not the throttle itself (see the dedicated throttle test below).
      progressIntervalMs: 0,
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);
    for (const e of progressEvents) {
      expect(Object.keys(e.progress).sort()).toEqual(['filesSent', 'filesTotal', 'flowsLive', 'flowsTotal', 'fraction', 'redials', 'sent', 'total'].sort());
    }
    const last = progressEvents[progressEvents.length - 1];
    expect(last.progress).toEqual({
      sent: A.length, total: A.length, fraction: 1, filesSent: 1, filesTotal: 1,
      flowsLive: 1, flowsTotal: 1, redials: 0,
    });
  });

  // Task 9: per-flow HEALTH in the aggregate progress event — flowsLive (from
  // the send pool's LIVE aliveCount(), not hardcoded to flowsTotal — one flow
  // here is dead throughout, so flowsLive must read 2, never 3), flowsTotal
  // (the target flowCount), and redials (the supervisor's cumulative counter,
  // threaded via the injected redialCount callback).
  it('progress carries flowsLive (real alive count, not flowsTotal), flowsTotal, and redials', async () => {
    const A = new Uint8Array(4096 * 2).map((_, i) => (i * 3) & 0xff);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }] };
    const rig = wire({ manifest, sources, flowCount: 3 });
    // Make one of the 3 flows permanently dead (isAlive:false) so aliveCount()
    // (2) provably differs from flowCount (3) — hardcoding flowsLive to
    // flowsTotal would pass a naive test but must fail THIS one.
    rig.flows[2].isAlive = () => false;
    const events = [];
    const sender = createMultiFlowSender({
      ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 3,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash,
      onEvent: (ev) => events.push(ev),
      redialCount: () => 5,
      progressIntervalMs: 0,
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);
    for (const e of progressEvents) {
      expect(e.progress.flowsLive).toBe(2);   // real usable-flow count, not 3
      expect(e.progress.flowsTotal).toBe(3);  // the target flowCount
      expect(e.progress.redials).toBe(5);     // threaded from the supervisor
    }
  });

  // Without a redialCount callback (single-flow-shaped caller, or a fixture
  // with no supervisor behind it) redials must default to 0, not throw/undefined.
  it('progress defaults redials to 0 when no redialCount is supplied', async () => {
    const A = new Uint8Array(64).map((_, i) => i);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }] };
    const rig = wire({ manifest, sources, flowCount: 1 });
    const events = [];
    const sender = createMultiFlowSender({
      ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 64, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash,
      onEvent: (ev) => events.push(ev),
      progressIntervalMs: 0,
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);
    for (const e of progressEvents) expect(e.progress.redials).toBe(0);
  });

  it('throttles progress emission via progressIntervalMs', async () => {
    const A = new Uint8Array(4096 * 2).map((_, i) => (i * 3) & 0xff);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }] };
    const rig = wire({ manifest, sources, flowCount: 1 });
    const events = [];
    const sender = createMultiFlowSender({
      ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash,
      onEvent: (ev) => events.push(ev),
      progressIntervalMs: 100_000, now: () => 0, // a clock that never advances past the interval
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(events.filter((e) => e.type === 'progress').length).toBeLessThanOrEqual(1);
  });

  it('emits file-sent exactly once per file when the tracker reports it fully covered', async () => {
    const A = new Uint8Array(4096).map((_, i) => (i * 5) & 0xff);
    const B = new Uint8Array(2048).map((_, i) => (i * 9) & 0xff);
    const sources = new Map([[0, A], [1, B]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }, { fileId: 1, size: B.length }] };
    const rig = wire({ manifest, sources, flowCount: 2 });
    const events = [];
    const sender = createMultiFlowSender({
      ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 2,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash,
      onEvent: (ev) => events.push(ev),
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    const fileSentEvents = events.filter((e) => e.type === 'file-sent');
    expect(fileSentEvents.map((e) => e.fileId).sort()).toEqual([0, 1]);
    expect(fileSentEvents.length).toBe(2); // exactly once each, not re-emitted on later reports
  });

  it('reconciles: a dropped chunk in pass 1 is re-sent until coverage completes', async () => {
    const A = new Uint8Array(4096 * 4).map((_, i) => (i * 11) & 0xff);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }] };
    // Drop the chunk at offset 8192 on its FIRST delivery only.
    const dropped = new Set(['0:8192']);
    const rig = wire({ manifest, sources, dropFileOffsets: dropped });
    // After pass 1 the receiver reports the gap; un-drop so pass 2 delivers it.
    const origReport = rig.report;
    rig.report = () => { dropped.delete('0:8192'); return origReport(); };
    const sender = createMultiFlowSender({ ctrl: rig.ctrl, flows: rig.flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 3, groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash, reconcileWaitMs: 50 });
    const r = await sender.start();
    expect(r.ok).toBe(true);
    expect(Buffer.from(rig.dest.get(0)).equals(Buffer.from(A))).toBe(true);
  });

  it('sends file_end for a file already byte-complete on accept (resume) and completes', async () => {
    const size = 4096 * 2;
    const A = new Uint8Array(size).map((_, i) => (i * 5) & 0xff);
    let onCtrl = null; const sent = [];
    const ctrl = {
      sendCtrl: (s) => {
        const f = parseCtrlFrame(s);
        sent.push(f);
        if (f.t === 'offer' || f.t === 'offer_end') onCtrl(acceptFrame({ jobId: JOB, resume: [], ranges: [{ fileId: 0, ivals: [[0, size]] }] }));
        if (f.t === 'file_end') onCtrl(rangeReportFrame({ jobId: JOB, files: [{ fileId: 0, ivals: [[0, size]] }] }));
        if (f.t === 'job_done') onCtrl(completeFrame({ jobId: JOB, ok: true }));
      },
      onCtrl: (cb) => { onCtrl = cb; },
    };
    const flows = [{ isAlive: () => true, sendBulk: () => Promise.resolve() }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: { entries: [{ fileId: 0, size }] }, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32),
      readerFor: () => ({ readAt: (o, l) => Promise.resolve(A.subarray(o, o + l)), close: () => {} }),
      newHash: () => ({ update() {}, digest: () => 'H' }),
      reconcileWaitMs: 50,
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(sent.some((f) => f.t === 'file_end' && f.fileId === 0)).toBe(true); // file_end sent despite full resume coverage
  });

  // UI-legibility gap: live-observed as the sender frozen on "Transferring ·
  // 0 MB/s" during the receiver's verify tail. Once the sender has dispatched
  // everything the tracker can confirm + sent job_done, it's only WAITING on
  // the receiver's complete ack — 'all-sent' (which the renderer maps to
  // "Finishing…") must surface THEN, not only once `completed` also lands.
  // The ctrl mock here deliberately does NOT auto-reply to job_done, so the
  // test can observe the gap between all-sent and completed directly.
  it('emits all-sent once production is done and it is only waiting on the complete ack, before completed', async () => {
    const size = 4096;
    const A = new Uint8Array(size).map((_, i) => (i * 3) & 0xff);
    let onCtrl = null;
    const events = [];
    const ctrl = {
      sendCtrl: (s) => {
        const f = parseCtrlFrame(s);
        if (f.t === 'offer' || f.t === 'offer_end') onCtrl(acceptFrame({ jobId: JOB, resume: [], ranges: [] }));
        else if (f.t === 'file_end') onCtrl(rangeReportFrame({ jobId: JOB, files: [{ fileId: 0, ivals: [[0, size]] }] }));
        // Deliberately no auto-reply to job_done — driven manually below.
      },
      onCtrl: (cb) => { onCtrl = cb; },
    };
    const flows = [{ isAlive: () => true, sendBulk: () => Promise.resolve() }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: { entries: [{ fileId: 0, size }] }, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32),
      readerFor: () => ({ readAt: (o, l) => Promise.resolve(A.subarray(o, o + l)), close: () => {} }),
      newHash: () => ({ update() {}, digest: () => 'H' }),
      onEvent: (ev) => events.push(ev),
      reconcileWaitMs: 30,
    });
    const done = sender.start();
    // Let the initial pass + file_end's range_report + job_done dispatch flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.type === 'all-sent')).toBe(true); // "Finishing…"
    expect(events.some((e) => e.type === 'completed')).toBe(false); // receiver hasn't acked yet

    onCtrl(completeFrame({ jobId: JOB, ok: true }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(events.some((e) => e.type === 'completed')).toBe(true);
  });

  // Livelock regression: a raw createReceiveRouter-backed receiver (the real
  // paired implementation) OMITS a finalized file from every range_report from
  // then on (see transfer-receive-router.js's rangesFor()) — this fake mirrors
  // that exactly instead of ever reporting the file as covered. The tracker
  // therefore NEVER converges via tracker.isComplete(); only the receiver's own
  // `complete{ok:true}` frame (sent here right after the first pass) settles
  // the driver. pump()'s reconcile loop must still terminate once settled, or
  // it re-reads/re-sends the whole payload forever.
  it('pump stops re-sending once the receiver settles the transfer, even if its reports never mark the tracker complete', async () => {
    const size = 4096 * 2;
    const A = new Uint8Array(size).map((_, i) => i & 0xff);
    let onCtrl = null;
    let sendBulkCalls = 0;
    const ctrl = {
      sendCtrl: (s) => {
        const f = parseCtrlFrame(s);
        if (f.t === 'offer' || f.t === 'offer_end') {
          onCtrl(acceptFrame({ jobId: JOB, resume: [], ranges: [] }));
        } else if (f.t === 'file_end') {
          // Simulate the real receiver finalizing the file: its range_report
          // OMITS the file entirely (never reports it covered), then it settles
          // the sender via `complete` — mirroring createMultiFlowReceiver's
          // maybeComplete()/router.isComplete() path, WITHOUT this task's
          // receiver-side fix (reportFiles()).
          onCtrl(rangeReportFrame({ jobId: JOB, files: [] }));
          onCtrl(completeFrame({ jobId: JOB, ok: true }));
        }
      },
      onCtrl: (cb) => { onCtrl = cb; },
    };
    const flows = [{
      isAlive: () => true,
      sendBulk: () => { sendBulkCalls += 1; return Promise.resolve(); },
    }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: { entries: [{ fileId: 0, size }] }, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32),
      readerFor: () => ({ readAt: (o, l) => Promise.resolve(A.subarray(o, o + l)), close: () => {} }),
      newHash: () => ({ update() {}, digest: () => 'H' }),
      reconcileWaitMs: 30,
    });
    const r = await sender.start();
    expect(r).toEqual({ jobId: JOB, ok: true });
    const callsAtResolve = sendBulkCalls;
    // Wait a few reconcile intervals — pre-fix, pump() never observes
    // tracker.isComplete() (the report always omits the file) and keeps
    // calling gapPass -> sendBulk every reconcileWaitMs forever.
    await new Promise((res) => setTimeout(res, 30 * 4));
    expect(sendBulkCalls).toBe(callsAtResolve); // pump terminated — no further sends
  });

  // Per-file failure isolation: the receiver now completes-with-failures
  // (sends complete{ok:false}) instead of never completing / retrying forever
  // when one file terminally fails (e.g. AV-locked .part) on its side. Before
  // this fix, complete{ok:false} always meant fail('receiver_incomplete') —
  // which for an own-fleet/contact send is RECOVERABLE and triggers
  // auto-resume, re-sending the same doomed file into the same failure
  // forever. By the time the receiver sends `complete` at all, its own
  // reconciliation has already retried everything it can, so re-sending can't
  // help — start() must RESOLVE {ok:false}, not reject/loop.
  it('resolves {ok:false} (done-with-failures) on an inbound complete{ok:false} instead of rejecting/looping', async () => {
    const size = 4096;
    const A = new Uint8Array(size).map((_, i) => (i * 3) & 0xff);
    let onCtrl = null;
    const events = [];
    const ctrl = {
      sendCtrl: (s) => {
        const f = parseCtrlFrame(s);
        if (f.t === 'offer' || f.t === 'offer_end') onCtrl(acceptFrame({ jobId: JOB, resume: [], ranges: [] }));
        else if (f.t === 'file_end') onCtrl(rangeReportFrame({ jobId: JOB, files: [{ fileId: 0, ivals: [[0, size]] }] }));
        else if (f.t === 'job_done') onCtrl(completeFrame({ jobId: JOB, ok: false })); // receiver: completed WITH a terminal per-file failure
      },
      onCtrl: (cb) => { onCtrl = cb; },
    };
    const flows = [{ isAlive: () => true, sendBulk: () => Promise.resolve() }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: { entries: [{ fileId: 0, size }] }, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32),
      readerFor: () => ({ readAt: (o, l) => Promise.resolve(A.subarray(o, o + l)), close: () => {} }),
      newHash: () => ({ update() {}, digest: () => 'H' }),
      onEvent: (ev) => events.push(ev),
      reconcileWaitMs: 30,
    });
    const r = await sender.start(); // must RESOLVE, not reject
    expect(r).toEqual({ jobId: JOB, ok: false });
    const completed = events.find((e) => e.type === 'completed');
    expect(completed).toBeTruthy();
    expect(completed.ok).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false); // no 'receiver_incomplete' error event
  });

  // Task 6: the ctrl channel (flow 0's ft-ctrl) is SWAPPABLE. When the supervisor
  // re-dials a dead slot 0, setCtrl(newChannel) hands the control plane over: the
  // new channel gets a re-sent OFFER (re-sync — idempotent on the receiver per
  // Task 5), the range_report handler re-attaches to it (reconciliation continues),
  // and the OLD channel's handler no longer drives state. Exercised only AFTER the
  // receive is active (a realistic re-dial happens mid-transfer, not before accept).
  it('setCtrl swaps the ctrl channel: new channel gets a re-sent OFFER, a range_report on it drives coverage, and the old channel no longer drives state', async () => {
    const size = 4096 * 2;
    const A = new Uint8Array(size).map((_, i) => (i * 7) & 0xff);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size }] };

    // Two independent ctrl channels; `fire` is a no-op if no handler was attached
    // (so a mutation that skips re-attaching onCtrl fails cleanly, not by throwing).
    function manualCtrl() {
      let cb = null; const out = [];
      return { ch: { sendCtrl: (s) => out.push(parseCtrlFrame(s)), onCtrl: (c) => { cb = c; } }, fire: (f) => cb && cb(f), out };
    }
    const c1 = manualCtrl();
    const c2 = manualCtrl();
    const flows = [{ isAlive: () => true, sendBulk: () => Promise.resolve() }];
    const events = [];
    const sender = createMultiFlowSender({
      ctrl: c1.ch, flows, jobId: JOB, manifest, chunkSize: 4096, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash,
      onEvent: (ev) => events.push(ev),
      progressIntervalMs: 0,
      reconcileWaitMs: 100_000, // keep a spurious gap pass from interfering with the swap
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const done = sender.start();
    expect(c1.out.some((f) => f.t === 'offer')).toBe(true); // initial OFFER on the original channel
    // Accept on ch1 → pump runs the initial pass (file_end + job_done go out on ch1).
    c1.fire(acceptFrame({ jobId: JOB, resume: [], ranges: [] }));
    await flush(); await flush(); await flush();

    // Slot 0 died and was re-dialed: swap the ctrl channel.
    sender.setCtrl(c2.ch);
    expect(c2.out.some((f) => f.t === 'offer')).toBe(true); // re-sent OFFER (re-sync) on the new channel

    // A range_report on the NEW channel drives the coverage tracker (progress +
    // file-sent), proving reconciliation continues on ch2.
    const progressBefore = events.filter((e) => e.type === 'progress').length;
    c2.fire(rangeReportFrame({ jobId: JOB, files: [{ fileId: 0, ivals: [[0, size]] }] }));
    await flush();
    const progressAfter = events.filter((e) => e.type === 'progress');
    expect(progressAfter.length).toBeGreaterThan(progressBefore);
    expect(progressAfter[progressAfter.length - 1].progress.sent).toBe(size);
    expect(events.some((e) => e.type === 'file-sent' && e.fileId === 0)).toBe(true);

    // The OLD channel no longer drives state: a complete on ch1 is ignored.
    c1.fire(completeFrame({ jobId: JOB, ok: false }));
    await flush();
    expect(events.some((e) => e.type === 'completed')).toBe(false); // ch1 ignored — not settled

    // The NEW channel carries completion.
    c2.fire(completeFrame({ jobId: JOB, ok: true }));
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true }); // resolved by ch2's complete, not ch1's
  });
});

// Resilient multi-flow Task 2/7: the sender threads `awaitFlow` into its send
// pool so a pump that starts before any flow has connected (staggered dial) or
// that loses its only flow mid-transfer WAITS for a resupplied flow instead of
// throwing no_live_flows. Proves the wiring end-to-end: start pump with only a
// DEAD flow, and only after awaitFlow is invoked (and a live flow pushed into
// the SAME array) does delivery complete.
describe('createMultiFlowSender awaitFlow threading', () => {
  it('a starved pump waits on awaitFlow, then completes once a live flow is resupplied', async () => {
    const A = new Uint8Array(60).map((_, i) => (i * 5) & 0xff);
    const sources = new Map([[0, A]]);
    const manifest = { entries: [{ fileId: 0, size: A.length }] };
    const dest = new Uint8Array(A.length);
    const recv = [];
    let ctrlOnMsg = null;
    let reportTimer = null;
    const covered = () => { const arr = [...recv].sort((a, b) => a[0] - b[0]); const out = []; for (const [s, e] of arr) { const l = out[out.length - 1]; if (l && s <= l[1]) l[1] = Math.max(l[1], e); else out.push([s, e]); } return out; };
    const isComplete = () => { const iv = covered(); return iv.length === 1 && iv[0][0] === 0 && iv[0][1] >= A.length; };
    const report = () => ctrlOnMsg && ctrlOnMsg(rangeReportFrame({ jobId: JOB, files: [{ fileId: 0, ivals: covered() }] }));
    const ctrl = {
      sendCtrl: (s) => {
        const f = parseCtrlFrame(s);
        if (f.t === 'offer' || f.t === 'offer_end') ctrlOnMsg(acceptFrame({ jobId: JOB, resume: [], ranges: [] }));
        else if (f.t === 'file_end') setTimeout(report, 0);
        else if (f.t === 'job_done') { if (isComplete()) { clearInterval(reportTimer); ctrlOnMsg(completeFrame({ jobId: JOB, ok: true })); } else setTimeout(report, 0); }
      },
      onCtrl: (cb) => { ctrlOnMsg = cb; if (!reportTimer) { reportTimer = setInterval(() => report(), 10); if (reportTimer.unref) reportTimer.unref(); } },
    };
    const deadFlow = { isAlive: () => false, sendBulk: () => Promise.reject(new Error('dead')) };
    const liveFlow = { isAlive: () => true, sendBulk: (buf) => { const d = decodeBulkFrame(buf); dest.set(d.payload, d.offset); recv.push([d.offset, d.offset + d.length]); return Promise.resolve(); } };
    const flows = [deadFlow];
    let awaitCalls = 0;
    let resolveAwait = null;
    const awaitFlow = () => { awaitCalls += 1; return new Promise((res) => { resolveAwait = res; }); };

    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest, chunkSize: 60, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash, awaitFlow,
    });
    const done = sender.start();
    // Let accept → pump → starvation → awaitFlow happen.
    await new Promise((r) => setTimeout(r, 40));
    expect(awaitCalls).toBeGreaterThan(0);
    expect(typeof resolveAwait).toBe('function'); // pool parked on awaitFlow, not thrown

    flows.push(liveFlow); // resupply
    resolveAwait();
    const r = await done;
    expect(r).toEqual({ jobId: JOB, ok: true });
    expect(Buffer.from(dest).equals(Buffer.from(A))).toBe(true);
  });
});

// Final-review #2: createMultiFlowSender's pump can park indefinitely on the
// send pool's awaitFlow when every flow is down and the supervisor never reaches
// all-slots-`dead` (so awaitFlow never rejects). The receiver has a ~25s
// inactivity watchdog; the sender needs one too, or the send hangs forever.
describe('createMultiFlowSender — Final-review #2 stall watchdog', () => {
  // Deterministic injected clock: setTimer records a callback+due-time, advance()
  // fires everything due. unref is a no-op (real timers get it; this doesn't need it).
  function fakeClock() {
    let now = 0, id = 0; const timers = new Map();
    return {
      setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms }); return { __t: t, unref() {} }; },
      clearTimer: (h) => { if (h && h.__t) timers.delete(h.__t); },
      advance: async (ms) => {
        now += ms;
        for (const [t, e] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (e.at <= now) { timers.delete(t); e.fn(); }
        }
        await Promise.resolve();
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0)); // real macrotask: drains the serializer's microtasks
  const oneFile = { entries: [{ fileId: 0, size: 300 }] };
  const src = new Map([[0, new Uint8Array(300)]]);
  // A ctrl that auto-accepts the OFFER and can be driven to emit range_reports.
  function makeCtrl() {
    let cb = null;
    return {
      sendCtrl: (s) => { const f = parseCtrlFrame(s); if (f && (f.t === 'offer' || f.t === 'offer_end')) cb(acceptFrame({ jobId: JOB, resume: [], ranges: [] })); },
      onCtrl: (c) => { cb = c; },
      report: (files) => cb(rangeReportFrame({ jobId: JOB, files })),
    };
  }

  it('flows all die and never recover (awaitFlow never resolves) -> FAILS with stalled within the bound (not hang)', async () => {
    const clk = fakeClock();
    const ctrl = makeCtrl();
    const flows = [{ isAlive: () => false, sendBulk: () => Promise.resolve() }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: oneFile, chunkSize: 100, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(src), newHash: fakeHash,
      awaitFlow: () => new Promise(() => {}), // parks forever
      inactivityMs: 5000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, completionTimeoutMs: 0,
    });
    const done = sender.start();
    let settled = false; done.then(() => { settled = true; }, () => { settled = true; });
    await flush(); await flush(); // accept -> pump -> park on awaitFlow, watchdog armed at t=0
    expect(settled).toBe(false);
    await clk.advance(5000);
    await expect(done).rejects.toThrow('stalled');
  });

  it('mutation: inactivityMs:0 disables the watchdog — the same parked send does NOT fail (proves the guard is load-bearing)', async () => {
    const clk = fakeClock();
    const ctrl = makeCtrl();
    const flows = [{ isAlive: () => false, sendBulk: () => Promise.resolve() }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: oneFile, chunkSize: 100, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(src), newHash: fakeHash,
      awaitFlow: () => new Promise(() => {}),
      inactivityMs: 0, setTimer: clk.setTimer, clearTimer: clk.clearTimer, completionTimeoutMs: 0,
    });
    const done = sender.start();
    let settled = false; done.then(() => { settled = true; }, () => { settled = true; });
    await flush(); await flush();
    await clk.advance(1_000_000); // far past any bound
    await flush();
    expect(settled).toBe(false); // no watchdog -> the parked send hangs
  });

  it('a healthy send with steady range_reports does NOT trip the watchdog; cessation then trips it', async () => {
    const clk = fakeClock();
    const ctrl = makeCtrl();
    // sendBulk parks so pump stays in-flight and the ONLY watchdog reset is the
    // receiver's range_report cadence — isolating "steady progress keeps it alive".
    const flows = [{ isAlive: () => true, sendBulk: () => new Promise(() => {}) }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: oneFile, chunkSize: 100, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(src), newHash: fakeHash,
      inactivityMs: 1000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, completionTimeoutMs: 0, progressIntervalMs: 0,
    });
    const done = sender.start();
    let settled = false; done.then(() => { settled = true; }, () => { settled = true; });
    await flush(); await flush(); // pump armed the watchdog at t=0 (would fire at 1000)
    for (let i = 0; i < 5; i += 1) {
      await clk.advance(600); // < inactivityMs
      ctrl.report([{ fileId: 0, ivals: [[0, Math.min(300, 100 * (i + 1))]] }]);
      await flush();
      expect(settled).toBe(false); // never tripped while reports keep coming
    }
    await clk.advance(1000); // reports stop -> the bound elapses
    await expect(done).rejects.toThrow('stalled');
  });
});

// Task 6 (common-mode-resilience): reconcile the stall watchdog with the
// gentle-outage-recovery model (supervisor Tasks 2-4). A TOTAL outage now keeps
// the session alive and gently re-dials for up to outageGiveupMs — the watchdog
// must NOT fire during that legitimate recovery (0 live flows, supervisor not
// yet given up), or it re-introduces the whole-transfer resume loop this phase
// eliminates. It must STILL fire on a genuine wedge (bytes should be moving —
// ≥1 flow alive — but aren't), and the send must still fail once the supervisor
// gives up (via the pool's awaitFlow-reject path). The gate is INJECTED
// (watchdogGate) — the assembly composes it from the supervisor's liveCount()/
// hasGivenUp(); here it's driven directly for deterministic fake-clock control.
describe('createMultiFlowSender — Task 6 stall-watchdog outage gate', () => {
  function fakeClock() {
    let now = 0, id = 0; const timers = new Map();
    return {
      setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms }); return { __t: t, unref() {} }; },
      clearTimer: (h) => { if (h && h.__t) timers.delete(h.__t); },
      advance: async (ms) => {
        now += ms;
        for (const [t, e] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (e.at <= now) { timers.delete(t); e.fn(); }
        }
        await Promise.resolve();
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const oneFile = { entries: [{ fileId: 0, size: 300 }] };
  const src = new Map([[0, new Uint8Array(300)]]);
  function makeCtrl() {
    let cb = null;
    return {
      sendCtrl: (s) => { const f = parseCtrlFrame(s); if (f && (f.t === 'offer' || f.t === 'offer_end')) cb(acceptFrame({ jobId: JOB, resume: [], ranges: [] })); },
      onCtrl: (c) => { cb = c; },
      report: (files) => cb(rangeReportFrame({ jobId: JOB, files })),
    };
  }

  it('total outage (0 live flows, supervisor still recovering) does NOT trip the stall watchdog', async () => {
    const clk = fakeClock();
    const ctrl = makeCtrl();
    // A dead flow: the pump starves and parks on awaitFlow (which never resolves —
    // the supervisor is quietly re-dialing). liveCount 0 and NOT given up, so the
    // gate is CLOSED and the watchdog must keep re-arming rather than fail.
    const flows = [{ isAlive: () => false, sendBulk: () => Promise.resolve() }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: oneFile, chunkSize: 100, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(src), newHash: fakeHash,
      awaitFlow: () => new Promise(() => {}), // parks forever (gentle recovery in progress)
      watchdogGate: () => false, // liveCount()===0 && !hasGivenUp()
      inactivityMs: 5000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, completionTimeoutMs: 0,
    });
    const done = sender.start();
    let settled = false; done.then(() => { settled = true; }, () => { settled = true; });
    await flush(); await flush(); // accept -> pump -> park on awaitFlow, watchdog armed at t=0
    await clk.advance(60000); // 12x the watchdog bound, still well under outageGiveupMs
    await flush();
    expect(settled).toBe(false); // the outage gate kept the watchdog from firing
  });

  it('a genuine wedge — ≥1 flow ALIVE but no progress — DOES trip the watchdog', async () => {
    const clk = fakeClock();
    const ctrl = makeCtrl();
    // A LIVE flow whose sendBulk parks: the pump stays in-flight, no range_report
    // ever comes back — bytes should be moving but aren't. The gate is OPEN.
    const flows = [{ isAlive: () => true, sendBulk: () => new Promise(() => {}) }];
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: oneFile, chunkSize: 100, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(src), newHash: fakeHash,
      watchdogGate: () => true, // liveCount() >= 1
      inactivityMs: 5000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, completionTimeoutMs: 0, progressIntervalMs: 0,
    });
    const done = sender.start();
    let settled = false; done.then(() => { settled = true; }, () => { settled = true; });
    await flush(); await flush();
    await clk.advance(5000);
    await expect(done).rejects.toThrow('stalled');
    expect(settled).toBe(true);
  });

  it('after the supervisor GIVES UP, the send fails through the awaitFlow-reject path (not the watchdog)', async () => {
    const clk = fakeClock();
    const ctrl = makeCtrl();
    const flows = [{ isAlive: () => false, sendBulk: () => Promise.resolve() }];
    let rejectAwait = null;
    const sender = createMultiFlowSender({
      ctrl, flows, jobId: JOB, manifest: oneFile, chunkSize: 100, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(src), newHash: fakeHash,
      // The supervisor's starvation waiter, parked until its outage timer fires
      // outageGiveupMs and rejects (the pool then throws no_live_flows).
      awaitFlow: () => new Promise((_res, rej) => { rejectAwait = rej; }),
      watchdogGate: () => false, // liveCount 0 the whole time; the watchdog stays quiet
      inactivityMs: 5000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, completionTimeoutMs: 0,
    });
    const done = sender.start();
    await flush(); await flush(); // park on awaitFlow, watchdog armed (gate closed)
    await clk.advance(20000); // several watchdog bounds pass — gate closed, no 'stalled'
    await flush();
    expect(typeof rejectAwait).toBe('function'); // still parked, not torn down by the watchdog
    rejectAwait(new Error('outage_giveup')); // supervisor gave up (outageGiveupMs elapsed)
    await expect(done).rejects.toThrow('no_live_flows'); // failed via the pool's awaitFlow-reject path
  });
});

// Phase 2 Task 3 (one-path cleanup): the single-flow driver's regression test
// for the v1.11.2 field bug ("a 2974-file folder packed the whole manifest
// into ONE ft-ctrl OFFER (~300KB), overran the ~256KB channel limit, and the
// send killed ft-ctrl before delivery -> receiver never saw the OFFER ->
// controller stuck") was deleted along with the single-flow drivers it
// exercised. batchEntriesBySize/offerBatchBytes is SHARED code — the
// multi-flow sender chunks its OFFER the identical way (see :398-404 in the
// orchestrator) — but nothing proved that end-to-end for createMultiFlowSender
// + createMultiFlowReceiver until this test. Real drivers, a real (small)
// simulated channel-size limit, and a manifest big enough to force
// offer_begin -> offer_entries* -> offer_end instead of one legacy `offer`
// frame.
function sizedCtrlPair(maxBytes) {
  let toA = null, toB = null;
  const stats = { maxCtrl: 0, dropped: 0 };
  const send = (s, deliver) => {
    stats.maxCtrl = Math.max(stats.maxCtrl, s.length);
    if (s.length > maxBytes) { stats.dropped += 1; return; } // oversized -> lost, as a real dc.send() throw would kill delivery
    queueMicrotask(() => deliver && deliver(s));
  };
  const senderCtrl = { sendCtrl: (s) => send(s, toB), onCtrl: (cb) => { toA = cb; } };
  const receiverCtrl = { sendCtrl: (s) => send(s, toA), onCtrl: (cb) => { toB = cb; } };
  return { senderCtrl, receiverCtrl, stats };
}

// One bulk flow bridging a real sender's sendBulk straight to a real
// receiver's onBulk registration.
function bulkBridge() {
  let cb = null;
  const senderFlow = { isAlive: () => true, sendBulk: (buf) => { queueMicrotask(() => cb && cb(buf)); return Promise.resolve(); } };
  const receiverFlow = { onBulk: (fn) => { cb = fn; } };
  return { senderFlow, receiverFlow };
}

describe('createMultiFlowSender + createMultiFlowReceiver: OFFER chunking over a size-limited channel', () => {
  it('a large manifest is split into offer_begin/offer_entries*/offer_end so no ctrl frame exceeds the channel limit, and the receiver reassembles every file', async () => {
    const N = 60;
    const entries = [];
    const sources = new Map();
    for (let i = 0; i < N; i += 1) {
      const path = `file-with-a-moderately-long-name-${String(i).padStart(4, '0')}.dat`;
      const data = new Uint8Array(24).fill((i * 37 + 3) & 0xff);
      sources.set(i, data);
      entries.push({ fileId: i, path, size: data.length, mtime: 0 });
    }
    const manifest = { entries, totalBytes: entries.reduce((a, e) => a + e.size, 0), totalFiles: N };

    const MAX = 4096; // pretend data-channel message limit -- one legacy `offer` frame for 60 files would exceed this
    const { senderCtrl, receiverCtrl, stats } = sizedCtrlPair(MAX);
    const { senderFlow, receiverFlow } = bulkBridge();

    const dest = new Map();
    const rx = createMultiFlowReceiver({
      ctrl: receiverCtrl, flows: [receiverFlow], jobId: JOB, consent: async () => true,
      openPart: (relPath) => {
        const entry = entries.find((e) => e.path === relPath);
        const b = new Uint8Array(entry.size);
        dest.set(relPath, b);
        return Promise.resolve({ writeAt: (o, x) => { b.set(x, o); return Promise.resolve(); }, close: () => Promise.resolve(), liveDigest: () => null });
      },
      verifyAndFinalize: () => Promise.resolve({ ok: true }),
      reportIntervalMs: 10_000,
    });
    const rxDone = rx.start();

    const sender = createMultiFlowSender({
      ctrl: senderCtrl, flows: [senderFlow], jobId: JOB, manifest, chunkSize: 512, flowCount: 1,
      groupId: 'b'.repeat(32), readerFor: readerFor(sources), newHash: fakeHash, offerBatchBytes: 1024,
    });
    const sndDone = sender.start();

    const rxRes = await rxDone; // a dropped/oversized OFFER would leave this hanging
    await sndDone;

    expect(rxRes.ok).toBe(true);
    expect(stats.dropped).toBe(0);          // no ctrl frame exceeded the channel limit
    expect(stats.maxCtrl).toBeLessThanOrEqual(MAX);
    for (const e of entries) expect([...dest.get(e.path)]).toEqual([...sources.get(e.fileId)]);
  });
});
