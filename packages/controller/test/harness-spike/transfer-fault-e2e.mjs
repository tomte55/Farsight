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
//
// Env: SPIKE_FLOWS (default 4), SPIKE_WAIT_MS (default 90000), SPIKE_SCENARIO.
// ============================================================================
import {
  log, delay, makeAttemptContext, startSignaling, writeStandardPayload,
  bringUpPair, cdpEval, awaitDelivery, verifyDelivery, awaitLogLine, mkdir, writeFile, join, sha256, CHUNK,
} from './harness-lib.mjs';

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

    const { sendWs, hostId, hostPw, recvDownloads, sendChild, recvChild } =
      await bringUpPair({ signalingUrl, cleanups, tmp, extraEnv: { FARSIGHT_TEST_HOOKS: '1' } });

    const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({ target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT }, paths: [srcDir] })})`);
    if (!sendRes || sendRes.error) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));

    // Inject MID-TRANSFER (spec: "killWorker mid-transfer"). Wait until bytes are
    // actually flowing — a progress event — so every flow's renderer is fully
    // loaded + connected. Injecting during rendezvous is unreliable for a crash
    // (forcefullyCrashRenderer on a still-loading renderer may not fire
    // render-process-gone) and gives a less realistic test.
    await awaitLogLine(sendChild, /send ev=progress/, 20000);
    log(`transfer flowing; injecting ${fault.cmd} on flow ${fault.flowIndex}...`);

    const injected = await injectUntilLands(sendWs, fault);
    log(`${fault.cmd}(flow ${fault.flowIndex}) =>`, injected);

    const failures = [];
    if (typeof injected !== 'string' || !injected.includes('"ok":true')) failures.push(`${fault.cmd} never landed on a live flow-${fault.flowIndex} worker: ${injected}`);

    // (1) LOUD: the fault was surfaced in the sender's ft-worker log.
    const surfaced = await awaitLogLine(sendChild, surfacedRegex, 20000);
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

async function main() {
  const scenarios = {
    // F-B1: the transfer signaling socket reports its own failure.
    fb1: () => runScenario({ label: 'F-B1', fault: { cmd: 'dropFlowSocket', side: 'send', flowIndex: 1 }, surfacedRegex: /conn:error:signaling_(error|dropped|closed|timeout)/ }),
    // F-B2: a worker RENDERER CRASH is detected (render-process-gone).
    fb2: () => runScenario({ label: 'F-B2', fault: { cmd: 'killWorker', side: 'send', flowIndex: 1 }, surfacedRegex: /worker-gone:|error:worker_/ }),
    // F-B3: an oversize ctrl frame throws + kills the channel — surfaced, not swallowed.
    fb3: () => runScenario({ label: 'F-B3', fault: { cmd: 'injectOversizeCtrl', side: 'send', flowIndex: 1, bytes: 300000 }, surfacedRegex: /error:dc_ft-ctrl|error:ctrl_send/ }),
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
