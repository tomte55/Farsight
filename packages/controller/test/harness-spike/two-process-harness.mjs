// packages/controller/test/harness-spike/two-process-harness.mjs
// ============================================================================
// REAL-WIRE, headless, two-process file-transfer harness — the Windows CI gate
// (Plan 1b Task 2). Proves (vs multiflow-e2e-headless.test.js which FAKES the
// wire) that TWO separate real Electron app processes (sender + receiver), each
// with its own userData / single-instance lock, driven only over CDP, deliver a
// multi-flow (>=4) multi-chunk multi-file payload byte-identical over REAL
// RTCPeerConnections + a REAL loopback signaling server.
//
// All the launch/CDP/payload/verify plumbing lives in harness-lib.mjs (shared
// with the fault-injection harnesses). This file is just the CI scenario:
// bring up a pair, send, verify byte-identical delivery, retry once.
//
// Env knobs (all optional):
//   SPIKE_FLOWS            flow count (default 4; SPIKE_FLOWS=1 = single-flow self-test)
//   SPIKE_WAIT_MS          delivery wait (default 120000 — generous for cold CI)
//   SPIKE_STARTUP_TIMEOUT_MS  per-startup-poll timeout (default 60000)
//   SPIKE_NO_RETRY=1       fail on the first attempt (no retry) — for local iteration
// ============================================================================
import {
  log, delay, makeAttemptContext, startSignaling, writeStandardPayload,
  bringUpPair, cdpEval, awaitDelivery, verifyDelivery,
} from './harness-lib.mjs';

const FLOW_COUNT = Number(process.env.SPIKE_FLOWS) || 4;
const WAIT_MS = Number(process.env.SPIKE_WAIT_MS) || 120000;
const NO_RETRY = process.env.SPIKE_NO_RETRY === '1';

async function runAttempt(attemptNum) {
  const { cleanups, cleanupAll, tmp } = makeAttemptContext();
  try {
    log(`=== attempt ${attemptNum} === FLOW_COUNT=${FLOW_COUNT} (SPIKE_FLOWS=1 for the single-flow self-test).`);
    if (FLOW_COUNT > 1) log('NOTE: multi-flow is the F-B10 regression guard — must go byte-identical GREEN.');

    const signalingUrl = await startSignaling(cleanups);
    log('signaling listening on', signalingUrl);

    const { srcDir, expected, totalBytes } = await writeStandardPayload(await tmp('spike-src-'));
    log(`payload: ${expected.size} files, ${totalBytes} bytes`);

    const { sendWs, recvWs, hostId, hostPw, recvDownloads } = await bringUpPair({ signalingUrl, cleanups, tmp });

    log('issuing transfer:send with flowCount=' + FLOW_COUNT);
    const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({ target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT }, paths: [srcDir] })})`);
    if (!sendRes || sendRes.error) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));

    const received = await awaitDelivery(recvDownloads, expected, WAIT_MS);
    const failures = await verifyDelivery(received, expected);
    const accepted = await cdpEval(recvWs, 'JSON.stringify(window.__spikeAccepted || [])');
    log('consent auto-accepted jobIds:', accepted);
    return { pass: failures.length === 0, failures };
  } finally {
    await delay(500); await cleanupAll(); await delay(300);
  }
}

async function main() {
  const maxAttempts = NO_RETRY ? 1 : 2;
  let lastFailures = [], lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { pass, failures } = await runAttempt(attempt);
      if (pass) {
        console.log('\n=== SPIKE RESULT: PASS — real multi-flow WebRTC transfer delivered byte-identical, headless, two-process ===');
        process.exitCode = 0; return;
      }
      lastFailures = failures; lastError = null;
      log(`attempt ${attempt} FAILED (${failures.length} issue(s)).`);
    } catch (e) {
      lastError = e; lastFailures = [];
      log(`attempt ${attempt} THREW: ${e && e.stack ? e.stack : e}`);
    }
    if (attempt < maxAttempts) log('retrying once before declaring failure...');
  }
  console.error('\n=== SPIKE RESULT: FAIL ===');
  if (lastError) console.error('  - ' + (lastError.message || lastError));
  else for (const f of lastFailures) console.error('  - ' + f);
  process.exitCode = 1;
}

main().catch((e) => { console.error('\n=== SPIKE RESULT: ERROR ===\n', e); process.exitCode = 1; })
  .finally(() => { process.exit(process.exitCode || 0); });
