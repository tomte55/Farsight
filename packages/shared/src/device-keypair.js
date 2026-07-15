// packages/shared/src/device-keypair.js
// Account-issued device keypair (SP2 §4.4, connect-from-console). Ed25519 via
// node:crypto — MAIN-PROCESS ONLY (private keys never touch a renderer). Keys are
// exported as base64 DER so they persist as strings in safeStorage and travel as
// JSON to the account server (public key only). verifyMessage never throws, so a
// malformed peer input is a clean auth failure, not a crash.
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export function generateDeviceKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function signMessage(privateKeyB64, message) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  // Ed25519 signs the raw message directly (the algorithm arg must be null).
  return cryptoSign(null, Buffer.from(String(message), 'utf8'), key).toString('base64');
}

export function verifyMessage(publicKeyB64, message, signatureB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(String(message), 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
