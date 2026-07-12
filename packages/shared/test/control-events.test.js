// packages/shared/test/control-events.test.js
import { expect, test } from 'vitest';
import { CONTROL, validateControlEvent } from '../src/control-events.js';

test('validates list and select', () => {
  expect(validateControlEvent({ type: CONTROL.LIST_MONITORS })).toEqual({ type: 'list_monitors' });
  expect(validateControlEvent({ type: CONTROL.SELECT_MONITOR, index: 1 })).toEqual({ type: 'select_monitor', index: 1 });
});

test('validates and sanitizes a monitors list', () => {
  const out = validateControlEvent({ type: CONTROL.MONITORS, monitors: [
    { index: 0, label: 'Main', width: 1920, height: 1080, primary: true, evil: 1 },
  ] });
  expect(out).toEqual({ type: 'monitors', monitors: [
    { index: 0, label: 'Main', width: 1920, height: 1080, primary: true },
  ] });
});

test('rejects bad index and oversized lists', () => {
  expect(() => validateControlEvent({ type: CONTROL.SELECT_MONITOR, index: 99 })).toThrow('invalid control event');
  expect(() => validateControlEvent({ type: CONTROL.SELECT_MONITOR, index: -1 })).toThrow('invalid control event');
  const big = Array.from({ length: 17 }, (_, i) => ({ index: i, label: 'x', width: 1, height: 1, primary: false }));
  expect(() => validateControlEvent({ type: CONTROL.MONITORS, monitors: big })).toThrow('invalid control event');
});

test('session_end reason is bounded and optional', () => {
  expect(validateControlEvent({ type: CONTROL.SESSION_END })).toEqual({ type: 'session_end' });
  expect(() => validateControlEvent({ type: CONTROL.SESSION_END, reason: 'x'.repeat(40) })).toThrow('invalid control event');
});

test('host_ended reason is bounded and optional', () => {
  expect(validateControlEvent({ type: CONTROL.HOST_ENDED })).toEqual({ type: 'host_ended' });
  expect(validateControlEvent({ type: CONTROL.HOST_ENDED, reason: 'panic' })).toEqual({ type: 'host_ended', reason: 'panic' });
  expect(() => validateControlEvent({ type: CONTROL.HOST_ENDED, reason: 'x'.repeat(40) })).toThrow('invalid control event');
});

test('rejects unknown control type', () => {
  expect(() => validateControlEvent({ type: 'shutdown' })).toThrow('invalid control event');
});
