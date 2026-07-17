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
// (focus/restore the existing window, no tray here) and exits. Same
// source-substring style as the other *-wiring tests in this package.
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

  test('a later launch RECREATES the window if the running one is gone', () => {
    // Field report: "I closed the controller during the transfer and tried to
    // start it again, but nothing happens" — the process lingered (a running
    // transfer's hidden worker window kept it alive), so it still held the lock,
    // and second-instance revealed a DESTROYED mainWindow = a silent no-op. The
    // close-quits-the-app fix removes the lingering process; this is the belt to
    // that braces — a relaunch must never do nothing.
    const handler = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf("app.on('second-instance'") + 400);
    expect(handler).toMatch(/mainWindow\.isDestroyed\(\)/);
    expect(handler).toMatch(/createWindow\(\)/);
  });

  test('the losing instance never builds a window inside whenReady', () => {
    // Same guard shape as the host: bail out of the whenReady callback before
    // createWindow() runs, so a losing instance never shows UI.
    expect(main).toMatch(/whenReady\(\)\.then\(async\s*\(\)\s*=>\s*\{\s*\n\s*if\s*\(\s*!gotSingleInstanceLock\s*\)\s*return;/);
  });

  test('imports revealWindow from a local module (mirrors the host, no tray here)', () => {
    expect(main).toMatch(/import\s*\{\s*revealWindow\s*\}\s*from\s*'\.\/reveal-window\.js'/);
  });
});

describe('controller main: closing the window quits every process', () => {
  test('the main window close handler quits the app', () => {
    // Field report: "I closed the controller during the transfer ... the process
    // is still running and has network activity. When I close the program by
    // pressing the windows X every controller process should stop."
    //
    // 'window-all-closed' (below) is NOT sufficient: a running transfer owns a
    // hidden transfer-worker BrowserWindow (transfer-worker.js: `show: false`),
    // which still counts as a window — so that event never fires mid-transfer and
    // the process lingers invisibly, still moving bytes, holding the
    // single-instance lock so a relaunch silently does nothing.
    expect(main).toMatch(/win\.on\('closed'[\s\S]{0,120}app\.quit\(\)/);
  });

  test('window-all-closed still quits too (the no-transfer path)', () => {
    expect(main).toMatch(/app\.on\('window-all-closed'/);
    expect(main).toMatch(/window-all-closed[\s\S]{0,160}app\.quit\(\)/);
  });
});
