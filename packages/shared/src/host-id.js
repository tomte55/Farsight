// packages/shared/src/host-id.js
// Runtime-agnostic: uses the Web Crypto API (globalThis.crypto), available in
// both Node (>=19) and the Electron/browser renderer, so this module can be
// imported from either context without a Node-only `node:crypto` dependency.

// Uniform integer in [0, maxExclusive) via rejection sampling (no modulo bias).
function randInt(maxExclusive) {
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let x;
  do {
    globalThis.crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % maxExclusive;
}

export function generateHostId() {
  let id = String(1 + randInt(9)); // first digit 1-9
  for (let i = 0; i < 8; i++) id += String(randInt(10));
  return id;
}

export function isValidHostId(s) {
  return typeof s === 'string' && /^[1-9]\d{8}$/.test(s);
}

// A transfer sessionId is a BEARER capability — ATTACH grants the session to
// whoever presents the id, with no targetId check — so unlike a host id (guarded
// by password + lockout) it must be unguessable on its own. 16 random bytes =
// 128 bits, hex-encoded (32 chars). Web Crypto so this stays runtime-agnostic.
export function generateSessionId() {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  let hex = '';
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
}
