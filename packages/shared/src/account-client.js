// packages/shared/src/account-client.js
// Client for the self-hosted account service (auth.sovexa.org, SP2 §4.4). Pure,
// runtime-agnostic (uses global fetch — present in Node 18+ and Electron; the
// host/controller MAIN processes use this to register/login/refresh/heartbeat/
// list-devices). fetch is injectable for tests. Every call resolves to a
// normalized result — { ok:true, status, data } or { ok:false, status, error }
// — and NEVER throws on an HTTP or network error, so callers branch on `ok`.

export function createAccountClient({ baseUrl, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('createAccountClient: no fetch available');
  const base = String(baseUrl ?? '').replace(/\/+$/, '');

  async function request(method, path, { body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { ok: false, status: 0, error: 'network_error' };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok) return { ok: true, status: res.status, data: data ?? {} };
    return { ok: false, status: res.status, error: (data && data.error) || 'error' };
  }

  return {
    // ── public account lifecycle ──────────────────────────────────────────
    register: (input) => request('POST', '/register', { body: input }),
    verifyEmail: (input) => request('POST', '/verify-email', { body: input }),
    resendVerification: (input) => request('POST', '/resend-verification', { body: input }),
    requestPasswordReset: (input) => request('POST', '/request-password-reset', { body: input }),
    confirmPasswordReset: (input) => request('POST', '/confirm-password-reset', { body: input }),
    login: (input) => request('POST', '/login', { body: input }),
    refresh: ({ refreshToken }) => request('POST', '/token/refresh', { body: { refreshToken } }),

    // ── authenticated self-management (Bearer access token) ───────────────
    heartbeat: ({ accessToken, version, signalingId }) =>
      request('POST', '/devices/heartbeat', { body: { version, signalingId }, token: accessToken }),
    // Connect-from-console (§4.4): enroll this device's account-issued public key.
    uploadPublicKey: ({ accessToken, publicKey }) =>
      request('POST', '/devices/key', { body: { publicKey }, token: accessToken }),
    listDevices: ({ accessToken }) => request('GET', '/devices', { token: accessToken }),
    revokeDevice: ({ accessToken, deviceId }) =>
      request('POST', '/devices/revoke', { body: { deviceId }, token: accessToken }),
    // Remote update (S2.7): set a converge-to target version on one of the owner's
    // devices (null clears it). The host acts on it via its heartbeat response.
    requestUpdate: ({ accessToken, deviceId, targetVersion }) =>
      request('POST', '/devices/update', { body: { deviceId, targetVersion }, token: accessToken }),
    beginTotp: ({ accessToken }) => request('POST', '/2fa/begin', { body: {}, token: accessToken }),
    confirmTotp: ({ accessToken, code }) =>
      request('POST', '/2fa/confirm', { body: { code }, token: accessToken }),
    disableTotp: ({ accessToken }) => request('POST', '/2fa/disable', { body: {}, token: accessToken }),
  };
}
