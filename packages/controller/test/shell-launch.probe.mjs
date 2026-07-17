// packages/controller/test/shell-launch.probe.mjs
// Positive-proof launch probe for the unification step-1 shell.
//
// Run:  node packages/controller/test/shell-launch.probe.mjs
// Exit: 0 = the real renderer resolved its imports and ran to completion.
//
// NOT a vitest test: vitest runs environment:'node' and cannot execute a Chromium
// module graph, which is precisely where this project's two DOA releases hid
// (v1.9.0 CSP-blocked importmap, v1.10.0 missing shared export). A show:false
// BrowserWindow driven over CDP is the fastest way to exercise the packaged-shape
// renderer for real.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 9333;
// fileURLToPath, not URL.pathname — on Windows the latter yields "/C:/Users/…",
// which is not a path spawn() can cd into.
const appDir = fileURLToPath(new URL('..', import.meta.url));
// Spawn the electron binary directly rather than `npx electron .` through a
// shell. On win32, `npx.cmd` + shell:true launches a cmd.exe -> npx.cmd ->
// node -> electron.exe chain; child.kill()/taskkill against the top PID
// reliably left electron.exe running after the probe exited (verified live —
// tasklist still showed 4 electron.exe processes after kill + a multi-second
// wait). A later probe run's CDP /json/list fetch can then silently attach to
// that STALE process instead of a fresh one — exactly how the mutation test in
// Step 4 first gave a false PASS. Spawning electron.exe directly makes
// child.pid the real browser-process PID, whose own child processes (Chromium
// uses Windows Job Objects for GPU/renderer/utility) all terminate cleanly
// when it does.
const electronBin = fileURLToPath(new URL('../../../node_modules/electron/dist/electron.exe', import.meta.url));
const child = spawn(
  electronBin,
  ['.', `--remote-debugging-port=${PORT}`],
  { cwd: appDir, stdio: 'inherit' },
);

const fail = (msg) => { console.error(`PROBE FAIL: ${msg}`); child.kill(); process.exit(1); };

try {
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    await delay(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
      if (page) { targets = page; break; }
    } catch { /* not listening yet */ }
  }
  if (!targets) fail('renderer target never appeared on the CDP endpoint');

  const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
  if (!WebSocket) fail("the probe needs 'ws' — run it from the repo root where ws is hoisted");

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

  const evaluate = (expression) => new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      resolve(m.result?.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });

  // Give the module graph a beat to execute, then read the marker the renderer only
  // sets on its LAST line.
  let marker = null;
  for (let i = 0; i < 20; i += 1) {
    const r = await evaluate('window.__farsightShellReady || null');
    if (r && r.value) { marker = r.value; break; }
    await delay(250);
  }
  if (!marker) fail('window.__farsightShellReady never appeared — the renderer did NOT run to completion (check the CSP importmap hash and the shared exports)');

  const errors = ['home', 'fleet', 'people', 'transfers', 'settings'].filter((p) => !marker.pages.includes(p));
  if (errors.length) fail(`shell is missing pages: ${errors.join(', ')}`);
  if (marker.railItems !== 6) fail(`rail rendered ${marker.railItems} children, expected 6 (5 items + the gap)`);
  if (marker.statusSegments < 1) fail('status bar rendered no segments');

  console.log('PROBE PASS:', JSON.stringify(marker));
  ws.close();
  child.kill();
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
