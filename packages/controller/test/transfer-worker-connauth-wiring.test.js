import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// SP3 Phase 4: the transfer worker runs the own-fleet device-keypair handshake
// (shared/connection-auth.js) over its dedicated 'auth' data channel. The crypto
// stays in MAIN — the worker preload only bridges the existing process-wide
// conn-auth:* IPC handlers (registered at module top in main.js) into the worker
// window, mirroring the visible renderer's connAuth* bridge.
describe('transfer-worker conn-auth bridge (controller)', () => {
  const preload = read('../src/transfer-worker-preload.cjs');

  it('exposes a farsightConnAuth bridge to the worker', () => {
    expect(preload).toMatch(/farsightConnAuth/);
  });

  it('bridges all five conn-auth IPC operations via invoke', () => {
    for (const topic of ['conn-auth:device-id', 'conn-auth:public-key', 'conn-auth:sign', 'conn-auth:verify', 'conn-auth:is-account-key']) {
      expect(preload).toContain(topic);
    }
  });

  it('main registers the conn-auth handlers process-wide so the worker can reach them', () => {
    expect(read('../src/main.js')).toMatch(/ipcMain\.handle\('conn-auth:sign'/);
  });
});
