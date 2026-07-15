// packages/shared/src/device-key-store.js
// Persists the device keypair (SP2 §4.4, connect-from-console) encrypted at rest
// via safeStorage (Windows DPAPI), 0600 — the private key is a fleet credential
// and never lives in plaintext. Sibling to account-token-store.js; safeStorage +
// fs are injected so this is unit-testable. The public key is stored alongside so
// the app can re-upload it without regenerating.
export function createDeviceKeyStore({ safeStorage, fs, filePath }) {
  return {
    // The saved keypair { publicKey, privateKey }, or null when absent/corrupt/
    // undecryptable (e.g. copied to a different machine/user) — caller regenerates.
    load() {
      try {
        if (!fs.existsSync(filePath)) return null;
        const json = safeStorage.decryptString(fs.readFileSync(filePath));
        const pair = JSON.parse(json);
        if (pair && typeof pair.publicKey === 'string' && typeof pair.privateKey === 'string') {
          return { publicKey: pair.publicKey, privateKey: pair.privateKey };
        }
        return null;
      } catch {
        return null;
      }
    },

    save(pair) {
      const encrypted = safeStorage.encryptString(
        JSON.stringify({ publicKey: pair.publicKey, privateKey: pair.privateKey }),
      );
      fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
    },
  };
}
