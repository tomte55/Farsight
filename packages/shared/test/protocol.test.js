// packages/shared/test/protocol.test.js
import { expect, test } from 'vitest';
import { MSG, buildMessage, parseMessage } from '../src/protocol.js';

test('buildMessage merges type and payload', () => {
  expect(buildMessage(MSG.CONNECT, { targetId: '123', password: 'x' }))
    .toEqual({ type: 'connect', targetId: '123', password: 'x' });
});

test('parseMessage round-trips a valid message', () => {
  const raw = JSON.stringify(buildMessage(MSG.OFFER, { sdp: 'v=0' }));
  expect(parseMessage(raw)).toEqual({ type: 'offer', sdp: 'v=0' });
});

test('parseMessage rejects non-JSON', () => {
  expect(() => parseMessage('not json')).toThrow('malformed message');
});

test('parseMessage rejects unknown type', () => {
  expect(() => parseMessage(JSON.stringify({ type: 'hack' }))).toThrow('malformed message');
});

test('parseMessage rejects missing type', () => {
  expect(() => parseMessage(JSON.stringify({ sdp: 'v=0' }))).toThrow('malformed message');
});

test('ICE_SERVERS is a known type', () => {
  expect(parseMessage(JSON.stringify({ type: 'ice_servers', iceServers: [] })).type).toBe('ice_servers');
});

test('UPDATE_PASSWORD is a known type', () => {
  expect(MSG.UPDATE_PASSWORD).toBe('update_password');
  expect(parseMessage(JSON.stringify({ type: 'update_password', password: 'k7m9pq' })).type)
    .toBe('update_password');
});

test('MSG carries the SP3 transfer-session types and parseMessage accepts them', () => {
  expect(MSG.TRANSFER_REQUEST).toBe('transfer_request');
  expect(MSG.ATTACH).toBe('attach');
  expect(parseMessage(JSON.stringify({ type: 'attach', sessionId: 's1' })))
    .toEqual({ type: 'attach', sessionId: 's1' });
  expect(parseMessage(JSON.stringify({ type: 'transfer_request', sessionId: 's1', linked: true })))
    .toEqual({ type: 'transfer_request', sessionId: 's1', linked: true });
});
