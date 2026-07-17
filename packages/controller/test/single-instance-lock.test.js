// packages/controller/test/single-instance-lock.test.js
// BUG 2 (field-diagnosed, see task-send-record-report.md): the controller had NO
// app.requestSingleInstanceLock() — only the host did. Relaunching the controller
// spawned a SECOND process beside the first (the maintainer's log proved it: the
// old process's [ft-worker] heartbeat kept beating for 24s after "controller
// starting" from the new instance, which showed its own empty Transfers list).
// Two instances sharing one jobs-store also makes BUG 1's startup sweep
// (recoverStaleSends) dangerous: instance #2 could rewrite instance #1's
// genuinely-live 'active' record to 'interrupted' out from under it, and the
// resume watcher would then try to resume a job that is still actively sending.
//
// Mirrors packages/host/src/main.js's lock (see its 'Single-instance lock'
// comment) — first instance wins; a later launch hands off via 'second-instance'
// and exits. Same source-substring style as the other *-wiring tests in this
// package.
//
// UPDATED (unification step 3, tray + hide-to-tray lifecycle): the controller is
// now a tray app like the host, so closing the window HIDES it instead of
// quitting — the old 'closing the window quits every process' contract
// (win.on('closed', ...) -> app.quit()) is GONE, replaced by a close-guard that
// only lets the window close during a real quit. Because the window is now
// hidden rather than destroyed, it is NEVER gone while the app is running, so
// second-instance's old "recreate if destroyed" fallback no longer applies
// either — a plain reveal (mirrors the host) is always correct.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');

describe('controller main: single-instance lock', () => {
  test('acquires the lock and quits immediately if it is already held elsewhere', () => {
    expect(main).toMatch(/gotSingleInstanceLock\s*=\s*app\.requestSingleInstanceLock\(\)/);
    expect(main).toMatch(/if\s*\(\s*!gotSingleInstanceLock\s*\)\s*app\.quit\(\)/);
  });

  test('a later launch reveals the running window via second-instance, not a new process', () => {
    expect(main).toMatch(/app\.on\('second-instance'/);
    expect(main).toMatch(/revealWindow\(mainWindow\)/);
  });

  test('second-instance is a PLAIN reveal — no recreate-if-destroyed fallback', () => {
    // The window now hides to the tray on close instead of being destroyed, so
    // it is never gone while the app runs. Pin the handler to a bare one-liner
    // so a regression that reintroduces the old destroyed-window special case
    // (now the wrong model — see the host, which has no such fallback either)
    // gets caught.
    const handler = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf("app.on('second-instance'") + 120);
    expect(handler).toMatch(/app\.on\('second-instance',\s*\(\)\s*=>\s*revealWindow\(mainWindow\)\);/);
    expect(handler).not.toMatch(/isDestroyed/);
  });

  test('the losing instance never builds a window inside whenReady', () => {
    // Same guard shape as the host: bail out of the whenReady callback before
    // createWindow() runs, so a losing instance never shows UI.
    expect(main).toMatch(/whenReady\(\)\.then\(async\s*\(\)\s*=>\s*\{\s*\n\s*if\s*\(\s*!gotSingleInstanceLock\s*\)\s*return;/);
  });

  test('imports revealWindow from a local module (mirrors the host)', () => {
    expect(main).toMatch(/import\s*\{\s*revealWindow\s*\}\s*from\s*'\.\/reveal-window\.js'/);
  });
});

describe('controller main: closing the window hides it to the tray (unification step 3)', () => {
  // Attended-access: the unified app must stay reachable as a host, so it is
  // now a tray app like packages/host — closing the window HIDES it instead of
  // quitting (INVERTS the old 'closing the window quits every process'
  // contract this file used to pin). Quit lives in the tray menu; the
  // lifecycle quit-latch (src/lifecycle.js) is what makes it reliable — see
  // lifecycle.test.js for the pure-unit coverage of shouldHideOnClose()/
  // beginQuit(), and the mutation check below for the main.js WIRING of it.
  test('the main window close handler is guarded by lifecycle.shouldHideOnClose()', () => {
    const handler = main.slice(main.indexOf("win.on('close'"), main.indexOf("win.on('close'") + 220);
    expect(handler).toMatch(/lifecycle\.shouldHideOnClose\(\)/);
    expect(handler).toMatch(/e\.preventDefault\(\)/);
    expect(handler).toMatch(/win\.hide\(\)/);
  });

  test('before-quit latches lifecycle.beginQuit() so a real quit is allowed through the close-guard', () => {
    expect(main).toMatch(/app\.on\('before-quit',\s*\(\)\s*=>\s*lifecycle\.beginQuit\(\)\)/);
  });

  test('window-all-closed only quits once lifecycle.isQuitting() (not unconditionally)', () => {
    // A running transfer/session owns extra hidden or visible windows, so this
    // must NOT fire — and must NOT quit — just because the main window hides.
    // It only fires once the main window's 'close' was actually allowed
    // through (see the close-guard above), which only happens once quitting
    // is latched — so gating this on isQuitting() too is belt-and-braces, but
    // pin it since it's exactly what makes a real Quit take the session +
    // transfer worker windows down with it.
    expect(main).toMatch(/app\.on\('window-all-closed'/);
    const handler = main.slice(main.indexOf("app.on('window-all-closed'"), main.indexOf("app.on('window-all-closed'") + 160);
    expect(handler).toMatch(/lifecycle\.isQuitting\(\)/);
    expect(handler).toMatch(/app\.quit\(\)/);
  });

  test('the old unconditional close-quits-the-app contract is gone', () => {
    expect(main).not.toMatch(/win\.on\('closed'/);
  });
});
