// packages/shared/src/account-token-store.js
// Persistent store for the refresh token (SP2 §4.4), implementing the
// account-session store interface. The refresh token is the long-lived fleet
// credential, so it is encrypted at rest via Electron safeStorage (Windows
// DPAPI) and written 0600 — never plaintext. The short-lived access token is
// NOT persisted (it stays in memory). safeStorage + fs are injected so this is
// unit-testable; the real wiring passes Electron's safeStorage and node:fs.

export function createTokenStore({ safeStorage, fs, filePath }) {
  return {
    async getRefreshToken() {
      try {
        if (!fs.existsSync(filePath)) return null;
        const encrypted = fs.readFileSync(filePath);
        return safeStorage.decryptString(encrypted);
      } catch {
        // Missing, corrupt, or undecryptable (e.g. different machine/user) →
        // treat as no session rather than crashing the app.
        return null;
      }
    },

    async setTokens({ refreshToken }) {
      const encrypted = safeStorage.encryptString(refreshToken);
      fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
    },

    async clear() {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // already gone — fine
      }
    },
  };
}
