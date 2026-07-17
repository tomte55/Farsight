// packages/controller/test/received-dir.probe.mjs
// Positive-proof probe for the configurable received-files folder + disk-space
// check. Models shell-launch.probe.mjs (a show:false BrowserWindow driven over
// CDP) — vitest's node environment cannot execute a Chromium module graph, which
// is exactly where this project's DOA releases hid (CSP importmap / missing
// shared export). We require POSITIVE proof from the REAL packaged-shape renderer:
//   1. window.__farsightShellReady — the renderer ran to completion.
//   2. farsightIpc.getReceivedDir() resolves an ABSOLUTE default path end-to-end
//      (config -> main IPC -> preload -> renderer), proving the whole chain.
//   3. The NEW shared export classifyDiskSpace resolves in the real Chromium
//      module graph and classifies insufficient/low-margin/ok/unknown correctly
//      (the missing-shared-export DOA class — importmap-resolved, not node).
//   4. The new DOM elements exist (settings row + consent space/warning).
//
// Run:  node packages/controller/test/received-dir.probe.mjs
// Exit: 0 = all proofs held.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 9334; // distinct from shell-launch.probe.mjs (9333) so they can run back-to-back
const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronBin = fileURLToPath(new URL('../../../node_modules/electron/dist/electron.exe', import.meta.url));
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: appDir, stdio: 'inherit' });

const fail = (msg) => { console.error(`PROBE FAIL: ${msg}`); child.kill(); process.exit(1); };

try {
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await delay(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
      if (page) { target = page; break; }
    } catch { /* not listening yet */ }
  }
  if (!target) fail('renderer target never appeared on the CDP endpoint');

  const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
  if (!WebSocket) fail("the probe needs 'ws' — run it from the repo root where ws is hoisted");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

  const evaluate = (expression, awaitPromise = false) => new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      resolve(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
  });

  // 1. Renderer ran to completion.
  let ready = null;
  for (let i = 0; i < 20; i += 1) {
    const r = await evaluate('window.__farsightShellReady || null');
    if (r?.result?.value) { ready = r.result.value; break; }
    await delay(250);
  }
  if (!ready) fail('window.__farsightShellReady never appeared — the renderer did NOT run to completion');

  // 2. getReceivedDir() end-to-end -> absolute default path.
  const dirRes = await evaluate('window.farsightIpc.getReceivedDir()', true);
  const receivedDir = dirRes?.result?.value;
  if (typeof receivedDir !== 'string' || receivedDir.trim() === '') fail(`getReceivedDir() returned ${JSON.stringify(receivedDir)}`);
  const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(receivedDir) || receivedDir.startsWith('/') || receivedDir.startsWith('\\\\');
  if (!looksAbsolute) fail(`getReceivedDir() is not an absolute path: ${receivedDir}`);
  if (!/Farsight/i.test(receivedDir) || !/Received/i.test(receivedDir)) fail(`default path is unexpected: ${receivedDir}`);

  // 3. The new shared export resolves in the REAL packaged renderer + classifies.
  const GiB = 1024 * 1024 * 1024;
  const classifyExpr = `(async () => {
    const m = await import('../shared/transfer-rate.js');
    if (typeof m.classifyDiskSpace !== 'function') return { ok: false, why: 'not a function' };
    const c = (t, f) => m.classifyDiskSpace({ totalBytes: t, freeBytes: f, lowMarginBytes: ${GiB} }).status;
    return {
      ok: true,
      insufficient: c(5 * ${GiB}, 1e6),
      lowMargin: c(1, 1 + (${GiB} - 1)),
      okStatus: c(1, 1 + ${GiB}),
      unknown: c(10, null),
    };
  })()`;
  const clsRes = await evaluate(classifyExpr, true);
  const cls = clsRes?.result?.value;
  if (!cls || !cls.ok) fail(`classifyDiskSpace did not resolve in the packaged renderer: ${JSON.stringify(clsRes)}`);
  if (cls.insufficient !== 'insufficient') fail(`expected insufficient, got ${cls.insufficient}`);
  if (cls.lowMargin !== 'low-margin') fail(`expected low-margin, got ${cls.lowMargin}`);
  if (cls.okStatus !== 'ok') fail(`expected ok, got ${cls.okStatus}`);
  if (cls.unknown !== 'unknown') fail(`expected unknown, got ${cls.unknown}`);

  // 4. New DOM elements exist.
  const domExpr = `JSON.stringify(['settings-received-dir','menu-change-received-dir','menu-reset-received-dir','transfer-consent-space','transfer-consent-warning'].filter((id) => !document.getElementById(id)))`;
  const domRes = await evaluate(domExpr);
  const missing = JSON.parse(domRes?.result?.value || '[]');
  if (missing.length) fail(`missing DOM elements: ${missing.join(', ')}`);

  console.log('PROBE PASS:', JSON.stringify({ receivedDir, classify: cls }));
  ws.close();
  child.kill();
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
