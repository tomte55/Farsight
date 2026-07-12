// packages/host/test/input-injector.test.js
import { expect, test, vi } from 'vitest';
import { createInjector } from '../src/input-injector.js';
import { INPUT } from '@farsight/shared/input-events';

function fakeNut() {
  return { moveMouse: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn(), scroll: vi.fn(), keyDown: vi.fn(), keyUp: vi.fn() };
}
// Flushes the entire microtask queue (including microtasks scheduled while
// draining it), unlike chaining a fixed number of .then()s.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const secondary = { bounds: { x: 1920, y: 0, width: 1280, height: 720 } };

test('maps fractional coords into the primary display region', async () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
  await tick();
  expect(nut.moveMouse).toHaveBeenCalledWith(960, 540);
});

test('maps into a secondary display offset by bounds.x', async () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: secondary });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0, y: 0 });
  await tick();
  expect(nut.moveMouse).toHaveBeenCalledWith(1920, 0); // top-left of the second monitor
});

test('applies dipToScreen conversion when provided', async () => {
  const nut = fakeNut();
  const dipToScreen = (p) => ({ x: p.x * 2, y: p.y * 2 }); // e.g. 200% scaling
  const inj = createInjector({ nut, display: primary, dipToScreen });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
  await tick();
  expect(nut.moveMouse).toHaveBeenCalledWith(1920, 1080);
});

test('setDisplay switches the target region', async () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  inj.setDisplay(secondary);
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 1, y: 1 });
  await tick();
  expect(nut.moveMouse).toHaveBeenCalledWith(1920 + 1280, 720);
});

test('rejects malformed event without throwing', () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  expect(inj.inject({ type: 'exec', cmd: 'rm' })).toBe(false);
  expect(nut.moveMouse).not.toHaveBeenCalled();
});

test('routes button and key events', async () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  inj.inject({ type: INPUT.MOUSE_DOWN, x: 0, y: 0, button: 'left' });
  inj.inject({ type: INPUT.KEY_DOWN, key: 'Enter' });
  await tick();
  expect(nut.mouseDown).toHaveBeenCalledWith('left');
  expect(nut.keyDown).toHaveBeenCalledWith('Enter');
});

test('serializes native calls so a slow event completes before the next one starts', async () => {
  const order = [];
  let resolveA;
  const nut = {
    moveMouse: vi.fn((x, y) => {
      if (x === 100 && y === 100) {
        // event A: deferred until we manually resolve it
        return new Promise((resolve) => {
          resolveA = () => { order.push('A:moveMouse'); resolve(); };
        });
      }
      // event B: resolves immediately, but must still wait its turn in the chain
      order.push('B:moveMouse');
      return Promise.resolve();
    }),
    mouseDown: vi.fn(),
    mouseUp: vi.fn(),
    scroll: vi.fn(),
    keyDown: vi.fn(),
    keyUp: vi.fn(),
  };
  const inj = createInjector({ nut, display: primary });

  // Event A: slow-resolving moveMouse to (100,100) -> x=100/1920, y=100/1080
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 100 / 1920, y: 100 / 1080 });
  // Event B: submitted right after A, before A resolves
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 200 / 1920, y: 200 / 1080 });

  // Let microtasks run; B's native call must NOT have started yet because A hasn't resolved.
  await tick();
  expect(order).toEqual([]);
  expect(nut.moveMouse).toHaveBeenCalledTimes(1); // only A's call has been made so far

  resolveA();
  await tick();

  expect(order).toEqual(['A:moveMouse', 'B:moveMouse']);
  expect(nut.moveMouse).toHaveBeenCalledTimes(2);
});

test('a rejected native call does not break the chain for subsequent events', async () => {
  const nut = fakeNut();
  nut.moveMouse.mockImplementationOnce(() => Promise.reject(new Error('nut boom')));
  const inj = createInjector({ nut, display: primary });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0, y: 0 });
  inj.inject({ type: INPUT.KEY_DOWN, key: 'a' });
  await tick();
  expect(nut.keyDown).toHaveBeenCalledWith('a');
});
