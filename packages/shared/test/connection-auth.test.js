import { describe, it, expect } from 'vitest';
import { createConnectionAuth, runConnectionAuth } from '../src/connection-auth.js';

// A pair of in-memory channels that deliver to each other (mirrors two ends of an
// RTCDataChannel). readyState 'open' so the pump starts immediately.
function channelPair() {
  const a = { readyState: 'open', onmessage: null, send: (m) => queueMicrotask(() => b.onmessage && b.onmessage({ data: m })) };
  const b = { readyState: 'open', onmessage: null, send: (m) => queueMicrotask(() => a.onmessage && a.onmessage({ data: m })) };
  return [a, b];
}

// Deterministic crypto fakes: a "signature" is `${pub}priv|${message}` (the fake
// private key is `${pub}priv`), and verify checks that exact shape. isAccountKey
// checks membership in the provided enrolled-key set.
function makeCrypto(accountKeys) {
  return {
    sign: async (priv, m) => `${priv}|${m}`,
    verify: async (pub, m, sig) => sig === `${pub}priv|${m}`,
    isAccountKey: async (pub) => accountKeys.includes(pub),
  };
}

function makePair(accountKeys, { ctrlLocalFp = 'AA', hostLocalFp = 'BB' } = {}) {
  const crypto = makeCrypto(accountKeys);
  let n = 0;
  const nonce = () => `nonce${n++}`;
  const ctrl = createConnectionAuth({
    role: 'controller', deviceId: 'ctrlDev', publicKey: 'CPUB',
    localFingerprint: ctrlLocalFp, remoteFingerprint: hostLocalFp,
    sign: (m) => crypto.sign('CPUBpriv', m), verify: crypto.verify, isAccountKey: crypto.isAccountKey, nonce,
  });
  const host = createConnectionAuth({
    role: 'host', deviceId: 'hostDev', publicKey: 'HPUB',
    localFingerprint: hostLocalFp, remoteFingerprint: ctrlLocalFp,
    sign: (m) => crypto.sign('HPUBpriv', m), verify: crypto.verify, isAccountKey: crypto.isAccountKey, nonce,
  });
  return { ctrl, host };
}

// Drive both machines to completion over an in-memory relay.
async function run(ctrl, host) {
  const done = { controller: null, host: null };
  const machines = { controller: ctrl, host: host };
  const other = { controller: 'host', host: 'controller' };
  let from = 'controller';
  let msg = ctrl.start(); // controller opens with hello
  for (let i = 0; i < 12 && msg; i++) {
    const to = other[from];
    const r = await machines[to].handle(msg);
    if (r.done) done[to] = 'ok';
    if (r.fail) { done[to] = r.fail; break; }
    msg = r.out;
    from = to;
  }
  return done;
}

describe('connection-auth', () => {
  it('completes a mutual handshake when both keys are account devices', async () => {
    const { ctrl, host } = makePair(['CPUB', 'HPUB']);
    const done = await run(ctrl, host);
    expect(done.host).toBe('ok');
    expect(done.controller).toBe('ok');
  });

  it('host rejects a controller whose key is not an account device', async () => {
    const { ctrl, host } = makePair(['HPUB']); // CPUB not enrolled
    const done = await run(ctrl, host);
    expect(done.host).toBe('unknown_device');
  });

  it('controller rejects a host whose fingerprint was swapped (MITM)', async () => {
    // Simulate a signaling/SDP-swap MITM: the host is told the controller's
    // fingerprint is 'CTRL_SWAPPED', while the controller's real local fingerprint
    // is 'CTRL_REAL'. The host signs a transcript binding 'CTRL_SWAPPED'; the
    // controller verifies against its own transcript binding 'CTRL_REAL' → mismatch.
    const crypto = makeCrypto(['CPUB', 'HPUB']);
    let n = 0;
    const nonce = () => `nonce${n++}`;
    const ctrl = createConnectionAuth({
      role: 'controller', deviceId: 'ctrlDev', publicKey: 'CPUB',
      localFingerprint: 'CTRL_REAL', remoteFingerprint: 'HOST_REAL',
      sign: (m) => crypto.sign('CPUBpriv', m), verify: crypto.verify, isAccountKey: crypto.isAccountKey, nonce,
    });
    const host = createConnectionAuth({
      role: 'host', deviceId: 'hostDev', publicKey: 'HPUB',
      localFingerprint: 'HOST_REAL', remoteFingerprint: 'CTRL_SWAPPED',
      sign: (m) => crypto.sign('HPUBpriv', m), verify: crypto.verify, isAccountKey: crypto.isAccountKey, nonce,
    });
    const done = await run(ctrl, host);
    expect(done.controller).toBe('bad_signature');
  });

  it('host rejects a bad controller signature in the response', async () => {
    const { ctrl, host } = makePair(['CPUB', 'HPUB']);
    // Tamper: wrap the controller so its final response signature is garbage.
    const badCtrl = {
      start: () => ctrl.start(),
      handle: async (m) => {
        const r = await ctrl.handle(m);
        if (r.out && r.out.t === 'response') r.out.sig = 'garbage';
        return r;
      },
    };
    const done = await run(badCtrl, host);
    expect(done.host).toBe('bad_signature');
  });
});

describe('runConnectionAuth over paired channels', () => {
  const crypto = makeCrypto(['CPUB', 'HPUB']);
  const auth = (role, self, remote, chan, localFp, remoteFp) => {
    let n = 0;
    return runConnectionAuth({
      role, channel: chan, deviceId: self.id, publicKey: self.pub,
      localFingerprint: localFp, remoteFingerprint: remoteFp,
      sign: (m) => crypto.sign(self.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `${role}-n${n++}`, timeoutMs: 1000,
    });
  };
  const ctrl = { id: 'c', pub: 'CPUB', priv: 'CPUBpriv' };
  const host = { id: 'h', pub: 'HPUB', priv: 'HPUBpriv' };

  it('both ends resolve ok on a valid mutual handshake', async () => {
    const [ca, ha] = channelPair();
    const pC = auth('controller', ctrl, host, ca, 'AA', 'BB');
    const pH = auth('host', host, ctrl, ha, 'BB', 'AA');
    await expect(Promise.all([pC, pH])).resolves.toEqual(['ok', 'ok']);
  });

  it('rejects the host end when the controller key is not enrolled', async () => {
    const cryptoNoCtrl = makeCrypto(['HPUB']);
    const [ca, ha] = channelPair();
    let nc = 0, nh = 0;
    const pC = runConnectionAuth({ role: 'controller', channel: ca, deviceId: 'c', publicKey: 'CPUB', localFingerprint: 'AA', remoteFingerprint: 'BB', sign: (m) => cryptoNoCtrl.sign('CPUBpriv', m), verify: cryptoNoCtrl.verify, isAccountKey: cryptoNoCtrl.isAccountKey, nonce: () => `c${nc++}`, timeoutMs: 1000 });
    const pH = runConnectionAuth({ role: 'host', channel: ha, deviceId: 'h', publicKey: 'HPUB', localFingerprint: 'BB', remoteFingerprint: 'AA', sign: (m) => cryptoNoCtrl.sign('HPUBpriv', m), verify: cryptoNoCtrl.verify, isAccountKey: cryptoNoCtrl.isAccountKey, nonce: () => `h${nh++}`, timeoutMs: 1000 });
    await expect(pH).rejects.toThrow('unknown_device');
    await expect(pC).rejects.toBeInstanceOf(Error); // controller sees the peer 'fail'
  });
});
