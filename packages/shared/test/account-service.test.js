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

  test('logout revokes this device server-side before clearing (so it leaves the fleet)', async () => {
    const ff = fakeFetch({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/revoke': { status: 200, body: { ok: true } },
    });
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc', fetch: ff.impl, now: () => 1_700_000_000_000,
    });

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    await service.logout();

    const revoke = ff.calls.find((c) => c.url.endsWith('/devices/revoke'));
    expect(revoke).toBeTruthy();
    expect(JSON.parse(revoke.init.body)).toEqual({ deviceId: 'd1' });
    expect(revoke.init.headers.authorization).toMatch(/^Bearer /);
    // and the session is signed out afterwards
    expect(await service.status()).toEqual({ signedIn: false });
  });

  test('logout still clears locally even if the server revoke fails (offline)', async () => {
    const fs = fakeFs();
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs,
      filePath: '/cfg/token.enc',
      // no /devices/revoke route → 404; logout must not throw and must still clear
      fetch: fakeFetch({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } } }).impl,
      now: () => 1_700_000_000_000,
    });

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    await expect(service.logout()).resolves.not.toThrow();
    expect(fs.existsSync('/cfg/token.enc')).toBe(false);
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

describe('connect-from-console: device keypair lifecycle', () => {
  test('login generates + persists a keypair and uploads the public key', async () => {
    const ff = fakeFetch({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/key': { status: 200, body: { ok: true } },
      '/devices/heartbeat': { status: 200, body: {} },
    });
    const fs = fakeFs();
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs,
      filePath: '/cfg/token.enc', deviceKeyFilePath: '/cfg/device.key',
      fetch: ff.impl, now: () => 1_700_000_000_000,
    });

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    const upload = ff.calls.find((c) => c.url.endsWith('/devices/key'));
    expect(upload).toBeTruthy();
    const sentKey = JSON.parse(upload.init.body).publicKey;
    expect(sentKey).toBe(service.getPublicKey());       // uploaded our real public key
    expect(fs.existsSync('/cfg/device.key')).toBe(true); // persisted encrypted
  });

  test('the keypair persists across service instances (relaunch reuses it)', async () => {
    const fs = fakeFs();
    const mk = () => createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs,
      filePath: '/cfg/token.enc', deviceKeyFilePath: '/cfg/device.key',
      fetch: fakeFetch({}).impl, now: () => 1_700_000_000_000,
    });
    const first = mk().getPublicKey();
    const second = mk().getPublicKey(); // new instance, same key file
    expect(second).toBe(first);
  });

  test('signTranscript + verifyTranscript round-trip with the device key', () => {
    const service = svc({});
    const pub = service.getPublicKey();
    const sig = service.signTranscript('the-transcript');
    expect(service.verifyTranscript(pub, 'the-transcript', sig)).toBe(true);
    expect(service.verifyTranscript(pub, 'tampered', sig)).toBe(false);
  });

  test('isAccountPublicKey is true only for a key in the owner fleet (fail-closed)', async () => {
    const service = svc({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/key': { status: 200, body: {} },
      '/devices/heartbeat': { status: 200, body: {} },
      '/devices': { status: 200, body: { devices: [{ id: 'd1', name: 'PC', online: true, publicKey: 'ENROLLED' }] } },
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    expect(await service.isAccountPublicKey('ENROLLED')).toBe(true);
    expect(await service.isAccountPublicKey('STRANGER')).toBe(false);
  });

  test('isAccountPublicKey is false when signed out (fail-closed)', async () => {
    const service = svc({});
    expect(await service.isAccountPublicKey('ANY')).toBe(false);
  });

  test('classifyPublicKey → fleet for own device, contact for a contact device, null otherwise', async () => {
    const service = svc({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/key': { status: 200, body: {} },
      '/devices/heartbeat': { status: 200, body: {} },
      '/devices': { status: 200, body: { devices: [{ id: 'd1', publicKey: 'MINE', online: true }] } },
      '/contacts': { status: 200, body: { accepted: [{ contactUserId: 'u2', deviceId: 'd2', publicKey: 'CONTACT', online: true }], incoming: [], outgoing: [] } },
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect(await service.classifyPublicKey('MINE')).toBe('fleet');
    expect(await service.classifyPublicKey('CONTACT')).toBe('contact');
    expect(await service.classifyPublicKey('STRANGER')).toBe(null);
  });

  test('isTransferPeerKey is true for a fleet OR contact key, false for a stranger and when signed out', async () => {
    const service = svc({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/key': { status: 200, body: {} },
      '/devices/heartbeat': { status: 200, body: {} },
      '/devices': { status: 200, body: { devices: [{ id: 'd1', publicKey: 'MINE', online: true }] } },
      '/contacts': { status: 200, body: { accepted: [{ deviceId: 'd2', publicKey: 'CONTACT', online: true }], incoming: [], outgoing: [] } },
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect(await service.isTransferPeerKey('MINE')).toBe(true);
    expect(await service.isTransferPeerKey('CONTACT')).toBe(true);
    expect(await service.isTransferPeerKey('STRANGER')).toBe(false);

    const signedOut = svc({});
    expect(await signedOut.isTransferPeerKey('ANY')).toBe(false);
    expect(await signedOut.classifyPublicKey('ANY')).toBe(null);
  });

  test('addContact/acceptContact/declineContact are token-gated and proxy the client', async () => {
    const service = svc({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/key': { status: 200, body: {} },
      '/devices/heartbeat': { status: 200, body: {} },
      '/contacts/add': { status: 200, body: { contactId: 'c1' } },
      '/contacts/accept': { status: 200, body: { ok: true } },
      '/contacts/decline': { status: 200, body: { ok: true } },
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect((await service.addContact('dad@x.y')).data).toEqual({ contactId: 'c1' });
    expect((await service.acceptContact('c1')).ok).toBe(true);
    expect((await service.declineContact('c1')).ok).toBe(true);

    const out = svc({});
    expect(await out.addContact('x@y.z')).toEqual({ ok: false, error: 'not_signed_in' });
  });
});

describe('verbose diagnostic logging: uploadDiagnostics', () => {
  test('uploads with the session access token once signed in', async () => {
    const ff = fakeFetch({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/diagnostics': { status: 200, body: { id: 'diag-1' } },
    });
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc', fetch: ff.impl, now: () => 1_700_000_000_000,
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    const res = await service.uploadDiagnostics({ meta: { app: 'host' }, files: { 'main.log': 'x' } });
    expect(res).toEqual({ ok: true, status: 200, data: { id: 'diag-1' } });
    const call = ff.calls.find((c) => c.url.endsWith('/diagnostics'));
    expect(call.init.headers.authorization).toMatch(/^Bearer /);
    expect(JSON.parse(call.init.body)).toEqual({ meta: { app: 'host' }, files: { 'main.log': 'x' } });
  });

  test('is not_signed_in when signed out (never calls the server)', async () => {
    const service = svc({});
    expect(await service.uploadDiagnostics({ meta: {}, files: {} })).toEqual({ ok: false, error: 'not_signed_in' });
  });
});

describe('remote update (S2.7)', () => {
  test('requestDeviceUpdate posts the target version once signed in', async () => {
    const ff = fakeFetch({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/heartbeat': { status: 200, body: {} },
      '/devices/update': { status: 200, body: { ok: true } },
    });
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc', fetch: ff.impl, now: () => 1_700_000_000_000,
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    const res = await service.requestDeviceUpdate('host-dev', '1.8.0');
    expect(res.ok).toBe(true);
    const call = ff.calls.find((c) => c.url.endsWith('/devices/update'));
    expect(JSON.parse(call.init.body)).toEqual({ deviceId: 'host-dev', targetVersion: '1.8.0' });
  });

  test('requestDeviceUpdate is not_signed_in when signed out', async () => {
    const service = svc({});
    expect(await service.requestDeviceUpdate('x', '1.8.0')).toEqual({ ok: false, error: 'not_signed_in' });
  });

  test('revokeDevice removes a fleet device server-side (token-gated)', async () => {
    const ff = fakeFetch({
      '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
      '/devices/heartbeat': { status: 200, body: {} },
      '/devices/revoke': { status: 200, body: { ok: true } },
    });
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc', fetch: ff.impl, now: () => 1_700_000_000_000,
    });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });

    const res = await service.revokeDevice('stale-dev');
    expect(res.ok).toBe(true);
    const call = ff.calls.find((c) => c.url.endsWith('/devices/revoke'));
    expect(JSON.parse(call.init.body)).toEqual({ deviceId: 'stale-dev' });
    expect(call.init.headers.authorization).toMatch(/^Bearer /);
  });

  test('revokeDevice is not_signed_in when signed out, invalid_request without an id', async () => {
    const signedOut = svc({});
    expect(await signedOut.revokeDevice('x')).toEqual({ ok: false, error: 'not_signed_in' });

    const service = svc({ '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } } });
    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' });
    expect(await service.revokeDevice()).toEqual({ ok: false, error: 'invalid_request' });
  });

  test('onUpdateDirective fires with the heartbeat directive on login', async () => {
    const sched = fakeScheduler();
    const service = createAccountService({
      baseUrl: 'https://auth.example', safeStorage: fakeSafeStorage, fs: fakeFs(),
      filePath: '/cfg/token.enc',
      fetch: fakeFetch({
        '/login': { status: 200, body: { accessToken: jwt(), refreshToken: 'r1', deviceId: 'd1' } },
        '/devices/heartbeat': { status: 200, body: { targetVersion: '1.9.0' } },
      }).impl,
      now: () => 1_700_000_000_000, version: '1.7.0', setInterval: sched.setInterval, clearInterval: sched.clearInterval,
    });
    const seen = [];
    service.onUpdateDirective((d) => seen.push(d));

    await service.login({ email: 'a@b.c', password: 'pw', deviceName: 'ctrl' }); // triggers an immediate beat

    expect(seen).toEqual([{ targetVersion: '1.9.0' }]);
  });
});
