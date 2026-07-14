// packages/controller/src/account.js
// Main-process account service (SP2): wires the shared account client + session
// + encrypted token store into the operations the IPC layer exposes to the
// renderer (login / logout / status / fleet), and drives the presence heartbeat
// (SP2 S2.5) so a signed-in app shows up online + versioned in the owner's fleet
// console. Deps are injected so it's unit-tested; main.js constructs it with the
// real Electron safeStorage, node:fs, global fetch, app version, and a token
// file under userData.

import { createAccountClient } from '@farsight/shared/account-client';
import { createAccountSession } from '@farsight/shared/account-session';
import { createTokenStore } from '@farsight/shared/account-token-store';
import { createHeartbeat } from '@farsight/shared/account-heartbeat';

// The maintainer's deployed account service (M-… SP2). Overridable via config/env.
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
      return session.logout();
    },
    register: (input) => client.register(input),
    verifyEmail: (input) => client.verifyEmail(input),
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
