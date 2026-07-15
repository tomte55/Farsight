import { describe, it, expect } from 'vitest';
import { generateDeviceKeyPair, signMessage, verifyMessage } from '../src/device-keypair.js';

describe('device-keypair', () => {
  it('round-trips a signature', () => {
    const { publicKey, privateKey } = generateDeviceKeyPair();
    const sig = signMessage(privateKey, 'hello-transcript');
    expect(verifyMessage(publicKey, 'hello-transcript', sig)).toBe(true);
  });

  it('rejects a tampered message', () => {
    const { publicKey, privateKey } = generateDeviceKeyPair();
    const sig = signMessage(privateKey, 'hello-transcript');
    expect(verifyMessage(publicKey, 'hello-transcript-EVIL', sig)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    const sig = signMessage(a.privateKey, 'm');
    expect(verifyMessage(b.publicKey, 'm', sig)).toBe(false);
  });

  it('never throws on malformed inputs', () => {
    expect(verifyMessage('not-base64!!', 'm', 'also-bad')).toBe(false);
    expect(verifyMessage('', '', '')).toBe(false);
  });

  it('produces distinct keypairs', () => {
    expect(generateDeviceKeyPair().publicKey).not.toBe(generateDeviceKeyPair().publicKey);
  });
});
