// packages/signaling-server/test/client-ip.test.js
import { expect, test } from 'vitest';
import { clientIp } from '../src/client-ip.js';

// H-1: behind a trusted reverse proxy, the socket's remoteAddress is the
// proxy's constant IP — the real client IP must come from X-Forwarded-For,
// but ONLY when the deployer has explicitly opted in via trustProxy (untrusted
// XFF is trivially spoofable by any direct client).
//
// We trust exactly ONE proxy hop (Caddy), which APPENDS the immediate peer to
// X-Forwarded-For without stripping a client-supplied header — so the
// RIGHT-most entry is the real client, and the LEFT-most is attacker-controlled.
test('trustProxy off: always uses remoteAddress, even if forwardedFor is set', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '1.2.3.4', trustProxy: false })).toBe('10.0.0.1');
});

test('trustProxy on: single entry — uses it as the real client', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '1.2.3.4', trustProxy: true })).toBe('1.2.3.4');
});

test('trustProxy on: multiple hops — takes the right-most (appended by the trusted proxy)', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '1.2.3.4, 10.0.0.2, 10.0.0.1', trustProxy: true })).toBe('10.0.0.1');
});

test('trustProxy on: spoofed left-most is ignored — only the right-most (proxy-appended) entry is trusted', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '9.9.9.9, 203.0.113.7', trustProxy: true })).toBe('203.0.113.7');
});

test('trustProxy on: trims extra whitespace around the right-most entry', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '1.2.3.4, 10.0.0.2  ,  203.0.113.7  ', trustProxy: true })).toBe('203.0.113.7');
});

test('trustProxy on but forwardedFor missing: falls back to remoteAddress', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: undefined, trustProxy: true })).toBe('10.0.0.1');
});

test('trustProxy on but forwardedFor is an empty string: falls back to remoteAddress', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '', trustProxy: true })).toBe('10.0.0.1');
});

test('trustProxy on but forwardedFor is not a string (e.g. array from a weird proxy): falls back to remoteAddress', () => {
  expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: ['1.2.3.4'], trustProxy: true })).toBe('10.0.0.1');
});
