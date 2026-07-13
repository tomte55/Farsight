// packages/host/test/lifecycle.test.js
import { expect, test } from 'vitest';
import { createLifecycle } from '../src/lifecycle.js';

// The close-guard bug: the host window hides to the tray on close and only a real
// quit is allowed through. Before this fix, only the tray "Quit" item set the
// flag, so quitAndInstall()/autoInstallOnAppQuit — which go through app.quit()
// without touching our flag — got their window-close preventDefaulted, the quit
// aborted, and the auto-update could never shut the app down. Wiring beginQuit()
// to app 'before-quit' fixes every quit path at once; this module is that latch.

test('a fresh lifecycle is not quitting and hides the window on close', () => {
  const lc = createLifecycle();
  expect(lc.isQuitting()).toBe(false);
  expect(lc.shouldHideOnClose()).toBe(true);
});

test('beginQuit latches quitting so the window is allowed to close', () => {
  const lc = createLifecycle();
  lc.beginQuit();
  expect(lc.isQuitting()).toBe(true);
  expect(lc.shouldHideOnClose()).toBe(false);
});
