import { describe, it, expect } from 'vitest';
import { createDeviceKeyStore } from '../src/device-key-store.js';

// In-memory fakes mirroring safeStorage + fs (reversible "encryption").
function fakes() {
  const files = new Map();
  const safeStorage = {
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => Buffer.from(b).toString().replace(/^enc:/, ''),
  };
  const fs = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync: (p, data) => files.set(p, Buffer.from(data)),
    rmSync: (p) => files.delete(p),
  };
  return { safeStorage, fs, files };
}

describe('device-key-store', () => {
  it('returns null when no keypair is saved', () => {
    const { safeStorage, fs } = fakes();
    expect(createDeviceKeyStore({ safeStorage, fs, filePath: '/k' }).load()).toBe(null);
  });

  it('round-trips a saved keypair', () => {
    const { safeStorage, fs } = fakes();
    const store = createDeviceKeyStore({ safeStorage, fs, filePath: '/k' });
    store.save({ publicKey: 'PUB', privateKey: 'PRIV' });
    expect(store.load()).toEqual({ publicKey: 'PUB', privateKey: 'PRIV' });
  });

  it('writes the file 0600', () => {
    const { safeStorage, fs } = fakes();
    let mode;
    fs.writeFileSync = (p, d, opts) => { mode = opts?.mode; };
    createDeviceKeyStore({ safeStorage, fs, filePath: '/k' }).save({ publicKey: 'a', privateKey: 'b' });
    expect(mode).toBe(0o600);
  });

  it('returns null on a corrupt file', () => {
    const { safeStorage, fs, files } = fakes();
    files.set('/k', Buffer.from('enc:not-json'));
    expect(createDeviceKeyStore({ safeStorage, fs, filePath: '/k' }).load()).toBe(null);
  });
});
