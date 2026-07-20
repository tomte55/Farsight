// packages/controller/test/harness-spike/transfer-fault-e2e.mjs
// ============================================================================
// REAL-WIRE FAULT-INJECTION harness (Plan 1b Tasks 5-8). Reuses harness-lib to
// bring up two real Electron app processes over CDP with FARSIGHT_TEST_HOOKS=1,
// then drives window.farsightIpc.ftTestFault(...) to perturb a live transfer's
// individual flows and asserts the failure is LOUD + BOUNDED (re-dial recovery
// at N>1, or a loud terminal at N=1) — NEVER a silent hang/zombie.
//
// Scenarios (SPIKE_SCENARIO, default fb1):
//   fb1  — F-B1: drop a flow's signaling socket mid-transfer. The drop must be
//          SURFACED (a signaling error/re-dial appears in the sender log) and the
//          transfer must still complete byte-identical (supervisor re-dial). Before
//          the fix the socket death was silent (no error/close handler) → the log
//          shows no signaling error and `await signal.ready` could hang forever.
//   fb5  — F-B5 (Phase 3b): drop RECEIVE flow 0 mid-transfer. The anchor-driven
//          rendezvous waits anchorWaitMs for the re-dialed flow 0 instead of
//          aborting the group, then completes byte-identical N/N.
//   fb6  — F-B6 (Phase 3b): a flow that re-dials INTO a held consent window is
//          BUFFERED (a `rolling-join buffered` log line) and attached on accept,
//          then completes N/N — pre-3b it was dropped as an orphan.
//   fb7  — F-B7 (Phase 4): corrupt already-verified chunks of a receive .part on
//          disk mid-transfer. The whole-file finalize hash catches the mismatch;
//          the receiver LOCATES the bad chunks and re-drives ONLY those (not the
//          whole file), then completes byte-identical. Asserts a verify mismatch
//          was detected (recv ev=file-failed) then recv ev=completed + N/N.
//
// Env: SPIKE_FLOWS (default 4), SPIKE_WAIT_MS (default 90000), SPIKE_SCENARIO.
// ============================================================================
import {
  log, delay, makeAttemptContext, startSignaling, writeStandardPayload,
  bringUpPair, armConsentHold, cdpEval, awaitDelivery, verifyDelivery, awaitLogLine, mkdir, writeFile, join, sha256, CHUNK,
} from './harness-lib.mjs';
import { open as fsOpen, readdir as fsReaddir } from 'node:fs/promises';

// Recursively find a <name> file under root (the receiver's in-flight .part).
async function findPartFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsReaddir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.name === name) return p;
    }
  }
  return null;
}

const FLOW_COUNT = Number(process.env.SPIKE_FLOWS) || 4;
const WAIT_MS = Number(process.env.SPIKE_WAIT_MS) || 90000;
const SCENARIO = process.env.SPIKE_SCENARIO || 'fb1';

// A LARGER payload than the standard set so the transfer lasts long enough to
// reliably inject a mid-flight fault (one big multi-chunk file + the standard set).
async function writeFaultPayload(srcRoot) {
  const { srcDir, expected } = await writeStandardPayload(srcRoot);
  const bigLen = CHUNK * 200 + 123; // ~26 MB, 201 chunks — a multi-second window
  const data = new Uint8Array(bigLen);
  for (let i = 0; i < bigLen; i++) data[i] = (i * 2654435761) & 0xff;
  const abs = join(srcDir, 'huge.bin');
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, data);
  expected.set('huge.bin', { size: bigLen, hash: sha256(Buffer.from(data)) });
  return { srcDir, expected };
}

// Inject a fault, retrying until it lands on a LIVE worker for that flow (ok:true)
// or the budget expires. Returns the last dispatch result.
async function injectUntilLands(sendWs, fault, { tries = 200, everyMs = 20 } = {}) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    r = await cdpEval(sendWs, `window.farsightIpc.ftTestFault(${JSON.stringify(fault)}).then((x)=>JSON.stringify(x),(e)=>'ERR:'+(e&&e.message))`);
    if (typeof r === 'string' && r.includes('"ok":true')) return r;
    await delay(everyMs);
  }
  return r;
}

// A fault scenario: inject `fault` on flow 1 mid-transfer, then assert the
// finding's LOUD + BOUNDED + COMPLETE contract — the fault is SURFACED in the
// sender log (`surfacedRegex`), the transfer reaches a terminal outcome within
// timeout (NEVER a silent zombie), AND recovery actually COMPLETES delivery:
// the receiver's terminal state must be 'completed' and every file must land
// byte-identical. A terminal 'interrupted'/'failed'/'canceled' after a fault,
// or a byte-identical shortfall, is a FAILURE for these scenarios — the whole
// point of flow-death recovery (Phase 3a, F-B11) is that it completes the
// transfer, not merely that it stops loud instead of hanging silently.
async function runScenario({ label, fault, surfacedRegex }) {
  const { cleanups, cleanupAll, tmp } = makeAttemptContext();
  try {
    const signalingUrl = await startSignaling(cleanups);
    const { srcDir, expected } = await writeFaultPayload(await tmp('fault-src-'));
    log(`${label}: payload ${expected.size} files; flowCount=${FLOW_COUNT}`);

    const { sendWs, recvWs, hostId, hostPw, recvDownloads, sendChild, recvChild } =
      await bringUpPair({ signalingUrl, cleanups, tmp, extraEnv: { FARSIGHT_TEST_HOOKS: '1' } });

    const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({ target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT }, paths: [srcDir] })})`);
    if (!sendRes || sendRes.error) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));

    // The fault registry is PER-PROCESS: send workers register only in the sender
    // process, receive workers only in the receiver (main.js trackWorker). So a
    // `side:'receive'` fault MUST be dispatched on the receiver's renderer (recvWs),
    // and its surfaced signaling error lands in the RECEIVER's log — dispatching it
    // on sendWs returns no_worker:receive:N (diagnosed on the F-B5 first run).
    const onReceive = fault.side === 'receive';
    const injectWs = onReceive ? recvWs : sendWs;
    const surfacedChild = onReceive ? recvChild : sendChild;

    // Inject MID-TRANSFER (spec: "killWorker mid-transfer"). Wait until bytes are
    // actually flowing — a progress event — so every flow's renderer is fully
    // loaded + connected. Injecting during rendezvous is unreliable for a crash
    // (forcefullyCrashRenderer on a still-loading renderer may not fire
    // render-process-gone) and gives a less realistic test.
    await awaitLogLine(sendChild, /send ev=progress/, 20000);
    log(`transfer flowing; injecting ${fault.cmd} on ${fault.side} flow ${fault.flowIndex}...`);

    const injected = await injectUntilLands(injectWs, fault);
    log(`${fault.cmd}(${fault.side} flow ${fault.flowIndex}) =>`, injected);

    const failures = [];
    if (typeof injected !== 'string' || !injected.includes('"ok":true')) failures.push(`${fault.cmd} never landed on a live ${fault.side} flow-${fault.flowIndex} worker: ${injected}`);

    // (1) LOUD: the fault was surfaced in the ft-worker log of the faulted side.
    const surfaced = await awaitLogLine(surfacedChild, surfacedRegex, 20000);
    log('fault surfaced:', surfaced ? surfaced.slice(-90) : 'NO');
    if (!surfaced) failures.push(`${label} REGRESSION: the fault was NOT surfaced (${surfacedRegex}) — silent, as before the fix`);

    // (2) BOUNDED: the RECEIVER reaches a terminal outcome within timeout — never a hang.
    const terminal = await awaitLogLine(recvChild, /recv ev=(completed|interrupted|failed|canceled)/, WAIT_MS);
    const terminalState = terminal ? (terminal.match(/recv ev=(completed|interrupted|failed|canceled)/) || [])[1] : null;
    log('receiver terminal outcome:', terminal ? terminalState : 'NONE (HANG!)');
    if (!terminal) failures.push(`${label} HANG: the transfer never reached a terminal state within timeout (zombie)`);

    // (3) COMPLETE: recovery must actually deliver byte-identical N/N — a terminal
    // 'interrupted'/'failed'/'canceled' after a fault, or a delivery shortfall, is
    // NOT a success for these scenarios (the point of Phase 3a recovery is that it
    // COMPLETES the transfer). This used to be logged as INFO only, which let a run
    // go green even with a dropped file — the exact old 5/6 F-B11 bug — so it is
    // now asserted like the other two contracts. `received` from awaitDelivery only
    // proves FILENAME presence — it is a cheap pre-check, NOT the authoritative
    // pass/fail. The authoritative check is verifyDelivery's sha256 + size compare
    // (same verifier two-process-harness.mjs uses for the CI happy-path gate) —
    // a truncated/corrupted/zero-length file under the right name must FAIL here.
    const received = await awaitDelivery(recvDownloads, expected, 3000);
    const deliveredAll = received.size === expected.size;
    log(`delivery (filename pre-check): ${received.size}/${expected.size} files ${deliveredAll ? '(all names present)' : '(INCOMPLETE)'}`);
    const verifyFailures = await verifyDelivery(received, expected);
    log(`delivery (byte-identical verify): ${verifyFailures.length === 0 ? 'ALL OK' : `${verifyFailures.length} mismatch(es)`}`);
    if (terminal && terminalState !== 'completed') failures.push(`${label} REGRESSION: receiver's terminal state was '${terminalState}', not 'completed' — recovery must COMPLETE delivery, not just stop loud (the old F-B11 stall)`);
    if (!deliveredAll) failures.push(`${label} REGRESSION: delivery incomplete (${received.size}/${expected.size} files present) — the old 5/6 F-B11 dropped-file bug`);
    for (const f of verifyFailures) failures.push(`${label} REGRESSION: byte-identical verify failed — ${f}`);

    return { pass: failures.length === 0, failures };
  } finally {
    await delay(500); await cleanupAll(); await delay(300);
  }
}

// F-A7: a SENDER user-cancel must reach the receiver as a `cancel` frame so the
// receiver terminates 'canceled', NOT a lingering (auto-resuming) 'interrupted'.
// Unlike the transport faults this isn't ftTestFault — it's the real
// transfer:cancel IPC path. Asserts the receiver logs recv ev=canceled and never
// recv ev=interrupted.
async function runFA7() {
  const { cleanups, cleanupAll, tmp } = makeAttemptContext();
  try {
    const signalingUrl = await startSignaling(cleanups);
    const { srcDir, expected } = await writeFaultPayload(await tmp('fault-src-'));
    log(`F-A7: payload ${expected.size} files; flowCount=${FLOW_COUNT}`);

    const { sendWs, hostId, hostPw, sendChild, recvChild } =
      await bringUpPair({ signalingUrl, cleanups, tmp, extraEnv: { FARSIGHT_TEST_HOOKS: '1' } });

    const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({ target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT }, paths: [srcDir] })})`);
    if (!sendRes || sendRes.error || !sendRes.jobId) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));
    const jobId = sendRes.jobId;

    // Cancel MID-transfer (once bytes are flowing).
    await awaitLogLine(sendChild, /send ev=progress/, 20000);
    log('transfer flowing; issuing USER cancel on the sender...');
    await cdpEval(sendWs, `window.farsightIpc.transferCancel(${JSON.stringify(jobId)})`);

    const failures = [];
    // The receiver must terminate 'canceled' (loud + deliberate), within timeout.
    const canceled = await awaitLogLine(recvChild, /recv ev=canceled/, WAIT_MS);
    log('receiver canceled event:', canceled ? 'YES' : 'NO');
    if (!canceled) failures.push('F-A7: receiver never recorded ev=canceled after a sender cancel');
    // And it must NOT fall back to the resumable 'interrupted' (the field bug).
    const interrupted = recvChild.lines.some((l) => /recv ev=interrupted/.test(l));
    if (interrupted) failures.push('F-A7 REGRESSION: receiver saw ev=interrupted (a sender cancel that arrived as a bare channel drop — auto-resumes a canceled transfer)');

    return { pass: failures.length === 0, failures };
  } finally {
    await delay(500); await cleanupAll(); await delay(300);
  }
}

// F-B6 (Phase 3b): a flow that re-dials INTO a HELD consent window must be
// BUFFERED (not dropped) and attached once the user accepts, then deliver N/N.
// Pre-3b a flow offered before the receive was 'accepted' was dropped (no active
// receiver keyed by groupId yet) → a lost flow slot. Needs the held consent, so
// it drives its own flow rather than reusing runScenario. Asserts the same
// byte-identical-N/N + terminal-'completed' contract as fb1/fb2, PLUS that a
// `rolling-join buffered` line appears (proof the flow was held, not dropped).
async function runFB6() {
  const { cleanups, cleanupAll, tmp } = makeAttemptContext();
  try {
    const signalingUrl = await startSignaling(cleanups);
    const { srcDir, expected } = await writeFaultPayload(await tmp('fault-src-'));
    log(`F-B6: payload ${expected.size} files; flowCount=${FLOW_COUNT}`);
    const { sendWs, recvWs, hostId, hostPw, recvDownloads, recvChild } =
      await bringUpPair({ signalingUrl, cleanups, tmp, extraEnv: { FARSIGHT_TEST_HOOKS: '1' }, armConsent: false });
    await armConsentHold(recvWs, 8000); // hold consent 8s — the race window

    const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({ target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT }, paths: [srcDir] })})`);
    if (!sendRes || sendRes.error) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));

    // Wait until the group has formed and the receiver is showing the (held)
    // consent prompt, then drop a non-anchor SENDER flow. The sender's supervisor
    // sees the terminal signaling error and re-dials that slot (~backoff[0]=500ms)
    // INTO the held consent window → the re-dialed flow arrives at the receiver
    // while the receive is PENDING (receivePending set, attach still null, since
    // consent hasn't resolved) → offerRollingJoin must BUFFER it, not drop it, and
    // attach it once the user accepts (F-B6). DIAGNOSIS: the re-dial that produces
    // the raced flow is SENDER-supervisor-owned (transfer-flow-supervisor: a
    // dropFlowSocket surfaces a terminal 'error:' → scheduleRedial), so the drop
    // is injected on the SENDER (side:'send') — a receive-side drop would not make
    // the sender re-dial, and the fault registry is per-process anyway.
    // Trigger on 'consent prompt shown' SPECIFICALLY (not the earlier
    // 'incoming transfer_request', which fires per-flow during rendezvous BEFORE
    // the group forms): by the time the prompt is shown the group has already
    // fired onGroupReady and runMultiFlowReceive has set receivePending with a
    // NULL attach (consent unresolved) — so the re-dialed flow that lands next
    // takes offerRollingJoin's BUFFER branch. Injecting earlier (proven on the
    // first run) let the fast ~500ms re-dial rejoin the still-forming rendezvous
    // as a normal 4/4 join → no buffered line, the transfer just completed.
    const shown = await awaitLogLine(recvChild, /consent prompt shown|recv ev=accepted/, 20000);
    log('F-B6 consent window open:', shown ? 'YES' : 'NO (timed out)');
    const injected = await injectUntilLands(sendWs, { cmd: 'dropFlowSocket', side: 'send', flowIndex: 1 });
    log('F-B6 dropFlowSocket(send flow 1) =>', injected);

    const failures = [];
    // The buffered-then-attached join must be visible in the receiver log.
    const buffered = await awaitLogLine(recvChild, /rolling-join buffered/, 20000);
    log('F-B6 rolling-join buffered:', buffered ? 'YES' : 'NO');
    if (!buffered) failures.push('F-B6: no "rolling-join buffered" — a flow racing consent was not held (regression: dropped)');
    // Terminal completed + byte-identical N/N (same contract as fb1/fb2).
    const terminal = await awaitLogLine(recvChild, /recv ev=(completed|interrupted|failed|canceled)/, WAIT_MS);
    const terminalState = terminal ? (terminal.match(/recv ev=(completed|interrupted|failed|canceled)/) || [])[1] : null;
    log('F-B6 receiver terminal outcome:', terminal ? terminalState : 'NONE (HANG!)');
    if (!terminal) failures.push('F-B6 HANG: no terminal state within timeout');
    if (terminal && terminalState !== 'completed') failures.push(`F-B6: terminal '${terminalState}', not 'completed'`);
    const received = await awaitDelivery(recvDownloads, expected, 3000);
    const verifyFailures = await verifyDelivery(received, expected);
    if (received.size !== expected.size) failures.push(`F-B6: delivery incomplete ${received.size}/${expected.size}`);
    for (const f of verifyFailures) failures.push(`F-B6: byte verify failed — ${f}`);
    return { pass: failures.length === 0, failures };
  } finally { await delay(500); await cleanupAll(); await delay(300); }
}

// F-B7 (Phase 4, chunk manifest): corrupt already-written, already-VERIFIED chunks
// of a receive .part ON DISK mid-transfer. Live per-chunk verify passed them (they
// were clean on the wire), so they sit corrupt until the whole-file finalize hash
// catches the mismatch -> the receiver LOCATES the bad chunks (hash each vs the
// file_hashes manifest), punches ONLY those out of coverage, and the gap-drive loop
// re-sends ONLY them. Asserts: a verify mismatch was detected (recv ev=file-failed),
// then byte-identical N/N + recv ev=completed. The harness corrupts the .part
// directly (libuv opens files with permissive Windows share flags) — no app hook.
async function runFB7() {
  const { cleanups, cleanupAll, tmp } = makeAttemptContext();
  try {
    const signalingUrl = await startSignaling(cleanups);
    const { srcDir, expected } = await writeFaultPayload(await tmp('fault-src-'));
    log(`F-B7: payload ${expected.size} files; flowCount=${FLOW_COUNT}`);
    const { sendWs, hostId, hostPw, recvDownloads, sendChild, recvChild } =
      await bringUpPair({ signalingUrl, cleanups, tmp, extraEnv: { FARSIGHT_TEST_HOOKS: '1' } });

    const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({ target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT }, paths: [srcDir] })})`);
    if (!sendRes || sendRes.error) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));

    // Wait until bytes are flowing, then let the early chunks land on disk.
    await awaitLogLine(sendChild, /send ev=progress/, 20000);
    await delay(700);
    const partPath = await findPartFile(recvDownloads, 'huge.bin.part');
    if (!partPath) throw new Error('F-B7: huge.bin.part not found under recvDownloads (transfer finalized already? make the payload bigger / corrupt sooner)');
    // Corrupt a SPREAD of chunks: the already-received ones stick (covered, not
    // re-requested until locate); ones not yet received get overwritten clean by
    // the real chunk. At least the early ones are on disk here -> a finalize mismatch.
    const corruptChunks = [5, 40, 80, 120];
    const fh = await fsOpen(partPath, 'r+');
    try { for (const idx of corruptChunks) await fh.write(Buffer.alloc(4096, 0xEE), 0, 4096, idx * CHUNK); }
    finally { await fh.close(); }
    log(`F-B7 corrupted chunks ${corruptChunks.join(',')} of ${partPath}`);

    const failures = [];
    // (1) A finalize mismatch must be DETECTED and the locate path must run: the
    // receiver emits file-failed on a verify mismatch before repairing. Absent ->
    // the corruption didn't land in time (tune delay/payload); a false green otherwise.
    const repaired = await awaitLogLine(recvChild, /ev=file-failed/, WAIT_MS);
    log('F-B7 verify mismatch detected (locate ran):', repaired ? 'YES' : 'NO');
    if (!repaired) failures.push('F-B7: no "ev=file-failed" on the receiver — corruption not detected (locate never ran; tune timing/payload)');
    // (2) Repair must COMPLETE byte-identical.
    const terminal = await awaitLogLine(recvChild, /recv ev=(completed|interrupted|failed|canceled)/, WAIT_MS);
    const terminalState = terminal ? (terminal.match(/recv ev=(completed|interrupted|failed|canceled)/) || [])[1] : null;
    log('F-B7 receiver terminal:', terminal ? terminalState : 'NONE (HANG!)');
    if (!terminal) failures.push('F-B7 HANG: no terminal state within timeout');
    if (terminal && terminalState !== 'completed') failures.push(`F-B7: terminal '${terminalState}', not 'completed' — locate/repair did not complete delivery`);
    const received = await awaitDelivery(recvDownloads, expected, 5000);
    const verifyFailures = await verifyDelivery(received, expected);
    if (received.size !== expected.size) failures.push(`F-B7: delivery incomplete ${received.size}/${expected.size}`);
    for (const f of verifyFailures) failures.push(`F-B7: byte verify failed — ${f}`);
    // (3) CHUNK-GRANULAR proof: the repair must re-send only a handful of chunks, NOT
    // re-download the whole ~208-chunk huge.bin. Sum the final per-initiator-worker
    // bulkOut (chunks sent). A clean run of this payload is ~208; a whole-file
    // resetFile re-download of huge.bin would add ~200 -> ~400+. Threshold 300 fails
    // that regression while leaving generous slack for the handful of repaired chunks.
    // (Without this, a resetFile regression would still complete byte-identical and
    // pass — this is what pins the Phase-4 value on the real wire.)
    const perWorker = new Map();
    for (const line of sendChild.lines) {
      const m = line.match(/"workerId":"([^"]+)"[^}]*"role":"initiator"[^}]*"bulkOut":(\d+)/);
      if (m) perWorker.set(m[1], Math.max(perWorker.get(m[1]) || 0, Number(m[2])));
    }
    const totalChunksSent = [...perWorker.values()].reduce((a, b) => a + b, 0);
    log(`F-B7 total chunks sent across flows: ${totalChunksSent} (clean baseline ~208; whole-file re-download ~400+)`);
    if (totalChunksSent > 300) failures.push(`F-B7: re-sent too much (${totalChunksSent} chunks) — looks like a whole-file re-download, not chunk-granular repair`);
    return { pass: failures.length === 0, failures };
  } finally { await delay(500); await cleanupAll(); await delay(300); }
}

async function main() {
  const scenarios = {
    // F-B1: the transfer signaling socket reports its own failure.
    fb1: () => runScenario({ label: 'F-B1', fault: { cmd: 'dropFlowSocket', side: 'send', flowIndex: 1 }, surfacedRegex: /conn:error:signaling_(error|dropped|closed|timeout)/ }),
    // F-B2: a worker RENDERER CRASH is detected (render-process-gone).
    fb2: () => runScenario({ label: 'F-B2', fault: { cmd: 'killWorker', side: 'send', flowIndex: 1 }, surfacedRegex: /worker-gone:|error:worker_/ }),
    // F-B3: an oversize ctrl frame throws + kills the channel — surfaced, not swallowed.
    fb3: () => runScenario({ label: 'F-B3', fault: { cmd: 'injectOversizeCtrl', side: 'send', flowIndex: 1, bytes: 300000 }, surfacedRegex: /error:dc_ft-ctrl|error:ctrl_send/ }),
    // F-B5 (Phase 3b): flow 0 on the RECEIVE side dies mid-transfer. Pre-3b, a
    // flow-0 death that collapsed the group aborted the ENTIRE receive (no anchor
    // → null bundle). Post-3b the anchor-driven rendezvous waits out anchorWaitMs
    // for the sender's re-dialed flow 0, then completes N/N. runScenario injects
    // after `send ev=progress`, so flow 0 has already carried the OFFER — this is a
    // mid-transfer flow-0 RE-DIAL on the receive side (a strict superset stressor;
    // the pre-consent anchor-WAIT timing is proven deterministically by Task 1's
    // rendezvous unit tests + fb6). Same LOUD+BOUNDED+COMPLETE contract as fb1/fb2.
    fb5: () => runScenario({ label: 'F-B5', fault: { cmd: 'dropFlowSocket', side: 'receive', flowIndex: 0 }, surfacedRegex: /conn:error:signaling_(error|dropped|closed|timeout)/ }),
    // F-B6 (Phase 3b): a flow that races a HELD consent window is buffered, not dropped.
    fb6: runFB6,
    // F-B7 (Phase 4): corrupt on-disk chunks -> finalize mismatch -> locate + re-drive only bad chunks.
    fb7: runFB7,
    // F-A7: sender user-cancel → receiver 'canceled', not lingering 'interrupted'.
    fa7: runFA7,
  };
  const run = scenarios[SCENARIO];
  if (!run) { console.error('unknown SPIKE_SCENARIO: ' + SCENARIO); process.exit(2); }
  try {
    const { pass, failures } = await run();
    if (pass) { console.log(`\n=== FAULT-E2E ${SCENARIO}: PASS — the injected fault was surfaced LOUD, the transfer reached a bounded terminal outcome (never a zombie), AND delivery completed byte-identical N/N ===`); process.exit(0); }
    console.error(`\n=== FAULT-E2E ${SCENARIO}: FAIL ===`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  } catch (e) {
    console.error(`\n=== FAULT-E2E ${SCENARIO}: ERROR ===\n`, e && e.stack ? e.stack : e);
    process.exit(1);
  }
}
main();
