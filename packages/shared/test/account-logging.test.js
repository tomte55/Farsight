// packages/shared/test/account-logging.test.js
// Verbose diagnostic logging (see docs/private/superpowers): state-change
// breadcrumbs only — never the access/refresh token.
import { describe, expect, test } from 'vitest';
import { createAccountService } from '../src/account-service.js';
import { createHeartbeat } from '../src/account-heartbeat.js';

function makeLog() {
  const calls = [];
  const mk = () => ({
    debug: (m) => calls.push(m),
    info: (m) => calls.push(m),
    warn: (m) => calls.push(m),
    error: (m) => calls.push(m),
    child: mk,
  });
  return { log: mk(), calls };
}

function fakeFetch(routes) {
  const impl = async (url) => {
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = routes[key] ?? { status: 404, body: { error: 'not_found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  };
  return impl;
}
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => Buffer.from(b).toString().replace(/^enc:/, ''),
};
function fakeFs() {
  const files = new Map();
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync: (p, d) => files.set(p, d),
    rmSync: (p) => files.delete(p),
  };
}
function jwt(offsetSec = 3600) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ exp: Math.floor(1_700_000_000) + offsetSec })}.sig`;
}
const SECRET_TOKEN = 'r1-super-secret-refresh-token';

describe('createAccountService logging', () => {
  test('login logs an info breadcrumb, without the token', async () => {
    const { log, calls } = makeLog();
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc',
      fetch: fakeFetch({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: SECRET_TOKEN, deviceId: 'd1' } } }),
      now: () => 1_700_000_000_000, log,
    });

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    expect(calls.join('\n')).toMatch(/logged in/i);
    expect(calls.join('\n')).not.toMatch(SECRET_TOKEN);
  });

  test('logout logs an info breadcrumb', async () => {
    const { log, calls } = makeLog();
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc',
      fetch: fakeFetch({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: SECRET_TOKEN, deviceId: 'd1' } } }),
      now: () => 1_700_000_000_000, log,
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    calls.length = 0;

    await service.logout();

    expect(calls.join('\n')).toMatch(/logged out/i);
  });

  test('a failed token refresh logs a warning with the HTTP status, not the token', async () => {
    const { log, calls } = makeLog();
    const fs = fakeFs();
    // First instance logs in and persists a refresh token.
    const login = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs, filePath: '/cfg/token.enc',
      fetch: fakeFetch({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: SECRET_TOKEN, deviceId: 'd1' } } }),
      now: () => 1_700_000_000_000,
    });
    await login.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    // A fresh instance (relaunch) whose stored access token is absent, forcing a
    // refresh — the fake refresh endpoint rejects with 401.
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs, filePath: '/cfg/token.enc',
      fetch: fakeFetch({ '/token/refresh': { status: 401, body: { error: 'invalid_refresh_token' } } }),
      now: () => 1_700_000_000_000, log,
    });

    expect(await service.status()).toEqual({ signedIn: false });
    expect(calls.join('\n')).toMatch(/refresh failed/i);
    expect(calls.join('\n')).toMatch(/401/);
    expect(calls.join('\n')).not.toMatch(SECRET_TOKEN);
  });
});

describe('createHeartbeat logging', () => {
  function fakeScheduler() {
    let cb = null;
    return { setInterval: (fn) => { cb = fn; return 1; }, clearInterval: () => { cb = null; }, tick: async () => { if (cb) await cb(); } };
  }

  test('a successful beat logs a debug breadcrumb', async () => {
    const { log, calls } = makeLog();
    const session = { getAccessToken: async () => 'access-1' };
    const client = { heartbeat: async () => ({ ok: true, status: 204 }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.9.9', setInterval: sched.setInterval, clearInterval: sched.clearInterval, log });

    await hb.start();

    expect(calls.join('\n')).toMatch(/heartbeat ok/i);
  });

  test('a failed beat logs a warning with the HTTP status, not the token', async () => {
    const { log, calls } = makeLog();
    const session = { getAccessToken: async () => 'access-1-should-not-be-logged' };
    const client = { heartbeat: async () => ({ ok: false, status: 401, error: 'unauthorized' }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.9.9', setInterval: sched.setInterval, clearInterval: sched.clearInterval, log });

    await hb.start();

    expect(calls.join('\n')).toMatch(/heartbeat failed/i);
    expect(calls.join('\n')).toMatch(/401/);
    expect(calls.join('\n')).not.toMatch(/access-1-should-not-be-logged/);
  });
});
