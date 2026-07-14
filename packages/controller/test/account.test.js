// Controller main-process account service (SP2): wires the shared account
// client + session + encrypted token store and exposes the operations the IPC
// layer / renderer need (login, logout, status, fleet). Deps injected
// (safeStorage, fs, fetch) so the wiring is unit-tested; main.js passes the real
// Electron safeStorage + node:fs.

import { describe, expect, test } from 'vitest';
import { createAccountService, DEFAULT_ACCOUNT_URL } from '../src/account.js';

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
