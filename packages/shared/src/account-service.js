// packages/shared/src/account-service.js
// Main-process account service (SP2), shared by BOTH apps (controller console +
// host enrollment). Wires the account client + session + encrypted token store
// into the operations the IPC layer exposes to a renderer (login / logout /
// status / fleet), and drives the presence heartbeat (SP2 S2.5) so a signed-in
// app shows up online + versioned in the owner's fleet console. Runtime-agnostic:
// safeStorage, fs, fetch, the app version, and the scheduler are all injected, so
// each app's main.js constructs it with the real Electron safeStorage, node:fs,
// global fetch, and app.getVersion(); tests inject fakes.

import { createAccountClient } from './account-client.js';
import { createAccountSession } from './account-session.js';
import { createTokenStore } from './account-token-store.js';
import { createHeartbeat } from './account-heartbeat.js';

// The maintainer's deployed account service (SP2). Overridable via config/env.
export const DEFAULT_ACCOUNT_URL = 'https://auth.sovexa.org';

export function createAccountService({
  baseUrl = DEFAULT_ACCOUNT_URL,
  safeStorage, fs, filePath, fetch, now,
  version, intervalMs, setInterval: setI, clearInterval: clearI,
} = {}) {
  const client = createAccountClient({ baseUrl, fetch });
  const store = createTokenStore({ safeStorage, fs, filePath });
  const session = createAccountSession({ client, store, ...(now ? { now } : {}) });
  const heartbeat = createHeartbeat({
    session, client, version,
    ...(intervalMs ? { intervalMs } : {}),
    ...(setI ? { setInterval: setI } : {}),
    ...(clearI ? { clearInterval: clearI } : {}),
  });

  return {
    async login(input) {
      const res = await session.login(input);
      if (res.ok) await heartbeat.start(); // report presence once signed in
      return res;
    },
    async logout() {
      heartbeat.stop();
      // Revoke this device server-side so it leaves the owner's fleet (and its
      // refresh token dies) — not just a local token wipe. Best-effort: if we're
      // offline or it fails, still clear locally so sign-out always completes.
      const deviceId = session.getDeviceId();
      if (deviceId) {
        const token = await session.getAccessToken();
        if (token) {
          try { await client.revokeDevice({ accessToken: token, deviceId }); } catch { /* clear locally anyway */ }
        }
      }
      return session.logout();
    },
    register: (input) => client.register(input),
    verifyEmail: (input) => client.verifyEmail(input),
    resendVerification: (input) => client.resendVerification(input),
    requestPasswordReset: (input) => client.requestPasswordReset(input),

    // Cheap sign-in check (also resumes a persisted session on first call, and
    // starts heartbeating so a resumed session begins reporting presence).
    async status() {
      const token = await session.getAccessToken();
      if (token) await heartbeat.start();
      return { signedIn: !!token };
    },

    // The saved-hosts fleet — devices under the account with presence/version.
    async fleet() {
      const token = await session.getAccessToken();
      if (!token) return { ok: false, error: 'not_signed_in' };
      return client.listDevices({ accessToken: token });
    },
  };
}
