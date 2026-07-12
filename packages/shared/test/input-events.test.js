// packages/shared/test/input-events.test.js
import { expect, test } from 'vitest';
import { INPUT, validateInputEvent } from '../src/input-events.js';

test('accepts a valid mouse move', () => {
  expect(validateInputEvent({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.25, junk: 'x' }))
    .toEqual({ type: 'mousemove', x: 0.5, y: 0.25 });
});

test('strips non-whitelisted fields', () => {
  const out = validateInputEvent({ type: INPUT.MOUSE_DOWN, x: 0.1, y: 0.1, button: 'left', evil: 1 });
  expect(out).toEqual({ type: 'mousedown', x: 0.1, y: 0.1, button: 'left' });
});

test('rejects out-of-range coordinates', () => {
  expect(() => validateInputEvent({ type: INPUT.MOUSE_MOVE, x: 1.5, y: 0.1 })).toThrow('invalid input event');
  expect(() => validateInputEvent({ type: INPUT.MOUSE_MOVE, x: -0.1, y: 0.1 })).toThrow('invalid input event');
  expect(() => validateInputEvent({ type: INPUT.MOUSE_MOVE, x: NaN, y: 0.1 })).toThrow('invalid input event');
});

test('rejects bad mouse button', () => {
  expect(() => validateInputEvent({ type: INPUT.MOUSE_DOWN, x: 0.1, y: 0.1, button: 'x1' })).toThrow('invalid input event');
});

test('accepts whitelisted named keys and printable keys', () => {
  expect(validateInputEvent({ type: INPUT.KEY_DOWN, key: 'Enter' })).toEqual({ type: 'keydown', key: 'Enter' });
  expect(validateInputEvent({ type: INPUT.KEY_DOWN, key: 'a' })).toEqual({ type: 'keydown', key: 'a' });
});

test('rejects unknown key names and oversized keys', () => {
  expect(() => validateInputEvent({ type: INPUT.KEY_DOWN, key: 'LaunchNukes' })).toThrow('invalid input event');
  expect(() => validateInputEvent({ type: INPUT.KEY_DOWN, key: 'x'.repeat(50) })).toThrow('invalid input event');
});

test('rejects unknown event type', () => {
  expect(() => validateInputEvent({ type: 'exec', cmd: 'rm' })).toThrow('invalid input event');
});

test('rejects non-object input', () => {
  expect(() => validateInputEvent(null)).toThrow('invalid input event');
  expect(() => validateInputEvent('mousemove')).toThrow('invalid input event');
});
