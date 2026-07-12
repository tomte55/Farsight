// packages/shared/test/signaling-url.test.js
import { expect, test } from 'vitest';
import { assertSecureSignalingUrl } from '../src/signaling-url.js';

test('accepts wss:// to any host', () => {
  expect(assertSecureSignalingUrl('wss://signal.example.org/ws'))
    .toBe('wss://signal.example.org/ws');
});

test('accepts ws:// to localhost', () => {
  expect(assertSecureSignalingUrl('ws://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080');
  expect(assertSecureSignalingUrl('ws://localhost:8080')).toBe('ws://localhost:8080');
});

test('rejects ws:// to a public host', () => {
  expect(() => assertSecureSignalingUrl('ws://signal.example.org'))
    .toThrow('insecure signaling URL');
});
