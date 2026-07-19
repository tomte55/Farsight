// packages/controller/test/harness-spike/two-process-harness.mjs
// ============================================================================
// FEASIBILITY SPIKE (Plan 1b) — REAL-WIRE, headless, two-process file transfer.
// NOT wired into `npx vitest run`. Run directly:
//     node packages/controller/test/harness-spike/two-process-harness.mjs
//
// What this proves (vs multiflow-e2e-headless.test.js which FAKES the wire):
//   - TWO separate real Electron app processes (sender + receiver), each with
//     its own userData / single-instance lock, driven only over CDP.
//   - A REAL loopback signaling server (packages/signaling-server).
//   - The app's REAL transfer stack: transfer:send IPC -> createTransferService
//     -> assembleSendFlows -> N real transfer-worker hidden BrowserWindows, each
//     owning a REAL RTCPeerConnection + real WebRTC data channels.
//   - Multi-flow (>=4), multi-chunk, multi-file payload delivered byte-identical
//     to the receiver's real on-disk Received folder.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createSignalingServer } from '../../../signaling-server/src/server.js';

const FLOW_COUNT = Number(process.env.SPIKE_FLOWS) || 4;
const CHUNK = 131072; // must match transfer chunk size for a true multi-chunk file
const appDir = fileURLToPath(new URL('../..', import.meta.url)); // packages/controller
const electronBin = fileURLToPath(new URL('../../../../node_modules/electron/dist/electron.exe', import.meta.url));

const log = (...a) => console.log(`[harness ${new Date().toISOString().slice(11, 23)}]`, ...a);
const cleanups = [];
async function cleanupAll() { for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* ignore */ } } }
async function tmp(prefix) { const d = await mkdtemp(join(tmpdir(), prefix)); cleanups.push(() => rm(d, { recursive: true, force: true })); return d; }

// ---------- CDP helpers (same pattern as the existing *.probe.mjs) ----------
async function cdpTargetFor(port, match, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await delay(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(match));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch { /* not up yet */ }
  }
  throw new Error(`CDP target '${match}' never appeared on port ${port}`);
}
async function cdpOpen(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ws;
}
function cdpEval(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      if (m.error) return reject(new Error(`CDP eval error: ${JSON.stringify(m.error)}`));
      if (m.result && m.result.exceptionDetails) return reject(new Error(`eval threw: ${JSON.stringify(m.result.exceptionDetails)}`));
      resolve(m.result?.result?.value);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}
async function pollEval(ws, expression, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await cdpEval(ws, expression);
    if (v) return v;
    await delay(intervalMs);
  }
  throw new Error(`pollEval timed out: ${expression}`);
}

// ---------- launch one Electron app instance ----------
function launchApp(name, { userDataDir, port, signalingUrl, extraEnv = {} }) {
  const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
  ], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FARSIGHT_SIGNALING_URL: signalingUrl, ...extraEnv },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name} out] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name} err] ${d}`));
  cleanups.push(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
  return child;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
async function walkDir(dir) {
  const out = [];
  async function rec(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else out.push(p);
    }
  }
  try { await rec(dir); } catch { /* dir may not exist yet */ }
  return out;
}

async function main() {
  log(`FLOW_COUNT=${FLOW_COUNT} (set SPIKE_FLOWS=1 for the single-flow self-test).`);
  if (FLOW_COUNT > 1) {
    log('NOTE: this multi-flow run is the F-B10 regression guard. Before the fix, >1 flow');
    log('      HANGS at no_offer because the worker->main inbound listener was registered');
    log('      lazily and the manifest OFFER was dropped. transfer-worker.js now buffers');
    log('      inbound frames eagerly, so this must go byte-identical GREEN.');
  }
  // ---- 1. Real loopback signaling server ----
  const srv = createSignalingServer({
    port: 0,
    config: { maxAttempts: 50, windowMs: 60000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', connectBurst: 50, msgBurst: 400, msgPerSec: 400, sessionTimeoutMs: 30000 },
  });
  await new Promise((r) => srv.wss.once('listening', r));
  const sigPort = srv.wss.address().port;
  const signalingUrl = `ws://127.0.0.1:${sigPort}`;
  cleanups.push(() => srv.close());
  log('signaling listening on', signalingUrl);

  // ---- 2. Payload: multi-file, one multi-chunk file, into a source folder ----
  const srcRoot = await tmp('spike-src-');
  const srcDir = join(srcRoot, 'payload'); // send a FOLDER so the walk is exercised
  await mkdir(srcDir, { recursive: true });
  const files = {
    'big.bin': new Uint8Array(CHUNK * 3 + 211).map((_, i) => (i * 41 + 7) & 0xff),   // 4 chunks
    'med.bin': new Uint8Array(CHUNK * 2 + 5).map((_, i) => (i * 17 + 3) & 0xff),      // 3 chunks
    'small1.bin': new Uint8Array(2000).map((_, i) => (i * 13) & 0xff),
    'small2.bin': new Uint8Array(37).fill(9),
    'sub/nested.bin': new Uint8Array(CHUNK + 99).map((_, i) => (i * 7 + 1) & 0xff),   // 2 chunks, nested
  };
  const expected = new Map(); // basename -> {size, hash}
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(srcDir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, data);
    expected.set(rel.split('/').pop(), { size: data.length, hash: sha256(Buffer.from(data)) });
  }
  const totalBytes = Object.values(files).reduce((a, b) => a + b.length, 0);
  log(`payload: ${expected.size} files, ${totalBytes} bytes, biggest = ${CHUNK * 3 + 211} (${Math.ceil((CHUNK * 3 + 211) / CHUNK)} chunks)`);

  // ---- 3. userData dirs + receiver received-files dir (pre-seed config) ----
  const recvUserData = await tmp('spike-recv-ud-');
  const sendUserData = await tmp('spike-send-ud-');
  const recvDownloads = await tmp('spike-recv-dl-');
  // Pre-seed the receiver's config.json so received files land in a dir we control
  // (instead of the real OS Downloads/Farsight/Received). controlAllowed defaults ON.
  writeFileSync(join(recvUserData, 'config.json'), JSON.stringify({ receivedFilesDir: recvDownloads, controlAllowed: true }), { mode: 0o600 });

  const RECV_PORT = 9411;
  const SEND_PORT = 9412;

  // ---- 4. Launch both apps ----
  log('launching RECEIVER...');
  launchApp('recv', { userDataDir: recvUserData, port: RECV_PORT, signalingUrl });
  log('launching SENDER...');
  launchApp('send', { userDataDir: sendUserData, port: SEND_PORT, signalingUrl });

  // ---- 5. Drive receiver: wait for registration, read host id/pw, arm auto-accept ----
  const recvTarget = await cdpTargetFor(RECV_PORT, 'renderer/index.html');
  const recvWs = await cdpOpen(recvTarget);
  log('receiver renderer attached; waiting for host registration...');
  await pollEval(recvWs, 'window.__farsightShellReady && window.__farsightShellReady.hostRegistering === true');
  const hostId = await pollEval(recvWs, "(document.getElementById('cred-id')||{}).dataset ? document.getElementById('cred-id').dataset.copyValue : null");
  const hostPw = await pollEval(recvWs, "(document.getElementById('cred-pw')||{}).dataset ? document.getElementById('cred-pw').dataset.copyValue : null");
  log('receiver registered: hostId=', hostId, 'pw=', hostPw);
  if (!hostId || hostId === '…' || !hostPw || hostPw === '…') throw new Error('failed to read host id/pw from receiver renderer');

  // Arm auto-accept: add a SECOND transfer:consent listener (ipcRenderer.on allows
  // multiple) that accepts every incoming transfer. No production code changed.
  await cdpEval(recvWs, `
    window.__spikeAccepted = [];
    window.farsightIpc.onTransferConsent((req) => {
      window.__spikeAccepted.push(req.jobId);
      window.farsightIpc.respondConsent({ jobId: req.jobId, accept: true });
    });
    true
  `);
  log('auto-accept armed on receiver');

  // ---- 6. Drive sender: wait for shell ready, trigger the transfer ----
  const sendTarget = await cdpTargetFor(SEND_PORT, 'renderer/index.html');
  const sendWs = await cdpOpen(sendTarget);
  await pollEval(sendWs, 'window.__farsightShellReady ? true : null');
  log('sender renderer ready; issuing transfer:send with flowCount=' + FLOW_COUNT);
  const sendRes = await cdpEval(sendWs, `window.farsightIpc.transferSend(${JSON.stringify({
    target: { id: hostId, password: hostPw, flowCount: FLOW_COUNT },
    paths: [srcDir],
  })})`);
  log('transfer:send returned:', JSON.stringify(sendRes));
  if (!sendRes || sendRes.error) throw new Error('transfer:send failed: ' + JSON.stringify(sendRes));

  // ---- 7. Wait for byte-identical delivery on the receiver's real disk ----
  log('waiting for files to land in receiver dir:', recvDownloads);
  const deadline = Date.now() + (Number(process.env.SPIKE_WAIT_MS) || 90000);
  let received = new Map();
  while (Date.now() < deadline) {
    await delay(1000);
    const paths = await walkDir(recvDownloads);
    received = new Map();
    for (const p of paths) {
      if (p.endsWith('.part')) continue; // in-flight
      const base = p.split(/[\\/]/).pop();
      if (expected.has(base)) received.set(base, p);
    }
    if (received.size === expected.size) break;
    log(`  ...received ${received.size}/${expected.size} final files so far`);
  }

  // ---- 8. Assertions ----
  const failures = [];
  if (received.size !== expected.size) failures.push(`only ${received.size}/${expected.size} files delivered`);
  for (const [base, { size, hash }] of expected) {
    const p = received.get(base);
    if (!p) { failures.push(`MISSING: ${base}`); continue; }
    const buf = await readFile(p);
    if (buf.length !== size) { failures.push(`SIZE MISMATCH ${base}: got ${buf.length} want ${size}`); continue; }
    const h = sha256(buf);
    if (h !== hash) { failures.push(`HASH MISMATCH ${base}`); continue; }
    log(`  OK ${base}: ${size} bytes, sha256 matches`);
  }

  // Confirm consent actually fired (proves the ad-hoc trust path, not a bypass)
  const accepted = await cdpEval(recvWs, 'JSON.stringify(window.__spikeAccepted || [])');
  log('consent auto-accepted jobIds:', accepted);

  if (failures.length) {
    console.error('\n=== SPIKE RESULT: FAIL ===');
    for (const f of failures) console.error('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('\n=== SPIKE RESULT: PASS — real multi-flow WebRTC transfer delivered byte-identical, headless, two-process ===');
    process.exitCode = 0;
  }
}

main()
  .catch((e) => { console.error('\n=== SPIKE RESULT: ERROR ===\n', e); process.exitCode = 1; })
  .finally(async () => { await delay(500); await cleanupAll(); await delay(300); process.exit(process.exitCode || 0); });
