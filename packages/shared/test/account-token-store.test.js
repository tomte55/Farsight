// Persistent store for the refresh token (SP2 §4.4): encrypted at rest via
// Electron safeStorage (Windows DPAPI). Implements the account-session store
// interface. safeStorage + fs are injected so the file logic is fully tested;
// only the real Electron safeStorage binding is left as an untested seam. Only
// the REFRESH token is persisted — the access token stays in memory.

import { describe, expect, test } from 'vitest';
import { createTokenStore } from '../src/account-token-store.js';

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (buf) => Buffer.from(buf).toString().replace(/^enc:/, ''),
};

function fakeFs() {
  const files = new Map();
  const writes = [];
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data, opts) => {
      files.set(p, data);
      writes.push({ p, data, opts });
    },
    rmSync: (p) => files.delete(p),
    _files: files,
    _writes: writes,
  };
}

const PATH = '/cfg/refresh.enc';
const make = (fs) => createTokenStore({ safeStorage: fakeSafeStorage, fs, filePath: PATH });

describe('createTokenStore', () => {
  test('round-trips the refresh token, encrypted at rest (0600)', async () => {
    const fs = fakeFs();
    const store = make(fs);

    await store.setTokens({ accessToken: 'a-access', refreshToken: 'r-refresh' });
    expect(await store.getRefreshToken()).toBe('r-refresh');

    // stored bytes are ciphertext, not the plaintext token
    const onDisk = fs._files.get(PATH).toString();
    expect(onDisk).not.toBe('r-refresh');
    expect(onDisk).toBe('enc:r-refresh');
    // written with restrictive perms
    expect(fs._writes[0].opts).toMatchObject({ mode: 0o600 });
  });

  test('only the refresh token is persisted — never the access token', async () => {
    const fs = fakeFs();
    await make(fs).setTokens({ accessToken: 'SECRET-ACCESS', refreshToken: 'r' });
    expect(fs._files.get(PATH).toString()).not.toContain('SECRET-ACCESS');
  });

  test('returns null when nothing is stored', async () => {
    expect(await make(fakeFs()).getRefreshToken()).toBeNull();
  });

  test('returns null (not throw) on a corrupt/undecryptable file', async () => {
    const fs = fakeFs();
    const throwing = {
      ...fakeSafeStorage,
      decryptString: () => {
        throw new Error('bad ciphertext');
      },
    };
    fs.writeFileSync(PATH, Buffer.from('garbage'));
    const store = createTokenStore({ safeStorage: throwing, fs, filePath: PATH });
    expect(await store.getRefreshToken()).toBeNull();
  });

  test('clear removes the file', async () => {
    const fs = fakeFs();
    const store = make(fs);
    await store.setTokens({ refreshToken: 'r' });
    await store.clear();
    expect(fs.existsSync(PATH)).toBe(false);
    expect(await store.getRefreshToken()).toBeNull();
  });
});
