// packages/controller/test/panic.test.js
import { expect, test, vi } from 'vitest';
import { registerPanicKey } from '../src/panic.js';

test('registers the accelerator and wires the callback', () => {
  const onPanic = vi.fn();
  const registered = {};
  const globalShortcut = {
    register: (acc, cb) => { registered[acc] = cb; return true; },
    isRegistered: (acc) => acc in registered,
  };
  const ok = registerPanicKey(globalShortcut, 'CommandOrControl+Alt+F12', onPanic);
  expect(ok).toBe(true);
  registered['CommandOrControl+Alt+F12']();
  expect(onPanic).toHaveBeenCalled();
});

test('returns false when registration fails', () => {
  const globalShortcut = { register: () => false, isRegistered: () => false };
  expect(registerPanicKey(globalShortcut, 'X', () => {})).toBe(false);
});
