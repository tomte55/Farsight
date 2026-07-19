import { expect, test } from 'vitest';
import {
  parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl,
  resolveParallelConnections, DEFAULT_PARALLEL_CONNECTIONS, resolveRateLimit,
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

test('resolveParallelConnections defaults to 8 for absent/invalid/NaN-ish input', () => {
  expect(resolveParallelConnections(undefined)).toBe(8);
  expect(DEFAULT_PARALLEL_CONNECTIONS).toBe(8);
  expect(resolveParallelConnections(null)).toBe(8);
  expect(resolveParallelConnections(true)).toBe(8);
  expect(resolveParallelConnections({})).toBe(8);
  expect(resolveParallelConnections([])).toBe(8);
  expect(resolveParallelConnections('')).toBe(8);
  expect(resolveParallelConnections('   ')).toBe(8);
  expect(resolveParallelConnections('not-a-number')).toBe(8);
  expect(resolveParallelConnections(NaN)).toBe(8);
});

test('resolveParallelConnections clamps to [1,32] and rounds/coerces numeric strings', () => {
  expect(resolveParallelConnections(1)).toBe(1);
  expect(resolveParallelConnections(32)).toBe(32);
  expect(resolveParallelConnections(4)).toBe(4);
  expect(resolveParallelConnections(0)).toBe(1);
  expect(resolveParallelConnections(-5)).toBe(1);
  expect(resolveParallelConnections(33)).toBe(32);
  expect(resolveParallelConnections(100)).toBe(32);
  expect(resolveParallelConnections(1000)).toBe(32);
  expect(resolveParallelConnections(3.6)).toBe(4);
  expect(resolveParallelConnections('12')).toBe(12);
  expect(resolveParallelConnections('  6  ')).toBe(6);
});

test('parseConfig omits parallelConnections when the key is absent', () => {
  expect(parseConfig('{}')).toEqual({});
  expect(parseConfig('{}').parallelConnections).toBeUndefined();
});

test('parseConfig reads a valid parallelConnections', () => {
  expect(parseConfig('{"parallelConnections":4}')).toEqual({ parallelConnections: 4 });
  expect(parseConfig('{"parallelConnections":1}')).toEqual({ parallelConnections: 1 });
  expect(parseConfig('{"parallelConnections":32}')).toEqual({ parallelConnections: 32 });
});

test('parseConfig clamps an out-of-range parallelConnections instead of dropping it', () => {
  expect(parseConfig('{"parallelConnections":0}')).toEqual({ parallelConnections: 1 });
  expect(parseConfig('{"parallelConnections":-3}')).toEqual({ parallelConnections: 1 });
  expect(parseConfig('{"parallelConnections":100}')).toEqual({ parallelConnections: 32 });
});

test('parseConfig defaults an invalid/NaN parallelConnections to 8 instead of dropping it', () => {
  expect(parseConfig('{"parallelConnections":"garbage"}')).toEqual({ parallelConnections: 8 });
  expect(parseConfig('{"parallelConnections":null}')).toEqual({ parallelConnections: 8 });
  expect(parseConfig('{"parallelConnections":true}')).toEqual({ parallelConnections: 8 });
});

test('serializeConfig round-trips parallelConnections alongside other keys and drops when unset', () => {
  const out = serializeConfig({ signalingUrl: 'wss://x.example', parallelConnections: 3 });
  expect(JSON.parse(out)).toEqual({ signalingUrl: 'wss://x.example', parallelConnections: 3 });
  expect(parseConfig(serializeConfig({ parallelConnections: 8 }))).toEqual({ parallelConnections: 8 });
  expect(serializeConfig({})).toBe('{}');
  expect(JSON.parse(serializeConfig({ parallelConnections: 100 }))).toEqual({ parallelConnections: 32 });
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

test('resolveRateLimit clamps to 0-or-[1,1000], 0=unlimited', () => {
  expect(resolveRateLimit(0)).toBe(0);
  expect(resolveRateLimit(-5)).toBe(0);
  expect(resolveRateLimit('')).toBe(0);
  expect(resolveRateLimit(2000)).toBe(1000);
  expect(resolveRateLimit(0.4)).toBe(0);   // rounds below 1 → 0/unlimited
  expect(resolveRateLimit(200)).toBe(200);
});

test('rateLimitMbps round-trips through parse/serialize', () => {
  const s = serializeConfig({ rateLimitMbps: 200 });
  expect(parseConfig(s).rateLimitMbps).toBe(200);
});
