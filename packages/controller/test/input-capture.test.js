// packages/controller/test/input-capture.test.js
import { expect, test } from 'vitest';
import { domEventToInput } from '../src/input-capture.js';
import { INPUT } from '@farsight/shared/input-events';

const rect = { left: 100, top: 50, width: 800, height: 600 };

test('mousemove maps to fractional coords', () => {
  const out = domEventToInput({ type: 'mousemove', clientX: 500, clientY: 350 }, rect);
  expect(out).toEqual({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
});

test('mousedown maps button 0 to left', () => {
  const out = domEventToInput({ type: 'mousedown', clientX: 100, clientY: 50, button: 0 }, rect);
  expect(out).toEqual({ type: INPUT.MOUSE_DOWN, x: 0, y: 0, button: 'left' });
});

test('coords outside the video are ignored', () => {
  expect(domEventToInput({ type: 'mousemove', clientX: 0, clientY: 0 }, rect)).toBeNull();
});

test('keydown maps key', () => {
  expect(domEventToInput({ type: 'keydown', key: 'a' }, rect)).toEqual({ type: INPUT.KEY_DOWN, key: 'a' });
});
