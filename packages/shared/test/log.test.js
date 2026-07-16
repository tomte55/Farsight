// packages/shared/test/log.test.js
import { expect, test, vi } from 'vitest';
import { createLogger, LEVELS } from '../src/log.js';

const fixedNow = () => '2026-07-13T00:00:00.000Z';

test('LEVELS orders severities', () => {
  expect(LEVELS.debug < LEVELS.info && LEVELS.info < LEVELS.warn && LEVELS.warn < LEVELS.error).toBe(true);
});

test('formats a line with padded level and no scope', () => {
  const sink = vi.fn();
  createLogger({ sink, now: fixedNow, minLevel: 'debug' }).info('hello');
  expect(sink).toHaveBeenCalledWith('2026-07-13T00:00:00.000Z INFO  hello');
});

test('drops messages below minLevel', () => {
  const sink = vi.fn();
  const log = createLogger({ sink, now: fixedNow, minLevel: 'warn' });
  log.info('skip');
  log.error('keep');
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink).toHaveBeenCalledWith('2026-07-13T00:00:00.000Z ERROR keep');
});

test('child() prefixes a scope and nests', () => {
  const sink = vi.fn();
  const log = createLogger({ sink, now: fixedNow, minLevel: 'debug' });
  log.child('ipc').warn('bad');
  log.child('a').child('b').info('x');
  expect(sink).toHaveBeenNthCalledWith(1, '2026-07-13T00:00:00.000Z WARN  [ipc] bad');
  expect(sink).toHaveBeenNthCalledWith(2, '2026-07-13T00:00:00.000Z INFO  [a:b] x');
});

test('collapses embedded CR/LF so a hostile message cannot forge log lines', () => {
  const sink = vi.fn();
  createLogger({ sink, now: fixedNow, minLevel: 'debug' }).info('line1\nline2\rline3');
  const line = sink.mock.calls[0][0];
  expect(line).not.toMatch(/[\r\n]/);
  expect(line).toBe('2026-07-13T00:00:00.000Z INFO  line1 line2 line3');
});

test('truncates messages to 2000 chars', () => {
  const sink = vi.fn();
  createLogger({ sink, now: fixedNow, minLevel: 'debug' }).info('x'.repeat(5000));
  const line = sink.mock.calls[0][0];
  // prefix + exactly 2000 payload chars
  expect(line.endsWith('x'.repeat(2000))).toBe(true);
  expect(line.includes('x'.repeat(2001))).toBe(false);
});
