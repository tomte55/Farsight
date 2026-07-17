// packages/controller/test/host-capability.probe.mjs
// Positive-proof: the UNIFIED controller app also registers this machine as a
// controllable host, and the "Allow this computer to be controlled" toggle
// gates that registration for real (fail-closed posture) — not just cosmetically.
// Unification step 3, Task 9 — the final guard against a silent host-side DOA
// (the shell/session probes only prove the connect-OUT and be-controlled-window
// paths; this is the be-controlled-IN path).
//
// Two phases against ONE launch:
//   1. Launch with FARSIGHT_SIGNALING_URL set, control allowed (the default) ->
//      the marker must show the credential UI, the consent modal, and the
//      toggle all present in the DOM, AND that registration was attempted
//      (hostRegistering:true + the password chip populated).
//   2. Flip the toggle off through the REAL UI path (set the checkbox +
//      dispatch 'change', exactly like a click) -> registration must tear
//      down (hostRegistering:false), credentials must hide, and
//      getControlAllowed() must report false. This is the fail-closed
//      guarantee: control off means genuinely no registration, not merely a
//      hidden panel.
//
// Spawns electron.exe directly, not `npx electron .` through a shell — the
// step-1 lesson (npx.cmd+shell left stale electron.exe processes behind,
// which let a later probe attach to a STALE process and false-PASS).
//
// Run:  node packages/controller/test/host-capability.probe.mjs
// Exit: 0 = both phases proved out. Non-zero = see stderr.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 9366;
const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronBin = fileURLToPath(new URL('../../../node_modules/electron/dist/electron.exe', import.meta.url));
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, FARSIGHT_SIGNALING_URL: 'ws://127.0.0.1:8080' },
});

class ProbeFailure extends Error {}
const fail = (msg) => { throw new ProbeFailure(msg); };

async function main() {
  const { default: WebSocket } = await import('ws');

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await delay(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('renderer/index.html'));
      if (t) { target = t; break; }
    } catch { /* not listening yet */ }
  }
  if (!target) fail('shell target never appeared on the CDP endpoint');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  const evaluate = (expression, awaitPromise = false) => new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      resolve(m.result?.result?.value);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise },
    }));
  });

  // ── Phase 1: control allowed (default) — prove the DOM + registration wired up.
  let marker = null;
  for (let i = 0; i < 40; i += 1) {
    marker = await evaluate('window.__farsightShellReady || null');
    if (marker && marker.hostRegistering === true) break;
    await delay(250);
  }
  if (!marker) fail('window.__farsightShellReady never appeared — the renderer did NOT run to completion (check the CSP importmap hash and the shared exports)');
  if (!marker.hasCredentialUi) fail(`marker reports no credential UI (id/password chips) in the DOM: ${JSON.stringify(marker)}`);
  if (!marker.hasConsentModal) fail(`marker reports no consent modal in the DOM: ${JSON.stringify(marker)}`);
  if (!marker.hasControlToggle) fail(`marker reports no control-allowed toggle in the DOM: ${JSON.stringify(marker)}`);
  if (marker.controlAllowed !== true) fail(`expected controlAllowed:true by default, got ${JSON.stringify(marker)}`);
  if (marker.hostRegistering !== true) fail(`expected hostRegistering:true (control on + signaling configured) — registration path is DOA. marker=${JSON.stringify(marker)}`);

  const credPw = await evaluate("document.getElementById('cred-pw').textContent");
  if (!credPw || credPw === '…') fail('credential password chip was never populated — startHostRegistration did not run');
  const credHiddenBefore = await evaluate("document.getElementById('host-credentials').hidden");
  if (credHiddenBefore !== false) fail('host-credentials panel is hidden while control is allowed');

  console.log('PROBE PHASE 1 PASS (control on, registering):', JSON.stringify(marker));

  // ── Phase 2: flip the toggle off through the REAL UI path (checkbox + change
  // event, exactly what a click does) — not a direct IPC call — so this proves
  // the wired-up handler, not just that the underlying IPC exists.
  await evaluate(
    "(() => { const el = document.getElementById('control-allowed-toggle'); el.checked = false; el.dispatchEvent(new Event('change')); return true; })()",
  );

  let marker2 = null;
  for (let i = 0; i < 40; i += 1) {
    marker2 = await evaluate('window.__farsightShellReady || null');
    if (marker2 && marker2.controlAllowed === false) break;
    await delay(250);
  }
  if (!marker2 || marker2.controlAllowed !== false) fail(`toggling off never reached controlAllowed:false — got ${JSON.stringify(marker2)}`);
  if (marker2.hostRegistering !== false) fail(`toggling control off left hostRegistering:${marker2.hostRegistering} — registration was NOT torn down (fail-closed broken). marker=${JSON.stringify(marker2)}`);

  const credHiddenAfter = await evaluate("document.getElementById('host-credentials').hidden");
  if (credHiddenAfter !== true) fail('host-credentials panel is still visible after control was turned off');

  const liveGet = await evaluate('window.farsightIpc.getControlAllowed()', true);
  if (liveGet !== false) fail(`getControlAllowed() returned ${JSON.stringify(liveGet)} after toggling off — persisted setting did not take`);

  console.log('PROBE PHASE 2 PASS (control off, torn down):', JSON.stringify(marker2));

  // Restore the real dev/user config to control-allowed:true before exiting.
  // This probe runs against the SAME userData profile as `npm start` on this
  // machine (Electron apps key userData by app name, not by launch args) — a
  // left-behind controlAllowed:false would silently disable hosting on the
  // maintainer's next manual run.
  await evaluate('window.farsightIpc.setControlAllowed(true)', true);

  ws.close();
  console.log('PROBE PASS');
}

try {
  await main();
  child.kill();
  process.exit(0);
} catch (e) {
  console.error(`PROBE FAIL: ${e && e.message ? e.message : String(e)}`);
  child.kill();
  process.exit(1);
}
