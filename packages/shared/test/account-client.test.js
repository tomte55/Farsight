// Client for the self-hosted account service (auth.sovexa.org, SP2). Runtime-
// agnostic (uses global fetch, injectable for tests) so the host/controller main
// processes can register/login/refresh/heartbeat/list-devices. Normalizes every
// response to { ok, status, data|error } — never throws on an HTTP error.

import { describe, expect, test } from 'vitest';
import { createAccountClient } from '../src/account-client.js';

function mockFetch(...responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throwNetwork) throw new TypeError('failed to fetch');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    };
  };
  return { impl, calls };
}
const client = (fetch, baseUrl = 'https://auth.sovexa.org') =>
  createAccountClient({ baseUrl, fetch });

describe('request shape', () => {
  test('register POSTs JSON to <base>/register and returns data on 201', async () => {
    const { impl, calls } = mockFetch({ status: 201, body: { userId: 'u1' } });
    const res = await client(impl).register({ email: 'a@b.c', password: 'pw' });

    expect(res).toEqual({ ok: true, status: 201, data: { userId: 'u1' } });
    expect(calls[0].url).toBe('https://auth.sovexa.org/register');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ email: 'a@b.c', password: 'pw' });
  });

  test('a trailing slash on baseUrl is normalized', async () => {
    const { impl, calls } = mockFetch({ status: 201, body: {} });
    await client(impl, 'https://auth.sovexa.org/').register({ email: 'a@b.c', password: 'pw' });
    expect(calls[0].url).toBe('https://auth.sovexa.org/register');
  });
});

describe('error mapping', () => {
  test('a non-2xx surfaces { ok:false, status, error } from the body', async () => {
    const { impl } = mockFetch({ status: 409, body: { error: 'email_taken' } });
    const res = await client(impl).register({ email: 'dup@b.c', password: 'pw' });
    expect(res).toEqual({ ok: false, status: 409, error: 'email_taken' });
  });

  test('a network failure is caught, not thrown', async () => {
    const { impl } = mockFetch({ throwNetwork: true });
    const res = await client(impl).login({ email: 'a@b.c', password: 'pw', deviceName: 'pc' });
    expect(res).toEqual({ ok: false, status: 0, error: 'network_error' });
  });
});

describe('auth flows', () => {
  test('login returns the token bundle', async () => {
    const { impl, calls } = mockFetch({
      status: 200,
      body: { accessToken: 'a', refreshToken: 'r', deviceId: 'd' },
    });
    const res = await client(impl).login({ email: 'a@b.c', password: 'pw', deviceName: 'pc', code: '123456' });

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ accessToken: 'a', refreshToken: 'r', deviceId: 'd' });
    expect(calls[0].url).toBe('https://auth.sovexa.org/login');
    expect(JSON.parse(calls[0].init.body).code).toBe('123456');
  });

  test('refresh posts the refresh token to /token/refresh', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { accessToken: 'a2' } });
    const res = await client(impl).refresh({ refreshToken: 'r' });
    expect(res.data).toEqual({ accessToken: 'a2' });
    expect(calls[0].url).toBe('https://auth.sovexa.org/token/refresh');
  });
});

describe('authenticated (Bearer) calls', () => {
  test('heartbeat sends the access token as a Bearer header + the version', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { ok: true } });
    await client(impl).heartbeat({ accessToken: 'tok', version: '1.6.0' });

    expect(calls[0].url).toBe('https://auth.sovexa.org/devices/heartbeat');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ version: '1.6.0' });
  });

  test('heartbeat includes signalingId when provided (rendezvous)', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { ok: true } });
    await client(impl).heartbeat({ accessToken: 'tok', version: '1.7.0', signalingId: '123456789' });
    expect(JSON.parse(calls[0].init.body)).toEqual({ version: '1.7.0', signalingId: '123456789' });
  });

  test('uploadPublicKey POSTs the key to /devices/key with a Bearer header', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { ok: true } });
    const res = await client(impl).uploadPublicKey({ accessToken: 'tok', publicKey: 'PUB' });

    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe('https://auth.sovexa.org/devices/key');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ publicKey: 'PUB' });
  });

  test('requestUpdate posts the target version to /devices/update', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { ok: true } });
    const res = await client(impl).requestUpdate({ accessToken: 'tok', deviceId: 'd1', targetVersion: '1.8.0' });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe('https://auth.sovexa.org/devices/update');
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ deviceId: 'd1', targetVersion: '1.8.0' });
  });

  test('listDevices is a GET with the Bearer header and no body', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { devices: [{ id: 'd', online: true }] } });
    const res = await client(impl).listDevices({ accessToken: 'tok' });

    expect(res.data.devices).toEqual([{ id: 'd', online: true }]);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers['content-type']).toBeUndefined();
  });

  test('revokeDevice posts the deviceId with the Bearer header', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { ok: true } });
    await client(impl).revokeDevice({ accessToken: 'tok', deviceId: 'd9' });
    expect(calls[0].url).toBe('https://auth.sovexa.org/devices/revoke');
    expect(JSON.parse(calls[0].init.body)).toEqual({ deviceId: 'd9' });
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
  });

  test('listContacts is a GET with the Bearer header and no body', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { accepted: [], incoming: [], outgoing: [] } });
    const res = await client(impl).listContacts({ accessToken: 'tok' });
    expect(res.data).toEqual({ accepted: [], incoming: [], outgoing: [] });
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url.endsWith('/contacts')).toBe(true);
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBeUndefined();
  });

  test('addContact POSTs /contacts/add with the email and Bearer', async () => {
    const { impl, calls } = mockFetch({ status: 200, body: { contactId: 'c1' } });
    const res = await client(impl).addContact({ accessToken: 'tok', email: 'dad@x.y' });
    expect(res.data).toEqual({ contactId: 'c1' });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url.endsWith('/contacts/add')).toBe(true);
    expect(JSON.parse(calls[0].init.body)).toEqual({ email: 'dad@x.y' });
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
  });
  test('acceptContact / declineContact POST the contactId with Bearer', async () => {
    const a = mockFetch({ status: 200, body: { ok: true } });
    await client(a.impl).acceptContact({ accessToken: 'tok', contactId: 'c1' });
    expect(a.calls[0].url.endsWith('/contacts/accept')).toBe(true);
    expect(JSON.parse(a.calls[0].init.body)).toEqual({ contactId: 'c1' });
    const d = mockFetch({ status: 200, body: { ok: true } });
    await client(d.impl).declineContact({ accessToken: 'tok', contactId: 'c1' });
    expect(d.calls[0].url.endsWith('/contacts/decline')).toBe(true);
    expect(JSON.parse(d.calls[0].init.body)).toEqual({ contactId: 'c1' });
  });
});
