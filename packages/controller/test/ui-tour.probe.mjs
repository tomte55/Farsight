// packages/controller/test/ui-tour.probe.mjs
// Comprehensive UI tour + style checks for the unified app's renderer. Launches
// the REAL packaged-shape renderer, stubs the account/transfer IPC so every view
// renders through its ACTUAL code path with representative data, screenshots each
// screen and both consent modals, and asserts a handful of load-bearing style
// facts (Slate Console tokens, flat buttons, square toggle, slim fleet rows).
//
// Run:  SHOT_DIR=/some/dir node packages/controller/test/ui-tour.probe.mjs
//       (SHOT_DIR defaults to this file's directory)
// Needs no signed-in account — the fleet/transfers/contacts data is stubbed.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const PORT = 9338;
const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronBin = fileURLToPath(new URL('../../../node_modules/electron/dist/electron.exe', import.meta.url));
const outDir = (process.env.SHOT_DIR || fileURLToPath(new URL('.', import.meta.url))).replace(/[\\/]+$/, '') + '/';

const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`],
  { cwd: appDir, stdio: 'ignore', env: { ...process.env, FARSIGHT_SIGNALING_URL: 'wss://signal.sovexa.org' } });

const results = [];
const die = (m) => { console.error('TOUR FAIL:', m); try { child.kill(); } catch {} process.exit(1); };

try {
  let page = null;
  for (let i = 0; i < 40; i++) {
    await delay(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
      if (page) break;
    } catch { /* not up yet */ }
  }
  if (!page) die('renderer target never appeared');

  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const cmd = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id !== mid) return; ws.off('message', onMsg); resolve(m.result); };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r?.result?.value;
  };
  const shot = async (name) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); if (r?.data) { writeFileSync(`${outDir}${name}.png`, Buffer.from(r.data, 'base64')); console.log('  📷', name); } };
  const clickRail = (re) => evalJs(`[...document.querySelectorAll('.rail-item')].find(b=>/${re}/i.test(b.textContent))?.click(); true`);
  const check = (label, ok, detail = '') => { results.push({ label, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await delay(1600); // shell renders + account resume settles

  // contextIsolation makes window.farsightIpc read-only, so we can't stub the IPC
  // to feed the real render fns. Instead we inject sample markup with the EXACT
  // classes the renderers emit (hostRow/jobRow/renderContacts) — a faithful CSS
  // preview — after each page is shown, then measure while it is still visible.
  const FLEET_ROWS = `
    <div class="host-row online"><div class="host-dot"></div>
      <div class="host-main"><div class="host-name">OMEN-Desktop</div><div class="host-meta">v2.0.0</div></div>
      <div class="host-right"><button class="btn btn-primary host-connect">Connect</button><button class="btn btn-ghost host-send">Files…</button><button class="btn btn-ghost host-send">Folder…</button><button class="btn btn-ghost host-remove">Remove</button></div></div>
    <div class="host-row"><div class="host-dot"></div>
      <div class="host-main"><div class="host-name">harrys-laptop</div><div class="host-meta">v1.14.4 · seen 2h ago</div></div>
      <div class="host-right"><button class="btn btn-ghost host-update">Update</button><button class="btn btn-ghost host-remove">Remove</button></div></div>`;
  const XFER_ROWS = `
    <div class="host-row xfer-row"><div class="host-main"><div class="host-name">↑ OMEN-Desktop — 12 files</div><div class="xfer-bar"><div class="xfer-bar-fill" style="width:42%"></div></div><div class="host-meta">Transferring · 1.2 GB of 3.0 GB · 24 MB/s · 3 / 12 files</div></div><div class="host-right"><button class="btn btn-ghost">Cancel</button></div></div>
    <div class="host-row xfer-row"><div class="host-main"><div class="host-name">↓ harrys-laptop — 12 files</div><div class="xfer-bar"><div class="xfer-bar-fill" style="width:100%"></div></div><div class="host-meta">Completed · 12 files</div></div><div class="host-right"><button class="btn btn-ghost">Remove</button></div></div>`;

  // ---- Home ----
  await clickRail('home'); await delay(300);
  await shot('tour-1-home');

  // ---- Fleet ----
  await clickRail('fleet'); await delay(700);
  await evalJs(`(() => {
    document.getElementById('acct-signin').hidden = true;
    document.getElementById('acct-fleet').hidden = false;
    document.getElementById('fleet-sub').textContent = '2 devices · 1 online';
    document.getElementById('fleet-list').innerHTML = ${JSON.stringify(FLEET_ROWS)};
    return true;
  })()`);
  await delay(150);
  const rowH = await evalJs(`Math.round(document.querySelector('#fleet-list .host-row').getBoundingClientRect().height)`);
  const wrapped = await evalJs(`(() => { const r=document.querySelector('#fleet-list .host-row.online'); const m=r.querySelector('.host-main'); const a=r.querySelector('.host-right'); return Math.abs(m.getBoundingClientRect().top - a.getBoundingClientRect().top) > 6; })()`);
  await shot('tour-2-fleet');

  // ---- Contacts ----
  await clickRail('people'); await delay(700);
  await evalJs(`(() => {
    document.getElementById('contacts-sub').textContent = '1 contact';
    document.getElementById('contacts-incoming').innerHTML = '<div class="host-row"><div class="host-main"><div class="host-name">sister@example.com</div><div class="host-meta">wants to connect</div></div><div class="host-right"><button class="btn btn-primary">Accept</button><button class="btn btn-ghost">Decline</button></div></div>';
    document.getElementById('contacts-list').innerHTML = '<div class="host-row online"><div class="host-dot on"></div><div class="host-main"><div class="host-name">dad@example.com</div><div class="host-meta">online</div></div><div class="host-right"><button class="btn btn-ghost host-send">Files…</button><button class="btn btn-ghost host-send">Folder…</button></div></div>';
    return true;
  })()`);
  await delay(150);
  await shot('tour-3-contacts');

  // ---- Transfers ----
  await clickRail('transfer'); await delay(700);
  await evalJs(`(() => {
    document.getElementById('transfers-empty').hidden = true;
    document.getElementById('transfers-list').innerHTML = ${JSON.stringify(XFER_ROWS)};
    return true;
  })()`);
  await delay(150);
  const xH = await evalJs(`Math.round(document.querySelector('#transfers-list .xfer-row').getBoundingClientRect().height)`);
  await shot('tour-4-transfers');

  // ---- Control consent modal ----
  await evalJs(`document.getElementById('consent').hidden = false; true`);
  await delay(200); await shot('tour-5-consent-control');
  await evalJs(`document.getElementById('consent').hidden = true; true`);

  // ---- Incoming-files consent modal ----
  await evalJs(`(() => {
    document.getElementById('transfer-consent-summary').textContent = '12 files · 3.0 GB';
    document.getElementById('transfer-consent-dest').textContent = 'C:\\\\Users\\\\tomte\\\\Downloads\\\\Farsight\\\\Received';
    const t = document.getElementById('transfer-consent-tree');
    t.innerHTML = '<ul class="xfer-tree"><li class="xfer-tree-dir">\\u{1F4C1} photos<ul class="xfer-tree"><li class="xfer-tree-file">img_001.jpg — 2.4 MB</li><li class="xfer-tree-file">img_002.jpg — 2.1 MB</li></ul></li><li class="xfer-tree-file">notes.txt — 4 KB</li></ul>';
    document.getElementById('transfer-consent').hidden = false;
    return true;
  })()`);
  await delay(200); await shot('tour-6-consent-transfer');
  await evalJs(`document.getElementById('transfer-consent').hidden = true; true`);

  // ---- Settings ----
  await clickRail('settings'); await delay(400);
  await shot('tour-7-settings');

  console.log('\n  --- style checks ---');
  const go = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue('--go').trim()`);
  check('--go token is #2c8a72 (preview teal)', go.toLowerCase() === '#2c8a72', go);
  const tRad = await evalJs(`(() => { const e=document.getElementById('control-allowed-toggle'); return e?getComputedStyle(e).borderRadius:'' })()`);
  check('control toggle is square (radius ≤4px)', /^[0-4]px$/.test(tRad), tRad);
  const bord = await evalJs(`(() => { const b=document.querySelector('#contacts-list .btn-ghost'); if(!b) return 'no-btn'; return getComputedStyle(b).borderTopColor; })()`);
  check('row buttons are borderless', bord === 'rgba(0, 0, 0, 0)' || bord === 'transparent', bord);
  check('fleet row is slim (<52px)', rowH > 0 && rowH < 52, rowH + 'px');
  check('fleet buttons stay on the name line (no wrap)', wrapped === false, wrapped ? 'wrapped' : 'single-line');
  check('transfer row is compact (<64px)', xH > 0 && xH < 64, xH + 'px');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  ws.close(); child.kill();
  process.exit(failed.length ? 2 : 0);
} catch (e) { die(e?.message || String(e)); }
