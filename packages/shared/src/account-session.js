// packages/shared/src/account-session.js
// Client-side session lifecycle over the account client (SP2 §4.4). Pure and
// runtime-agnostic: the access token lives in memory; the long-lived refresh
// token lives in an injected `store` (the Electron safeStorage/DPAPI adapter
// implements the store interface). getAccessToken auto-refreshes when the cached
// token is expired/near-expiry, and resumes a session on app relaunch from the
// stored refresh token. The clock is injected for deterministic tests.
//
// store interface: { getRefreshToken(): Promise<string|null>,
//                    setTokens({accessToken, refreshToken}): Promise<void>,
//                    clear(): Promise<void> }

// Decode a JWT payload WITHOUT verifying it — purely for client-side use (refresh
// scheduling, reading our own deviceId). Returns the parsed claims, or null on
// anything malformed.
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// A JWT's `exp` as epoch ms, or null.
export function jwtExpMs(token) {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

export function createAccountSession({ client, store, now = () => Date.now(), skewMs = 30_000 }) {
  let accessToken = null;
  let accessExp = null; // epoch ms, or null
  let deviceId = null;  // this install's device row id (for self-revoke on logout)

  const cache = (token) => {
    accessToken = token;
    accessExp = jwtExpMs(token);
    const dev = decodeJwtPayload(token)?.deviceId;
    if (typeof dev === 'string') deviceId = dev;
  };

  async function refreshAccess() {
    const refreshToken = await store.getRefreshToken();
    if (!refreshToken) return null;
    const res = await client.refresh({ refreshToken });
    if (!res.ok) return null;
    cache(res.data.accessToken);
    // Keep the same refresh token; persist so the store stays authoritative.
    await store.setTokens({ accessToken: res.data.accessToken, refreshToken });
    return accessToken;
  }

  return {
    async login(input) {
      const res = await client.login(input);
      if (!res.ok) return res; // { ok:false, status, error }
      cache(res.data.accessToken);
      deviceId = res.data.deviceId ?? deviceId;
      await store.setTokens({ accessToken: res.data.accessToken, refreshToken: res.data.refreshToken });
      return { ok: true, deviceId: res.data.deviceId };
    },

    // This install's device id (from login, or decoded from a resumed access
    // token), or null before any login/resume. Used to self-revoke on logout.
    getDeviceId() {
      return deviceId;
    },

    // A currently-valid access token, refreshing if needed. null when there's no
    // usable session (no stored refresh token, or refresh was rejected).
    async getAccessToken() {
      if (accessToken && accessExp && now() < accessExp - skewMs) return accessToken;
      return refreshAccess();
    },

    async logout() {
      accessToken = null;
      accessExp = null;
      deviceId = null;
      await store.clear();
    },
  };
}
