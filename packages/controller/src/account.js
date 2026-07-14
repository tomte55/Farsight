// packages/controller/src/account.js
// Main-process account service (SP2): wires the shared account client + session
// + encrypted token store into the operations the IPC layer exposes to the
// renderer (login / logout / status / fleet). Deps are injected so it's
// unit-tested; main.js constructs it with the real Electron safeStorage,
// node:fs, global fetch, and a token file under userData.

import { createAccountClient } from '@farsight/shared/account-client';
import { createAccountSession } from '@farsight/shared/account-session';
import { createTokenStore } from '@farsight/shared/account-token-store';

// The maintainer's deployed account service (M-… SP2). Overridable via config/env.
export const DEFAULT_ACCOUNT_URL = 'https://auth.sovexa.org';

export function createAccountService({ baseUrl = DEFAULT_ACCOUNT_URL, safeStorage, fs, filePath, fetch, now } = {}) {
  const client = createAccountClient({ baseUrl, fetch });
  const store = createTokenStore({ safeStorage, fs, filePath });
  const session = createAccountSession({ client, store, ...(now ? { now } : {}) });

  return {
    login: (input) => session.login(input),
    logout: () => session.logout(),
    register: (input) => client.register(input),
    verifyEmail: (input) => client.verifyEmail(input),
    requestPasswordReset: (input) => client.requestPasswordReset(input),

    // Cheap sign-in check (also resumes a persisted session on first call).
    async status() {
      const token = await session.getAccessToken();
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
