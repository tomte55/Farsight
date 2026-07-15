// packages/shared/src/connect-transcript.js
// Channel-binding transcript for the connect-from-console handshake (SP2 §4.4).
// Pure + runtime-agnostic (used in both renderers). Both peers sign an IDENTICAL
// transcript that binds the two DTLS fingerprints + device ids + fresh nonces, so
// a signaling/SDP-swap MITM makes the transcripts diverge and signatures fail.

// Extract the sha-256 DTLS fingerprint from an SDP blob, uppercased, or null.
export function parseDtlsFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;
  const m = /^a=fingerprint:sha-256 ([0-9a-fA-F:]+)\s*$/im.exec(sdp);
  return m ? m[1].toUpperCase() : null;
}

// Deterministic, order-independent transcript string. Versioned prefix so a
// future format change can't be cross-verified against this one.
export function buildTranscript({ ctrlDeviceId, hostDeviceId, ctrlFingerprint, hostFingerprint, nonceC, nonceH }) {
  return [
    'farsight-connect-auth:v1',
    `ctrlDeviceId=${ctrlDeviceId}`,
    `hostDeviceId=${hostDeviceId}`,
    `ctrlFp=${ctrlFingerprint}`,
    `hostFp=${hostFingerprint}`,
    `nonceC=${nonceC}`,
    `nonceH=${nonceH}`,
  ].join('\n');
}
