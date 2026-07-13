import { expect, test, vi } from 'vitest';
import { createIdleRotator } from '../src/idle-rotator.js';

// Minimal fake clock: records armed timers, fires them on demand. New timers
// armed during a fire (the rotator re-arms) survive the flush.
function fakeClock() {
  let seq = 1;
  const timers = new Map();
  return {
    setTimeout: (fn) => { const id = seq++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fire: () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); },
    pending: () => timers.size,
  };
}

test('start arms a timer; firing rotates and re-arms', () => {
  const clock = fakeClock();
  const onRotate = vi.fn();
  const r = createIdleRotator({ intervalMs: 1000, onRotate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  r.start();
  expect(clock.pending()).toBe(1);
  clock.fire();
  expect(onRotate).toHaveBeenCalledTimes(1);
  expect(clock.pending()).toBe(1); // re-armed
});

test('pause cancels the countdown without rotating', () => {
  const clock = fakeClock();
  const onRotate = vi.fn();
  const r = createIdleRotator({ intervalMs: 1000, onRotate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  r.start();
  r.pause();
  expect(clock.pending()).toBe(0);
  expect(onRotate).not.toHaveBeenCalled();
});

test('resumeAfterSession rotates once (if paused) and re-arms', () => {
  const clock = fakeClock();
  const onRotate = vi.fn();
  const r = createIdleRotator({ intervalMs: 1000, onRotate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  r.start();
  r.pause();
  r.resumeAfterSession();
  expect(onRotate).toHaveBeenCalledTimes(1);
  expect(clock.pending()).toBe(1);
});

test('kick re-arms without rotating', () => {
  const clock = fakeClock();
  const onRotate = vi.fn();
  const r = createIdleRotator({ intervalMs: 1000, onRotate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  r.start();
  r.kick();
  expect(onRotate).not.toHaveBeenCalled();
  expect(clock.pending()).toBe(1);
});

test('stop cancels and prevents further rotation', () => {
  const clock = fakeClock();
  const onRotate = vi.fn();
  const r = createIdleRotator({ intervalMs: 1000, onRotate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  r.start();
  r.stop();
  expect(clock.pending()).toBe(0);
  r.kick(); // no-op after stop
  expect(clock.pending()).toBe(0);
});
