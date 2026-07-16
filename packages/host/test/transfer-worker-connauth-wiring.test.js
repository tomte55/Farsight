import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// SP3 Phase 4: the transfer worker runs the own-fleet device-keypair handshake
// (shared/connection-auth.js) over its dedicated 'auth' data channel. The crypto
// stays in MAIN — the worker preload only bridges the existing process-wide
// conn-auth:* IPC handlers (registered at module top in main.js) into the worker
// window, mirroring the visible renderer's connAuth* bridge.
describe('transfer-worker conn-auth bridge (host)', () => {
  const preload = read('../src/transfer-worker-preload.cjs');

  it('exposes a farsightConnAuth bridge to the worker', () => {
    expect(preload).toMatch(/farsightConnAuth/);
  });

  it('bridges the conn-auth IPC operations incl. the transfer-only peer predicate', () => {
    for (const topic of ['conn-auth:device-id', 'conn-auth:public-key', 'conn-auth:sign', 'conn-auth:verify', 'conn-auth:is-account-key', 'conn-auth:is-transfer-peer-key']) {
      expect(preload).toContain(topic);
    }
  });

  it('main registers the conn-auth handlers process-wide so the worker can reach them', () => {
    expect(read('../src/main.js')).toMatch(/ipcMain\.handle\('conn-auth:sign'/);
  });

  it('main registers the transfer-only peer-key handler', () => {
    expect(read('../src/main.js')).toMatch(/ipcMain\.handle\('conn-auth:is-transfer-peer-key'/);
  });

  it('the transfer worker handshake authenticates the peer via isTransferPeerKey (fleet OR contact), not the fleet-only isAccountKey', () => {
    const worker = read('../src/transfer-worker/worker.js');
    expect(worker).toMatch(/isAccountKey:\s*\(pk\)\s*=>\s*\{[\s\S]*?window\.farsightConnAuth\.isTransferPeerKey\(pk\)/);
  });

  // SP3 Task 5: the worker captures the device-keypair-VERIFIED peer's publicKey
  // in the isAccountKey closure and reports it to main on auth-ok, so main can
  // classify the peer (fleet vs contact) for the consent decision (Task 6).
  it('reports the verified peer to main on auth-ok', () => {
    const worker = read('../src/transfer-worker/worker.js');
    expect(worker).toMatch(/reportPeerAuth/);            // worker reports the peer
    const wrapper = read('../src/transfer-worker.js');
    expect(wrapper).toMatch(/onPeerAuth/);               // main-side callback exists
    const preload = read('../src/transfer-worker-preload.cjs');
    expect(preload).toMatch(/reportPeerAuth/);           // preload bridge exists
  });
});
