// packages/controller/test/harness-spike/harness-lib.mjs
// Shared building blocks for the REAL-WIRE, two-process transfer harnesses
// (the CI-gating two-process-harness.mjs and the Plan-1b fault-injection
// harnesses). Extracted verbatim from the spike harness so there is ONE
// implementation of the CDP/launch/payload plumbing (R7): launch two real
// Electron app processes, drive each over CDP, run a real loopback signaling
// server, and verify byte-identical delivery on the receiver's real disk.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createSignalingServer } from '../../../signaling-server/src/server.js';

export { delay, mkdtemp, rm, writeFile, readFile, mkdir, readdir, writeFileSync, tmpdir, join, createSignalingServer };

export const STARTUP_TIMEOUT_MS = Number(process.env.SPIKE_STARTUP_TIMEOUT_MS) || 60000;
export const CHUNK = 131072; // must match the transfer chunk size for a true multi-chunk file
export const appDir = fileURLToPath(new URL('../..', import.meta.url)); // packages/controller
export const electronBin = fileURLToPath(new URL('../../../../node_modules/electron/dist/electron.exe', import.meta.url));

// GPU-less-runner-safe flags. The transfer workers are show:false and the
// data-channel/disk-I/O path needs no GPU; SwiftShader avoids a real GL/ANGLE
// context on CI boxes that have no GPU driver.
export const GPU_FLAGS = ['--disable-gpu', '--use-gl=swiftshader', '--in-process-gpu'];

export const log = (...a) => console.log(`[harness ${new Date().toISOString().slice(11, 23)}]`, ...a);

// ---------- CDP helpers (same pattern as the existing *.probe.mjs) ----------
export async function cdpTargetFor(port, match, timeoutMs = STARTUP_TIMEOUT_MS) {
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
export async function cdpOpen(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ws;
}
export function cdpEval(ws, expression) {
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
export async function pollEval(ws, expression, { timeoutMs = STARTUP_TIMEOUT_MS, intervalMs = 400 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await cdpEval(ws, expression);
    if (v) return v;
    await delay(intervalMs);
  }
  throw new Error(`pollEval timed out: ${expression}`);
}

// ---------- renderer console/error capture (diagnostic only) ----------
export function attachConsoleCapture(ws, label) {
  const lines = [];
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ');
      lines.push(`[${label} console.${m.params.type}] ${args}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      const detail = d.exception ? (d.exception.description || d.exception.value) : '';
      lines.push(`[${label} exception] ${d.text || ''} ${detail}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {};
      lines.push(`[${label} log.${e.level}] ${e.text}`);
    }
  });
  ws.send(JSON.stringify({ id: -1, method: 'Runtime.enable' }));
  ws.send(JSON.stringify({ id: -2, method: 'Log.enable' }));
  return { getLines: () => lines.slice() };
}

// ---------- dynamic CDP port: read Electron's own DevToolsActivePort file ----------
export async function readDevToolsPort(userDataDir, timeoutMs = STARTUP_TIMEOUT_MS) {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const content = await readFile(portFile, 'utf8');
      const port = parseInt(content.split('\n')[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* file not written yet */ }
    await delay(200);
  }
  throw new Error(`DevToolsActivePort never appeared under ${userDataDir} within ${timeoutMs}ms`);
}

// ---------- launch one Electron app instance (dynamic debug port) ----------
export function launchApp(name, { userDataDir, signalingUrl, extraEnv = {} }, cleanups) {
  const child = spawn(electronBin, [
    '.',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...GPU_FLAGS,
  ], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FARSIGHT_SIGNALING_URL: signalingUrl, ...extraEnv },
  });
  // Ring buffer of recent app-log lines (stdout+stderr) so a scenario can assert
  // a fault was OBSERVED — e.g. the ft-worker "conn:error:signaling_dropped" event
  // that proves F-B1 surfaced the socket failure instead of hanging.
  child.lines = [];
  const collect = (prefix) => (d) => {
    const s = String(d);
    process.stdout.write(`[${name} ${prefix}] ${s}`);
    for (const ln of s.split('\n')) { if (ln.trim()) { child.lines.push(ln); if (child.lines.length > 4000) child.lines.shift(); } }
  };
  child.stdout.on('data', collect('out'));
  child.stderr.on('data', collect('err'));
  cleanups.push(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
  return child;
}

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
export async function walkDir(dir) {
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

// ---------- a real loopback signaling server (generous rate limits for tests) ----------
export async function startSignaling(cleanups) {
  const srv = createSignalingServer({
    port: 0,
    config: { maxAttempts: 50, windowMs: 60000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', connectBurst: 50, msgBurst: 400, msgPerSec: 400, sessionTimeoutMs: 30000 },
  });
  await new Promise((r) => srv.wss.once('listening', r));
  const port = srv.wss.address().port;
  cleanups.push(() => srv.close());
  return `ws://127.0.0.1:${port}`;
}

// ---------- standard multi-file / multi-chunk / nested payload ----------
// Returns { srcDir, expected: Map<basename,{size,hash}>, totalBytes }.
export async function writeStandardPayload(srcRoot) {
  const srcDir = join(srcRoot, 'payload'); // a FOLDER so the walk is exercised
  await mkdir(srcDir, { recursive: true });
  const files = {
    'big.bin': new Uint8Array(CHUNK * 3 + 211).map((_, i) => (i * 41 + 7) & 0xff),   // 4 chunks
    'med.bin': new Uint8Array(CHUNK * 2 + 5).map((_, i) => (i * 17 + 3) & 0xff),      // 3 chunks
    'small1.bin': new Uint8Array(2000).map((_, i) => (i * 13) & 0xff),
    'small2.bin': new Uint8Array(37).fill(9),
    'sub/nested.bin': new Uint8Array(CHUNK + 99).map((_, i) => (i * 7 + 1) & 0xff),   // 2 chunks, nested
  };
  const expected = new Map();
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(srcDir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, data);
    expected.set(rel.split('/').pop(), { size: data.length, hash: sha256(Buffer.from(data)) });
  }
  const totalBytes = Object.values(files).reduce((a, b) => a + b.length, 0);
  return { srcDir, expected, totalBytes };
}

// ---------- bring a fresh RECEIVER + SENDER up and ready to transfer ----------
// Launches both apps, waits for host registration, arms auto-accept on the
// receiver, waits for sender shell-ready. Returns everything a scenario needs:
// { sendWs, recvWs, hostId, hostPw, recvDownloads, ports }.
export async function bringUpPair({ signalingUrl, cleanups, tmp, extraEnv = {}, armConsent = true }) {
  const recvUserData = await tmp('spike-recv-ud-');
  const sendUserData = await tmp('spike-send-ud-');
  const recvDownloads = await tmp('spike-recv-dl-');
  writeFileSync(join(recvUserData, 'config.json'), JSON.stringify({ receivedFilesDir: recvDownloads, controlAllowed: true }), { mode: 0o600 });

  log('launching RECEIVER...');
  const recvChild = launchApp('recv', { userDataDir: recvUserData, signalingUrl, extraEnv }, cleanups);
  log('launching SENDER...');
  const sendChild = launchApp('send', { userDataDir: sendUserData, signalingUrl, extraEnv }, cleanups);

  const [recvPort, sendPort] = await Promise.all([readDevToolsPort(recvUserData), readDevToolsPort(sendUserData)]);
  log(`resolved dynamic debug ports: recv=${recvPort} send=${sendPort}`);

  const recvWs = await cdpOpen(await cdpTargetFor(recvPort, 'renderer/index.html'));
  attachConsoleCapture(recvWs, 'recv');
  await pollEval(recvWs, 'window.__farsightShellReady && window.__farsightShellReady.hostRegistering === true');
  const hostId = await pollEval(recvWs, "(document.getElementById('cred-id')||{}).dataset ? document.getElementById('cred-id').dataset.copyValue : null");
  const hostPw = await pollEval(recvWs, "(document.getElementById('cred-pw')||{}).dataset ? document.getElementById('cred-pw').dataset.copyValue : null");
  if (!hostId || hostId === '…' || !hostPw || hostPw === '…') throw new Error('failed to read host id/pw from receiver');
  log('receiver registered: hostId=', hostId);

  // onTransferConsent APPENDS a listener (preload.cjs: ipcRenderer.on), it does
  // NOT replace — so arming the instant auto-accept here AND re-arming a held
  // variant later would DOUBLE-fire respondConsent. F-B6 needs the HELD variant,
  // so it passes armConsent:false to skip this default and calls armConsentHold
  // itself (exactly one consent listener from the harness either way).
  if (armConsent) {
    await cdpEval(recvWs, `
      window.__spikeAccepted = [];
      window.farsightIpc.onTransferConsent((req) => {
        window.__spikeAccepted.push(req.jobId);
        window.farsightIpc.respondConsent({ jobId: req.jobId, accept: true });
      });
      true
    `);
    log('auto-accept armed on receiver');
  } else {
    log('auto-accept NOT armed (armConsent:false — caller arms consent itself)');
  }

  const sendWs = await cdpOpen(await cdpTargetFor(sendPort, 'renderer/index.html'));
  attachConsoleCapture(sendWs, 'send');
  await pollEval(sendWs, 'window.__farsightShellReady ? true : null');
  log('sender renderer ready');

  return { sendWs, recvWs, hostId, hostPw, recvDownloads, sendChild, recvChild };
}

// ---------- F-B6 harness: HELD consent (delayed auto-accept) ----------
// Replaces the receiver's instant auto-accept with one that HOLDS the consent
// prompt open for holdMs before accepting — the window during which a re-dialed
// flow must be BUFFERED (not dropped). Records jobIds like the default. Call
// AFTER bringUpPair({ …, armConsent:false }) so exactly one harness consent
// listener is active (onTransferConsent APPENDS — see bringUpPair).
export async function armConsentHold(recvWs, holdMs) {
  await cdpEval(recvWs, `
    window.__spikeAccepted = [];
    window.farsightIpc.onTransferConsent((req) => {
      window.__spikeAccepted.push(req.jobId);
      setTimeout(() => window.farsightIpc.respondConsent({ jobId: req.jobId, accept: true }), ${Number(holdMs)});
    });
    true
  `);
  log(`held consent armed on receiver (holdMs=${Number(holdMs)})`);
}

// ---------- poll the receiver's real disk until all expected files land ----------
export async function awaitDelivery(recvDownloads, expected, waitMs) {
  const deadline = Date.now() + waitMs;
  let received = new Map();
  while (Date.now() < deadline) {
    await delay(1000);
    received = new Map();
    for (const p of await walkDir(recvDownloads)) {
      if (p.endsWith('.part')) continue; // in-flight
      const base = p.split(/[\\/]/).pop();
      if (expected.has(base)) received.set(base, p);
    }
    if (received.size === expected.size) break;
    log(`  ...received ${received.size}/${expected.size} final files so far`);
  }
  return received;
}

// ---------- verify byte-identical delivery; returns a failures[] array ----------
export async function verifyDelivery(received, expected) {
  const failures = [];
  if (received.size !== expected.size) failures.push(`only ${received.size}/${expected.size} files delivered`);
  for (const [base, { size, hash }] of expected) {
    const p = received.get(base);
    if (!p) { failures.push(`MISSING: ${base}`); continue; }
    const buf = await readFile(p);
    if (buf.length !== size) { failures.push(`SIZE MISMATCH ${base}: got ${buf.length} want ${size}`); continue; }
    if (sha256(buf) !== hash) { failures.push(`HASH MISMATCH ${base}`); continue; }
    log(`  OK ${base}: ${size} bytes, sha256 matches`);
  }
  return failures;
}

// ---------- await an app-log line matching a regex (bounded) ----------
// Polls a launched child's captured `lines` ring buffer until one matches, or the
// timeout expires. Returns the matching line, or null on timeout.
export async function awaitLogLine(child, regex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = child.lines.find((l) => regex.test(l));
    if (hit) return hit;
    await delay(300);
  }
  return null;
}

// ---------- an isolated per-attempt scratch context (tmp dirs, cleanups) ----------
export function makeAttemptContext() {
  const cleanups = [];
  async function cleanupAll() { for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* ignore */ } } }
  async function tmp(prefix) { const d = await mkdtemp(join(tmpdir(), prefix)); cleanups.push(() => rm(d, { recursive: true, force: true })); return d; }
  return { cleanups, cleanupAll, tmp };
}
