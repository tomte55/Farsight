// packages/shared/test/transfer-multiflow-sender.test.js
import { describe, it, expect } from 'vitest';
import { createMultiFlowSender } from '../src/transfer-orchestrator.js';
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
  it('applying a range_report emits progress with the aggregate shape {sent,total,fraction,filesSent,filesTotal}', async () => {
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
      expect(Object.keys(e.progress).sort()).toEqual(['filesSent', 'filesTotal', 'fraction', 'sent', 'total'].sort());
    }
    const last = progressEvents[progressEvents.length - 1];
    expect(last.progress).toEqual({ sent: A.length, total: A.length, fraction: 1, filesSent: 1, filesTotal: 1 });
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
