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
});
