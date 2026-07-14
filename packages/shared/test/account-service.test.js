// Controller main-process account service (SP2): wires the shared account
// client + session + encrypted token store and exposes the operations the IPC
// layer / renderer need (login, logout, status, fleet). Deps injected
// (safeStorage, fs, fetch) so the wiring is unit-tested; main.js passes the real
// Electron safeStorage + node:fs.

import { describe, expect, test } from 'vitest';
import { createAccountService, DEFAULT_ACCOUNT_URL } from '../src/account-service.js';

// A tiny fake account server over fetch: routes by URL suffix.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = routes[key] ?? { status: 404, body: { error: 'not_found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  };
  return { impl, calls };
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
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, d) => files.set(p, d),
    rmSync: (p) => files.delete(p),
  };
}
// A refresh JWT that is comfortably unexpired (login caches it, no refresh call).
function jwt(offsetSec = 3600) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ exp: Math.floor(1_700_000_000) + offsetSec })}.sig`;
}
const svc = (routes, fs = fakeFs()) =>
  createAccountService({
    baseUrl: 'https://auth.example',
    safeStorage: fakeSafeStorage,
    fs,
    filePath: '/cfg/token.enc',
    fetch: fakeFetch(routes).impl,
    now: () => 1_700_000_000_000,
  });

// A scheduler whose interval callback a test can trigger deterministically.
function fakeScheduler() {
  let cb = null;
  let handle = 0;
  return {
    setInterval: (fn) => { cb = fn; return ++handle; },
    clearInterval: () => { cb = null; },
    tick: async () => { if (cb) await cb(); },
    hasCallback: () => cb !== null,
  };
}

describe('createAccountService', () => {
  test('exposes the deployed default account URL', () => {
    expect(DEFAULT_ACCOUNT_URL).toBe('https://auth.sovexa.org');
  });

  test('login → status signed-in; fleet returns the device list', async () => {
    const service = svc({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices': { status: 200, body: { devices: [{ id: 'd1', name: 'PC', online: true }] } },
    });

    expect(await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' })).toEqual({ ok: true, deviceId: 'd1' });
    expect(await service.status()).toEqual({ signedIn: true });

    const fleet = await service.fleet();
    expect(fleet.ok).toBe(true);
    expect(fleet.data.devices).toEqual([{ id: 'd1', name: 'PC', online: true }]);
  });

  test('fleet before sign-in reports not_signed_in (no request made)', async () => {
    const service = svc({});
    expect(await service.status()).toEqual({ signedIn: false });
    expect(await service.fleet()).toEqual({ ok: false, error: 'not_signed_in' });
  });

  test('a failed login propagates and leaves the session signed-out', async () => {
    const service = svc({ '/login': { status: 401, body: { error: 'bad_credentials' } } });
    expect(await service.login({ email: 'a@b.c', password: 'x', deviceName: 'ctrl' })).toEqual({ ok: false, status: 401, error: 'bad_credentials' });
    expect(await service.status()).toEqual({ signedIn: false });
  });

  test('login starts presence heartbeats (immediate + on interval)', async () => {
    const sched = fakeScheduler();
    const hb = { count: 0 };
    const routes = {
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/heartbeat': { status: 204, body: {} },
    };
    // count heartbeat POSTs by wrapping fetch
    const base = fakeFetch(routes).impl;
    const countingFetch = async (url, init) => { if (url.endsWith('/devices/heartbeat')) hb.count++; return base(url, init); };
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc', fetch: countingFetch, now: () => 1_700_000_000_000,
      version: '9.9.9', setInterval: sched.setInterval, clearInterval: sched.clearInterval,
    });

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect(hb.count).toBe(1);        // immediate beat on login
    await sched.tick();
    expect(hb.count).toBe(2);        // scheduled beat
  });

  test('status() resuming a persisted session starts heartbeats', async () => {
    const sched = fakeScheduler();
    // pre-seed a stored refresh token so status() resumes without a fresh login
    const fs = fakeFs();
    const login = createAccountService({ baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs, filePath: '/cfg/token.enc', fetch: fakeFetch({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } } }).impl, now: () => 1_700_000_000_000 });
    await login.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    // fresh service instance (app relaunch) over the same token file
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs, filePath: '/cfg/token.enc',
      fetch: fakeFetch({ '/token/refresh': { status: 200, body: { accessToken: jwt() } }, '/devices/heartbeat': { status: 204, body: {} } }).impl,
      now: () => 1_700_000_000_000, version: '9.9.9', setInterval: sched.setInterval, clearInterval: sched.clearInterval,
    });

    expect(await service.status()).toEqual({ signedIn: true });
    expect(sched.hasCallback()).toBe(true);   // heartbeat loop is running
  });

  test('logout stops presence heartbeats', async () => {
    const sched = fakeScheduler();
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc', fetch: fakeFetch({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } }, '/devices/heartbeat': { status: 204, body: {} } }).impl,
      now: () => 1_700_000_000_000, version: '9.9.9', setInterval: sched.setInterval, clearInterval: sched.clearInterval,
    });

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect(sched.hasCallback()).toBe(true);
    await service.logout();
    expect(sched.hasCallback()).toBe(false);
  });

  test('logout clears the persisted session', async () => {
    const fs = fakeFs();
    const service = svc({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } } }, fs);
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect(fs.existsSync('/cfg/token.enc')).toBe(true);

    await service.logout();
    expect(fs.existsSync('/cfg/token.enc')).toBe(false);
    expect(await service.status()).toEqual({ signedIn: false });
  });
});
