// packages/host/test/reveal-window.test.js
import { expect, test } from 'vitest';
import { revealWindow } from '../src/reveal-window.js';

// Shared by the tray (click + "Show Farsight") and by the single-instance
// 'second-instance' handler: when the user re-launches the host (thinking it's
// closed, because it hid to the tray), the running instance surfaces its window
// instead of a second process spawning a second tray icon.

test('shows and focuses the window; restores it first when minimized', () => {
  const calls = [];
  const win = {
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  revealWindow(win);
  expect(calls).toEqual(['restore', 'show', 'focus']);
});

test('does not restore a window that is not minimized', () => {
  const calls = [];
  const win = {
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  revealWindow(win);
  expect(calls).toEqual(['show', 'focus']);
});

test('is a no-op when there is no window', () => {
  expect(() => revealWindow(null)).not.toThrow();
});
