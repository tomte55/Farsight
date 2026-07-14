// S2.3 — desktop token model, pure layer (vision §4.4). Short-lived access JWT +
// long-lived refresh JWT (HS256), carrying the account (sub), the device, and
// the tokenVersion at issue (tv) so a global-revocation bump invalidates them.
// Deterministic via an injected clock. No DB here — the DB-backed tv/device
// checks live in the session layer.

import { describe, expect, test } from 'vitest';
import {
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
  ACCESS_TTL_MS,
  type TokenConfig,
} from '../src/tokens.js';

const SECRET = new TextEncoder().encode('test-secret-at-least-32-bytes-long-abcdef');
const NOW = 1_700_000_000_000;
const subject = { sub: 'user-1', deviceId: 'device-1', tv: 3 };

function config(overrides: Partial<TokenConfig> = {}): TokenConfig {
  return { secret: SECRET, now: NOW, ...overrides };
}

describe('access token', () => {
  test('round-trips and carries its claims', async () => {
    const token = await issueAccessToken(config(), subject);
    const res = await verifyToken(token, { secret: SECRET, now: NOW, expectedType: 'access' });

    expect(res).toEqual({
      ok: true,
      claims: { sub: 'user-1', deviceId: 'device-1', tv: 3, type: 'access' },
    });
  });

  test('is rejected when a refresh token is expected', async () => {
    const token = await issueAccessToken(config(), subject);
    const res = await verifyToken(token, { secret: SECRET, now: NOW, expectedType: 'refresh' });
    expect(res).toEqual({ ok: false, reason: 'wrong_type' });
  });

  test('expires', async () => {
    const token = await issueAccessToken(config(), subject);
    const res = await verifyToken(token, {
      secret: SECRET,
      now: NOW + ACCESS_TTL_MS + 1000,
      expectedType: 'access',
    });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('refresh token', () => {
  test('outlives an access token issued at the same instant', async () => {
    const access = await issueAccessToken(config(), subject);
    const refresh = await issueRefreshToken(config(), subject);
    const later = NOW + ACCESS_TTL_MS + 1000;

    expect((await verifyToken(access, { secret: SECRET, now: later, expectedType: 'access' })).ok).toBe(
      false,
    );
    expect(
      (await verifyToken(refresh, { secret: SECRET, now: later, expectedType: 'refresh' })).ok,
    ).toBe(true);
  });
});

describe('rejection', () => {
  test('a token signed with a different secret is invalid', async () => {
    const token = await issueAccessToken(config(), subject);
    const wrong = new TextEncoder().encode('another-secret-at-least-32-bytes-xyzzzz');
    const res = await verifyToken(token, { secret: wrong, now: NOW, expectedType: 'access' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });

  test('garbage is invalid, not a crash', async () => {
    const res = await verifyToken('not.a.jwt', { secret: SECRET, now: NOW, expectedType: 'access' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });
});
