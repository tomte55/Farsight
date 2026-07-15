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
