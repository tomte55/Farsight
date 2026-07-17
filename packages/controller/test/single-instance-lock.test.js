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

  test('a later launch reveals the running window via second-instance, not a new one', () => {
    expect(main).toMatch(/app\.on\('second-instance',\s*\(\)\s*=>\s*revealWindow\(mainWindow\)\)/);
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
