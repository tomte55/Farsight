// packages/shared/src/connection-auth.js
// Mutual, fingerprint-bound device-keypair handshake for connect-from-console
// (SP2 §4.4). Pure state machine — no sockets, no crypto primitives: sign/verify/
// isAccountKey/nonce are injected (the renderer wires them to main over IPC; tests
// inject fakes). Runs over the WebRTC 'auth' data channel AFTER DTLS forms, so the
// transcript can bind the DTLS fingerprints and defeat a signaling/SDP-swap MITM.
// Fails closed: any unexpected message or check failure ends the handshake.
import { buildTranscript } from './connect-transcript.js';

export function createConnectionAuth({
  role, deviceId, publicKey, localFingerprint, remoteFingerprint,
  sign, verify, isAccountKey, nonce,
}) {
  const isController = role === 'controller';
  let myNonce = null;
  let peer = null; // { deviceId, publicKey, nonce }

  // The transcript both sides must agree on. `remote` carries the peer's ids/nonce.
  function transcript(remote) {
    return isController
      ? buildTranscript({
          ctrlDeviceId: deviceId, hostDeviceId: remote.deviceId,
          ctrlFingerprint: localFingerprint, hostFingerprint: remoteFingerprint,
          nonceC: myNonce, nonceH: remote.nonce,
        })
      : buildTranscript({
          ctrlDeviceId: remote.deviceId, hostDeviceId: deviceId,
          ctrlFingerprint: remoteFingerprint, hostFingerprint: localFingerprint,
          nonceC: remote.nonce, nonceH: myNonce,
        });
  }

  return {
    // Controller opens with hello; host waits (returns null).
    start() {
      if (!isController) return null;
      myNonce = nonce();
      return { t: 'hello', deviceId, publicKey, nonce: myNonce };
    },

    async handle(msg) {
      try {
        if (!msg || typeof msg.t !== 'string') return { fail: 'unexpected_message' };

        if (!isController && msg.t === 'hello') {
          if (!(await isAccountKey(msg.publicKey))) return { fail: 'unknown_device' };
          peer = { deviceId: msg.deviceId, publicKey: msg.publicKey, nonce: msg.nonce };
          myNonce = nonce();
          const sig = await sign(transcript(peer));
          return { out: { t: 'challenge', deviceId, publicKey, nonce: myNonce, sig } };
        }

        if (isController && msg.t === 'challenge') {
          if (!(await isAccountKey(msg.publicKey))) return { fail: 'unknown_device' };
          peer = { deviceId: msg.deviceId, publicKey: msg.publicKey, nonce: msg.nonce };
          const t = transcript(peer);
          if (!(await verify(msg.publicKey, t, msg.sig))) return { fail: 'bad_signature' };
          const sig = await sign(t);
          return { out: { t: 'response', sig }, done: 'ok' };
        }

        if (!isController && msg.t === 'response') {
          if (!peer) return { fail: 'unexpected_message' };
          const t = transcript(peer);
          if (!(await verify(peer.publicKey, t, msg.sig))) return { fail: 'bad_signature' };
          return { out: { t: 'ok' }, done: 'ok' };
        }

        if (msg.t === 'fail') return { fail: msg.reason || 'peer_failed' };
        if (isController && msg.t === 'ok') return { done: 'ok' };

        return { fail: 'unexpected_message' };
      } catch {
        return { fail: 'auth_error' };
      }
    },
  };
}

// Drive a handshake `machine` over a message channel (an RTCDataChannel or any
// object with `send(str)`, `onmessage`, and `addEventListener('open', …)`).
// Resolves 'ok' on mutual success; rejects with an Error(reason) on any failure
// or timeout. Fails closed: a channel that never opens rejects at the timeout.
export function pumpConnectionAuth(machine, channel, { timeoutMs = 15_000, setTimeout: setT, clearTimeout: clearT } = {}) {
  const schedule = setT ?? (typeof setTimeout !== 'undefined' ? setTimeout : null);
  const cancel = clearT ?? (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = schedule ? schedule(() => finish(reject, new Error('auth_timeout')), timeoutMs) : null;
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (timer !== null && cancel) cancel(timer);
      fn(value);
    }
    channel.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(typeof e === 'object' && 'data' in e ? e.data : e); } catch { return; }
      const r = await machine.handle(msg);
      if (r.out) { try { channel.send(JSON.stringify(r.out)); } catch { /* channel gone */ } }
      if (r.done) finish(resolve, 'ok');
      else if (r.fail) {
        // Tell the peer so it fails fast instead of waiting for its own timeout.
        try { channel.send(JSON.stringify({ t: 'fail', reason: r.fail })); } catch { /* channel gone */ }
        finish(reject, new Error(r.fail));
      }
    };
    const first = machine.start();
    const startPump = () => { if (first) { try { channel.send(JSON.stringify(first)); } catch { /* channel gone */ } } };
    // readyState 'open' (RTCDataChannel) or a test channel without one → start now.
    if (channel.readyState === 'open' || channel.readyState === undefined) startPump();
    else if (channel.addEventListener) channel.addEventListener('open', startPump, { once: true });
  });
}

// Convenience: build a handshake machine + drive it over `channel` in one call.
// Used by the renderers (crypto ops are IPC-backed; nonce is Web Crypto).
export function runConnectionAuth({
  role, channel, deviceId, publicKey, localFingerprint, remoteFingerprint,
  sign, verify, isAccountKey, nonce, timeoutMs,
}) {
  const machine = createConnectionAuth({
    role, deviceId, publicKey, localFingerprint, remoteFingerprint, sign, verify, isAccountKey, nonce,
  });
  return pumpConnectionAuth(machine, channel, { timeoutMs });
}
