import { expect, test } from 'vitest';
import {
  parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl,
} from '../src/config.js';

test('parseConfig reads a valid signalingUrl', () => {
  expect(parseConfig('{"signalingUrl":"wss://s.example.org"}'))
    .toEqual({ signalingUrl: 'wss://s.example.org' });
});

test('parseConfig returns empty config on corrupt/missing/non-string input', () => {
  expect(parseConfig('not json')).toEqual({});
  expect(parseConfig('{}')).toEqual({});
  expect(parseConfig('{"signalingUrl":123}')).toEqual({});
  expect(parseConfig('null')).toEqual({});
});

test('serializeConfig round-trips and drops empty', () => {
  expect(parseConfig(serializeConfig({ signalingUrl: 'wss://s.example.org' })))
    .toEqual({ signalingUrl: 'wss://s.example.org' });
  expect(serializeConfig({})).toBe('{}');
  expect(serializeConfig({ signalingUrl: '' })).toBe('{}');
});

test('validateSignalingUrl accepts wss, trims, rejects empty and ws-public', () => {
  expect(validateSignalingUrl('  wss://s.example.org/ws  ')).toBe('wss://s.example.org/ws');
  expect(() => validateSignalingUrl('')).toThrow('required');
  expect(() => validateSignalingUrl('ws://s.example.org')).toThrow('insecure signaling URL');
});

test('parseConfig reads a valid controlAllowed and both fields together', () => {
  expect(parseConfig('{"controlAllowed":false}')).toEqual({ controlAllowed: false });
  expect(parseConfig('{"signalingUrl":"wss://s.example.org","controlAllowed":false}'))
    .toEqual({ signalingUrl: 'wss://s.example.org', controlAllowed: false });
});

test('parseConfig drops a non-boolean controlAllowed', () => {
  expect(parseConfig('{"controlAllowed":"false"}')).toEqual({});
  expect(parseConfig('{"controlAllowed":null}')).toEqual({});
});

test('serializeConfig round-trips controlAllowed (including false) alongside signalingUrl', () => {
  expect(parseConfig(serializeConfig({ signalingUrl: 'wss://s.example.org', controlAllowed: false })))
    .toEqual({ signalingUrl: 'wss://s.example.org', controlAllowed: false });
  expect(parseConfig(serializeConfig({ controlAllowed: true })))
    .toEqual({ controlAllowed: true });
  expect(serializeConfig({})).toBe('{}');
});

test('parseConfig keeps a string receivedFilesDir', () => {
  expect(parseConfig(JSON.stringify({ receivedFilesDir: 'C:\\Downloads\\FS' })))
    .toEqual({ receivedFilesDir: 'C:\\Downloads\\FS' });
});

test('parseConfig drops a non-string/blank receivedFilesDir', () => {
  expect(parseConfig(JSON.stringify({ receivedFilesDir: 123 }))).toEqual({});
  expect(parseConfig(JSON.stringify({ receivedFilesDir: '   ' }))).toEqual({});
});

test('serializeConfig round-trips receivedFilesDir alongside other keys', () => {
  const out = serializeConfig({ signalingUrl: 'wss://x.example', receivedFilesDir: 'D:\\Recv' });
  expect(JSON.parse(out)).toEqual({ signalingUrl: 'wss://x.example', receivedFilesDir: 'D:\\Recv' });
  expect(JSON.parse(serializeConfig({ receivedFilesDir: '   ' }))).toEqual({});
});

test('resolveSignalingUrl: env wins, then config, then null', () => {
  expect(resolveSignalingUrl({ envUrl: 'ws://localhost:8080', storedUrl: 'wss://s.example.org' }))
    .toEqual({ url: 'ws://localhost:8080', source: 'env' });
  expect(resolveSignalingUrl({ storedUrl: 'wss://s.example.org' }))
    .toEqual({ url: 'wss://s.example.org', source: 'config' });
  expect(resolveSignalingUrl({})).toEqual({ url: null, source: null });
  expect(resolveSignalingUrl({ envUrl: '   ' , storedUrl: '  wss://s.example.org ' }))
    .toEqual({ url: 'wss://s.example.org', source: 'config' });
});
