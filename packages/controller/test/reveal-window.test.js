// packages/controller/test/reveal-window.test.js
// Mirrors packages/host/test/reveal-window.test.js — same module, same
// behavior, used here by the 'second-instance' single-instance-lock handler
// instead of a tray.
import { expect, test } from 'vitest';
import { revealWindow } from '../src/reveal-window.js';

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
