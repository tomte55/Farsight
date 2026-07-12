// packages/signaling-server/test/limits.test.js
import { expect, test } from 'vitest';
import { createConnectionLimits } from '../src/limits.js';

test('per-IP connection cap increments, blocks, and decrements', () => {
  const lim = createConnectionLimits({ maxPerIp: 2, maxRegPerIp: 3 });
  const ip = '1.2.3.4';
  expect(lim.canConnect(ip)).toBe(true);
  lim.addConn(ip);
  lim.addConn(ip);
  expect(lim.canConnect(ip)).toBe(false); // at cap
  lim.removeConn(ip);
  expect(lim.canConnect(ip)).toBe(true);  // freed a slot
});

test('per-IP registration cap is independent and enforced', () => {
  const lim = createConnectionLimits({ maxPerIp: 20, maxRegPerIp: 2 });
  const ip = '5.6.7.8';
  expect(lim.canRegister(ip)).toBe(true);
  lim.addReg(ip);
  lim.addReg(ip);
  expect(lim.canRegister(ip)).toBe(false);
  lim.removeReg(ip);
  expect(lim.canRegister(ip)).toBe(true);
});

test('counts are keyed per IP', () => {
  const lim = createConnectionLimits({ maxPerIp: 1, maxRegPerIp: 1 });
  lim.addConn('a');
  expect(lim.canConnect('a')).toBe(false);
  expect(lim.canConnect('b')).toBe(true); // different IP unaffected
});

test('removing below zero cleans up without going negative', () => {
  const lim = createConnectionLimits({ maxPerIp: 1 });
  lim.addConn('a');
  lim.removeConn('a');
  lim.removeConn('a'); // extra remove is a no-op
  expect(lim.canConnect('a')).toBe(true);
});
