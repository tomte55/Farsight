// packages/host/test/input-injector.test.js
import { expect, test, vi } from 'vitest';
import { createInjector } from '../src/input-injector.js';
import { INPUT } from '@farsight/shared/input-events';

function fakeNut() {
  return { moveMouse: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn(), scroll: vi.fn(), keyDown: vi.fn(), keyUp: vi.fn() };
}
const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const secondary = { bounds: { x: 1920, y: 0, width: 1280, height: 720 } };

test('maps fractional coords into the primary display region', () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
  expect(nut.moveMouse).toHaveBeenCalledWith(960, 540);
});

test('maps into a secondary display offset by bounds.x', () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: secondary });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0, y: 0 });
  expect(nut.moveMouse).toHaveBeenCalledWith(1920, 0); // top-left of the second monitor
});

test('applies dipToScreen conversion when provided', () => {
  const nut = fakeNut();
  const dipToScreen = (p) => ({ x: p.x * 2, y: p.y * 2 }); // e.g. 200% scaling
  const inj = createInjector({ nut, display: primary, dipToScreen });
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
  expect(nut.moveMouse).toHaveBeenCalledWith(1920, 1080);
});

test('setDisplay switches the target region', () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  inj.setDisplay(secondary);
  inj.inject({ type: INPUT.MOUSE_MOVE, x: 1, y: 1 });
  expect(nut.moveMouse).toHaveBeenCalledWith(1920 + 1280, 720);
});

test('rejects malformed event without throwing', () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  expect(inj.inject({ type: 'exec', cmd: 'rm' })).toBe(false);
  expect(nut.moveMouse).not.toHaveBeenCalled();
});

test('routes button and key events', () => {
  const nut = fakeNut();
  const inj = createInjector({ nut, display: primary });
  inj.inject({ type: INPUT.MOUSE_DOWN, x: 0, y: 0, button: 'left' });
  expect(nut.mouseDown).toHaveBeenCalledWith('left');
  inj.inject({ type: INPUT.KEY_DOWN, key: 'Enter' });
  expect(nut.keyDown).toHaveBeenCalledWith('Enter');
});
