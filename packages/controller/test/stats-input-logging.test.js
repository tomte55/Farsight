// packages/controller/test/stats-input-logging.test.js
import { expect, test } from 'vitest';
import { formatQuality } from '../src/stats.js';
import { domEventToInput } from '../src/input-capture.js';
import { INPUT } from '@farsight/shared/input-events';

function makeLog() {
  const calls = [];
  const mk = () => ({
    debug: (m) => calls.push(`debug:${m}`),
    info: (m) => calls.push(`info:${m}`),
    warn: (m) => calls.push(`warn:${m}`),
    error: (m) => calls.push(`error:${m}`),
    child: () => mk(),
  });
  return { log: mk(), calls };
}

const rect = { left: 100, top: 50, width: 800, height: 600 };

test('formatQuality logs each sample at debug (high-frequency)', () => {
  const { log, calls } = makeLog();
  const label = formatQuality({ rttMs: 34, kbps: 3200, width: 1920, height: 1080, transport: 'direct' }, log);
  expect(label).toBe('34 ms · 3.2 Mbps · 1920×1080 · direct');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^debug:quality /);
  expect(calls[0]).toContain(label);
});

test('formatQuality with no log option still returns the formatted string (default no-op logger)', () => {
  expect(formatQuality({ rttMs: 12, kbps: 450, width: null, height: null, transport: 'relay' }))
    .toBe('12 ms · 450 kbps · relay');
});

test('dropped invalid input event logs a static warn, never the key value or coords', () => {
  const { log, calls } = makeLog();

  // Malformed synthetic keydown — no key at all. Must be dropped.
  const dropped = domEventToInput({ type: 'keydown', key: '' }, rect, log);
  expect(dropped).toBeNull();

  // A normal keydown carrying a sensitive-looking key is processed fine, but
  // must never end up embedded in any warn/log line.
  const secret = 'p@ssW0rd!Secret';
  const kept = domEventToInput({ type: 'keydown', key: secret }, rect, log);
  expect(kept).toEqual({ type: INPUT.KEY_DOWN, key: secret });

  expect(calls).toEqual(['warn:dropped invalid input event']);
  expect(calls.join('\n')).not.toContain(secret);
});

test('dropped out-of-bounds mouse event logs the same static warn (no coords leaked)', () => {
  const { log, calls } = makeLog();
  const dropped = domEventToInput({ type: 'mousemove', clientX: -50, clientY: -50 }, rect, log);
  expect(dropped).toBeNull();
  expect(calls).toEqual(['warn:dropped invalid input event']);
});

test('unknown event type logs the same static warn', () => {
  const { log, calls } = makeLog();
  const dropped = domEventToInput({ type: 'contextmenu' }, rect, log);
  expect(dropped).toBeNull();
  expect(calls).toEqual(['warn:dropped invalid input event']);
});

test('valid events with no log option still work (default no-op logger)', () => {
  expect(domEventToInput({ type: 'keydown', key: 'a' }, rect)).toEqual({ type: INPUT.KEY_DOWN, key: 'a' });
  expect(domEventToInput({ type: 'contextmenu' }, rect)).toBeNull();
});
