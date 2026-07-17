// packages/shared/test/turn.test.js
import { expect, test, describe } from 'vitest';
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

describe('per-flow TURN username', () => {
  const now = () => 1_000_000; // fixed clock

  test('appends flowIndex so parallel flows get distinct usernames', () => {
    const a = makeTurnCredential({ secret: 's', ttlSeconds: 3600, now, flowIndex: 0 });
    const b = makeTurnCredential({ secret: 's', ttlSeconds: 3600, now, flowIndex: 1 });
    expect(a.username).toBe('4600:0'); // floor(1e6/1000)+3600 = 1000+3600 = 4600
    expect(b.username).toBe('4600:1');
    expect(a.username).not.toBe(b.username);
  });

  test('credential is HMAC over the full username string', () => {
    const c = makeTurnCredential({ secret: 's', ttlSeconds: 3600, now, flowIndex: 2 });
    expect(c.credential).toBe(createHmac('sha1', 's').update('4600:2').digest('base64'));
  });

  test('omitting flowIndex preserves the legacy timestamp-only username', () => {
    const c = makeTurnCredential({ secret: 's', ttlSeconds: 3600, now });
    expect(c.username).toBe('4600');
  });
});
