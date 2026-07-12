// packages/shared/test/turn.test.js
import { expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeTurnCredential, buildIceServers } from '../src/turn.js';

test('credential matches coturn HMAC-SHA1 scheme', () => {
  const now = () => 1_000_000_000_000; // fixed
  const { username, credential } = makeTurnCredential({ secret: 's3cr3t', ttlSeconds: 3600, now });
  const expectedExpiry = Math.floor(1_000_000_000_000 / 1000) + 3600;
  expect(username).toBe(String(expectedExpiry));
  const expected = createHmac('sha1', 's3cr3t').update(username).digest('base64');
  expect(credential).toBe(expected);
});

test('buildIceServers includes stun and turn entries', () => {
  const servers = buildIceServers({
    turnUri: 'turn:turn.example.org:3478', username: 'u', credential: 'c',
    stunUri: 'stun:turn.example.org:3478',
  });
  expect(servers).toEqual([
    { urls: 'stun:turn.example.org:3478' },
    { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'c' },
  ]);
});
