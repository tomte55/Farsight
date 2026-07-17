// packages/controller/test/session-launch.probe.mjs
// Positive-proof: the SESSION window's renderer resolves its imports and runs to
// completion when the shell asks to open a session. A real connection can't
// complete without a host — but the module graph running is exactly the DOA class
// this guards (a CSP-blocked importmap or a missing shared export would leave the
// session window blank and silent). Spawns electron.exe directly (step-1 lesson:
// npx.cmd+shell left stale processes that gave a false PASS).
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 9355;
const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronBin = fileURLToPath(new URL('../../../node_modules/electron/dist/electron.exe', import.meta.url));
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: appDir, stdio: 'inherit',
  env: { ...process.env, FARSIGHT_SIGNALING_URL: 'ws://127.0.0.1:8080' },
});
const fail = (m) => { console.error(`PROBE FAIL: ${m}`); child.kill(); process.exit(1); };

async function targetFor(match) {
  for (let i = 0; i < 40; i += 1) {
    await delay(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(match));
      if (t) return t;
    } catch { /* not up */ }
  }
  return null;
}

try {
  const { default: WebSocket } = await import('ws');
  const openWs = async (t) => { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }); return ws; };
  const evalOn = (ws, expr) => new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6);
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== id) return; ws.off('message', on); resolve(m.result?.result?.value); };
    ws.on('message', on);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });

  const shell = await targetFor('renderer/index.html');
  if (!shell) fail('shell target never appeared');
  const shellWs = await openWs(shell);
  // wait for the shell to be ready, then ask it to open a session.
  for (let i = 0; i < 20; i += 1) { if (await evalOn(shellWs, '!!window.__farsightShellReady')) break; await delay(250); }
  await evalOn(shellWs, "window.farsightIpc.openSession({ targetId: '947188129', candidates: ['abc123'], linked: false }); true");

  const session = await targetFor('session-window/index.html');
  if (!session) fail('session window never opened after openSession');
  const sessWs = await openWs(session);
  let marker = null;
  for (let i = 0; i < 20; i += 1) { marker = await evalOn(sessWs, 'window.__farsightSessionReady || null'); if (marker) break; await delay(250); }
  if (!marker) fail('window.__farsightSessionReady never appeared — the session renderer did NOT run to completion (check its CSP importmap hash + shared exports)');
  if (!marker.hasVideo || !marker.hasScreen) fail(`session window missing elements: ${JSON.stringify(marker)}`);

  console.log('PROBE PASS:', JSON.stringify(marker));
  shellWs.close(); sessWs.close(); child.kill(); process.exit(0);
} catch (e) { fail(e && e.message ? e.message : String(e)); }
