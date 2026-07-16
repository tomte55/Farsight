// packages/shared/test/connection-auth-logging.test.js
// Verifies runConnectionAuth logs handshake lifecycle (begin/ok/failed-reason)
// through an injected `log`, and never leaks signature/private-key material.
// Deliberately does NOT import connection-auth.test.js's crasher-adjacent file;
// this suite drives its own in-memory channel pair + bounded timeoutMs so it
// resolves purely on microtasks (safe per task-4 test-running rules).
import { describe, it, expect } from 'vitest';
import { runConnectionAuth } from '../src/connection-auth.js';

// Mirrors the pattern in connection-auth.test.js: two ends of an in-memory
// channel that deliver to each other via queueMicrotask; readyState 'open' so
// the pump starts immediately.
function channelPair() {
  const a = { readyState: 'open', onmessage: null, send: (m) => queueMicrotask(() => b.onmessage && b.onmessage({ data: m })) };
  const b = { readyState: 'open', onmessage: null, send: (m) => queueMicrotask(() => a.onmessage && a.onmessage({ data: m })) };
  return [a, b];
}

// Deterministic crypto fakes (same shape as connection-auth.test.js): a
// "signature" is `${priv}|${message}`; verify checks that exact shape.
function makeCrypto(accountKeys, { verifyOverride } = {}) {
  return {
    sign: async (priv, m) => `${priv}|${m}`,
    verify: verifyOverride ?? (async (pub, m, sig) => sig === `${pub}priv|${m}`),
    isAccountKey: async (pub) => accountKeys.includes(pub),
  };
}

// Recording logger per the brief's snippet.
function makeLog() {
  const calls = [];
  const mk = () => ({
    debug: (m) => calls.push(m),
    info: (m) => calls.push(m),
    warn: (m) => calls.push(m),
    error: (m) => calls.push(m),
    child: mk,
  });
  return { log: mk(), calls };
}

const ctrlId = { id: 'c', pub: 'CPUB', priv: 'CPUBpriv' };
const hostId = { id: 'h', pub: 'HPUB', priv: 'HPUBpriv' };

describe('connection-auth handshake logging', () => {
  it('logs "handshake begin" and "handshake ok" on a successful mutual handshake', async () => {
    const crypto = makeCrypto(['CPUB', 'HPUB']);
    const [ca, ha] = channelPair();
    const ctrlLog = makeLog();
    const hostLog = makeLog();
    let nc = 0, nh = 0;

    const pC = runConnectionAuth({
      role: 'controller', channel: ca, deviceId: ctrlId.id, publicKey: ctrlId.pub,
      localFingerprint: 'AA', remoteFingerprint: 'BB',
      sign: (m) => crypto.sign(ctrlId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `c${nc++}`, timeoutMs: 1000, log: ctrlLog.log,
    });
    const pH = runConnectionAuth({
      role: 'host', channel: ha, deviceId: hostId.id, publicKey: hostId.pub,
      localFingerprint: 'BB', remoteFingerprint: 'AA',
      sign: (m) => crypto.sign(hostId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `h${nh++}`, timeoutMs: 1000, log: hostLog.log,
    });

    await expect(Promise.all([pC, pH])).resolves.toEqual(['ok', 'ok']);

    for (const { calls } of [ctrlLog, hostLog]) {
      expect(calls.some((m) => /handshake begin/.test(m))).toBe(true);
      expect(calls.some((m) => m === 'handshake ok')).toBe(true);
    }
    // Begin line carries role + both fingerprints (non-secret, diagnostic).
    expect(ctrlLog.calls.some((m) => /role=controller/.test(m) && /localFp=AA/.test(m) && /remoteFp=BB/.test(m))).toBe(true);
    expect(hostLog.calls.some((m) => /role=host/.test(m) && /localFp=BB/.test(m) && /remoteFp=AA/.test(m))).toBe(true);
  });

  it('logs "handshake begin" and "handshake failed reason=unknown_device" when the host rejects an unenrolled controller key', async () => {
    const crypto = makeCrypto(['HPUB']); // CPUB not enrolled
    const [ca, ha] = channelPair();
    const hostLog = makeLog();
    let nc = 0, nh = 0;

    const pC = runConnectionAuth({
      role: 'controller', channel: ca, deviceId: ctrlId.id, publicKey: ctrlId.pub,
      localFingerprint: 'AA', remoteFingerprint: 'BB',
      sign: (m) => crypto.sign(ctrlId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `c${nc++}`, timeoutMs: 1000,
    });
    const pH = runConnectionAuth({
      role: 'host', channel: ha, deviceId: hostId.id, publicKey: hostId.pub,
      localFingerprint: 'BB', remoteFingerprint: 'AA',
      sign: (m) => crypto.sign(hostId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `h${nh++}`, timeoutMs: 1000, log: hostLog.log,
    });
    pC.catch(() => {}); // controller also rejects (peer 'fail'); not under test here

    await expect(pH).rejects.toThrow('unknown_device');

    expect(hostLog.calls.some((m) => /handshake begin/.test(m))).toBe(true);
    expect(hostLog.calls.some((m) => m === 'handshake failed reason=unknown_device')).toBe(true);
  });

  it('logs "handshake failed reason=bad_signature" and never leaks the signature or private key', async () => {
    // Force verify() to fail on the controller side, as if the host's signature
    // (or a bound fingerprint) didn't match — surfaces as bad_signature, not a
    // separate "fingerprint mismatch" path (this module binds fingerprints into
    // the transcript rather than comparing them explicitly).
    const crypto = makeCrypto(['CPUB', 'HPUB'], { verifyOverride: async () => false });
    const [ca, ha] = channelPair();
    const ctrlLog = makeLog();
    let nc = 0, nh = 0;

    const pC = runConnectionAuth({
      role: 'controller', channel: ca, deviceId: ctrlId.id, publicKey: ctrlId.pub,
      localFingerprint: 'AA', remoteFingerprint: 'BB',
      sign: (m) => crypto.sign(ctrlId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `c${nc++}`, timeoutMs: 1000, log: ctrlLog.log,
    });
    const pH = runConnectionAuth({
      role: 'host', channel: ha, deviceId: hostId.id, publicKey: hostId.pub,
      localFingerprint: 'BB', remoteFingerprint: 'AA',
      sign: (m) => crypto.sign(hostId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `h${nh++}`, timeoutMs: 1000,
    });
    pH.catch(() => {}); // host also rejects (peer 'fail'); not under test here

    await expect(pC).rejects.toThrow('bad_signature');
    expect(ctrlLog.calls.some((m) => m === 'handshake failed reason=bad_signature')).toBe(true);

    // Redaction: the fake private key ('CPUBpriv'/'HPUBpriv') and any
    // signature string (containing '|') must never appear in logged output.
    const joined = ctrlLog.calls.join('\n');
    expect(joined).not.toContain('CPUBpriv');
    expect(joined).not.toContain('HPUBpriv');
    expect(joined).not.toContain('|');
  });

  it('defaults to a no-op logger when none is injected', async () => {
    const crypto = makeCrypto(['CPUB', 'HPUB']);
    const [ca, ha] = channelPair();
    let nc = 0, nh = 0;
    const pC = runConnectionAuth({
      role: 'controller', channel: ca, deviceId: ctrlId.id, publicKey: ctrlId.pub,
      localFingerprint: 'AA', remoteFingerprint: 'BB',
      sign: (m) => crypto.sign(ctrlId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `c${nc++}`, timeoutMs: 1000,
    });
    const pH = runConnectionAuth({
      role: 'host', channel: ha, deviceId: hostId.id, publicKey: hostId.pub,
      localFingerprint: 'BB', remoteFingerprint: 'AA',
      sign: (m) => crypto.sign(hostId.priv, m), verify: crypto.verify, isAccountKey: crypto.isAccountKey,
      nonce: () => `h${nh++}`, timeoutMs: 1000,
    });
    await expect(Promise.all([pC, pH])).resolves.toEqual(['ok', 'ok']);
  });
});
