// Client-side session lifecycle over the account client (SP2 §4.4): hold the
// access token in memory, keep the refresh token in a store (the Electron
// safeStorage adapter implements the store interface), auto-refresh the access
// token when it's expired/near-expiry, resume on relaunch from the stored
// refresh token, and clear on logout. Pure — client, store, and clock injected.

import { describe, expect, test, vi } from 'vitest';
import { createAccountSession, jwtExpMs } from '../src/account-session.js';

// Build a fake JWT whose payload has the given exp (epoch seconds).
function jwt(expSeconds) {
  const b64url = (o) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'HS256' })}.${b64url({ exp: expSeconds })}.sig`;
}

function memStore(initial = {}) {
  let refreshToken = initial.refreshToken ?? null;
  return {
    async getRefreshToken() {
      return refreshToken;
    },
    async setTokens({ refreshToken: r }) {
      refreshToken = r;
    },
    async clear() {
      refreshToken = null;
    },
    _refresh: () => refreshToken,
  };
}

const NOW = 1_700_000_000_000;

describe('jwtExpMs', () => {
  test('decodes exp (ms) and returns null on garbage', () => {
    expect(jwtExpMs(jwt(1_700_000_900))).toBe(1_700_000_900_000);
    expect(jwtExpMs('not-a-jwt')).toBeNull();
    expect(jwtExpMs('')).toBeNull();
  });
});

describe('login', () => {
  test('stores the refresh token and caches the access token', async () => {
    const store = memStore();
    const client = { login: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: jwt(NOW / 1000 + 900), refreshToken: 'r1', deviceId: 'd1' } }), refresh: vi.fn() };
    const session = createAccountSession({ client, store, now: () => NOW });

    const res = await session.login({ email: 'a@b.c', password: 'pw', deviceName: 'pc' });

    expect(res).toEqual({ ok: true, deviceId: 'd1' });
    expect(store._refresh()).toBe('r1');
    // fresh access token is returned without a refresh call
    expect(await session.getAccessToken()).toContain('.');
    expect(client.refresh).not.toHaveBeenCalled();
  });

  test('propagates a failed login without storing anything', async () => {
    const store = memStore();
    const client = { login: vi.fn().mockResolvedValue({ ok: false, status: 401, error: 'bad_credentials' }), refresh: vi.fn() };
    const session = createAccountSession({ client, store, now: () => NOW });

    expect(await session.login({ email: 'a@b.c', password: 'x', deviceName: 'pc' })).toEqual({ ok: false, status: 401, error: 'bad_credentials' });
    expect(store._refresh()).toBeNull();
  });
});

describe('getAccessToken auto-refresh', () => {
  test('refreshes when the cached access token is within the skew window of expiry', async () => {
    const store = memStore();
    const nearlyExpired = jwt(NOW / 1000 + 10); // 10s left, inside the 30s skew
    const fresh = jwt(NOW / 1000 + 900);
    const client = {
      login: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: nearlyExpired, refreshToken: 'r1', deviceId: 'd1' } }),
      refresh: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: fresh } }),
    };
    const session = createAccountSession({ client, store, now: () => NOW });
    await session.login({ email: 'a@b.c', password: 'pw', deviceName: 'pc' });

    const tok = await session.getAccessToken();
    expect(client.refresh).toHaveBeenCalledWith({ refreshToken: 'r1' });
    expect(tok).toBe(fresh);
  });

  test('resumes on relaunch: no in-memory token, but a stored refresh token → refreshes', async () => {
    const store = memStore({ refreshToken: 'r-persisted' });
    const fresh = jwt(NOW / 1000 + 900);
    const client = { login: vi.fn(), refresh: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: fresh } }) };
    const session = createAccountSession({ client, store, now: () => NOW });

    expect(await session.getAccessToken()).toBe(fresh);
    expect(client.refresh).toHaveBeenCalledWith({ refreshToken: 'r-persisted' });
  });

  test('returns null with no stored refresh token', async () => {
    const client = { login: vi.fn(), refresh: vi.fn() };
    const session = createAccountSession({ client, store: memStore(), now: () => NOW });
    expect(await session.getAccessToken()).toBeNull();
    expect(client.refresh).not.toHaveBeenCalled();
  });

  test('returns null (and does not throw) when refresh is rejected — e.g. revoked device', async () => {
    const store = memStore({ refreshToken: 'r-revoked' });
    const client = { login: vi.fn(), refresh: vi.fn().mockResolvedValue({ ok: false, status: 401, error: 'revoked' }) };
    const session = createAccountSession({ client, store, now: () => NOW });
    expect(await session.getAccessToken()).toBeNull();
  });
});

describe('logout', () => {
  test('clears the store and the in-memory token', async () => {
    const store = memStore({ refreshToken: 'r1' });
    const client = { login: vi.fn(), refresh: vi.fn() };
    const session = createAccountSession({ client, store, now: () => NOW });

    await session.logout();
    expect(store._refresh()).toBeNull();
    expect(await session.getAccessToken()).toBeNull();
  });
});
