// packages/controller/test/window-attention.test.js
import { expect, test } from 'vitest';
import { windowAttentionPlan } from '../src/window-attention.js';

test('hidden-in-tray window: show + focus + flash + raise', () => {
  const p = windowAttentionPlan({ isMinimized: false, isVisible: false, isFocused: false });
  expect(p).toEqual({ show: true, restore: false, focus: true, flash: true, raiseTemporarily: true });
});

test('minimized window: restore (no show) + focus + flash', () => {
  const p = windowAttentionPlan({ isMinimized: true, isVisible: true, isFocused: false });
  expect(p.show).toBe(false);
  expect(p.restore).toBe(true);
  expect(p.focus).toBe(true);
  expect(p.flash).toBe(true);
});

test('already focused window: no flash, no raise', () => {
  const p = windowAttentionPlan({ isMinimized: false, isVisible: true, isFocused: true });
  expect(p.flash).toBe(false);
  expect(p.raiseTemporarily).toBe(false);
  expect(p.focus).toBe(true);
});
