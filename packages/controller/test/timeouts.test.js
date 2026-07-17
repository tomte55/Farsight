// packages/controller/test/timeouts.test.js
import { expect, test, vi } from 'vitest';
import { createSessionTimers } from '../src/timeouts.js';

function fakeClock() {
  let timers = []; let id = 1;
  return {
    setTimeout: (fn, ms) => { const t = { id: id++, fn, at: ms }; timers.push(t); return t.id; },
    clearTimeout: (tid) => { timers = timers.filter((t) => t.id !== tid); },
    fire: (tid) => { const t = timers.find((x) => x.id === tid); if (t) t.fn(); },
    timers: () => timers,
  };
}

test('idle expiry fires onExpire("idle")', () => {
  const clk = fakeClock(); const onExpire = vi.fn();
  const timers = createSessionTimers({ idleMs: 100, absoluteMs: 1000, onExpire, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  timers.start();
  const idleTimer = clk.timers().find((t) => t.at === 100);
  clk.fire(idleTimer.id);
  expect(onExpire).toHaveBeenCalledWith('idle');
});

test('activity resets the idle timer', () => {
  const clk = fakeClock(); const onExpire = vi.fn();
  const timers = createSessionTimers({ idleMs: 100, absoluteMs: 1000, onExpire, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  timers.start();
  const first = clk.timers().find((t) => t.at === 100).id;
  timers.activity();
  expect(clk.timers().some((t) => t.id === first)).toBe(false); // old idle timer cleared
});

test('absolute expiry fires onExpire("absolute")', () => {
  const clk = fakeClock(); const onExpire = vi.fn();
  const timers = createSessionTimers({ idleMs: 100, absoluteMs: 1000, onExpire, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  timers.start();
  const absTimer = clk.timers().find((t) => t.at === 1000);
  clk.fire(absTimer.id);
  expect(onExpire).toHaveBeenCalledWith('absolute');
});

test('stop clears both timers', () => {
  const clk = fakeClock(); const onExpire = vi.fn();
  const timers = createSessionTimers({ idleMs: 100, absoluteMs: 1000, onExpire, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  timers.start();
  timers.stop();
  expect(clk.timers().length).toBe(0);
});
