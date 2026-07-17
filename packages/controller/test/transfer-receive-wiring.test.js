// packages/controller/test/transfer-receive-wiring.test.js
// Static wiring guards for the SP3 RECEIVE path on the UNIFIED app (v2). Ported
// from the retired host's transfer-receive-wiring.test.js: the unified app must
// now ALSO be a transfer destination — a TRANSFER_REQUEST relayed on its
// always-on host-registration socket must route to main, prompt for consent, and
// startReceive. Before v2 the controller only sent (consent was a stub decliner),
// so an incoming transfer silently never prompted. Source-text guards (no
// Electron/WebRTC launched), matching the project convention.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');

describe('main.js: transfer service now accepts receives', () => {
  test('consent is a real prompt round-trip, NOT the old always-decline stub', () => {
    expect(main).toMatch(/consent:\s*requestReceiveConsent/);
    expect(main).not.toMatch(/consent:\s*async\s*\(\)\s*=>\s*false/);
  });

  test('requestReceiveConsent sends transfer:consent-request with the real jobId/manifest/destDir', () => {
    expect(main).toMatch(/function requestReceiveConsent\(\{\s*jobId,\s*manifest\s*\}\)/);
    expect(main).toMatch(/'transfer:consent-request'/);
    expect(main).toMatch(/jobId,\s*manifest,\s*destDir/);
    expect(main).toMatch(/bringWindowToAttention/);
  });

  test('transfer:respond-consent resolves the pending prompt with a boolean', () => {
    expect(main).toContain("'transfer:respond-consent'");
    expect(main).toMatch(/resolve\(!!accept\)/);
  });

  test('transfer:incoming validates sessionId and starts a receive carrying linked', () => {
    expect(main).toContain("'transfer:incoming'");
    expect(main).toMatch(/startReceive\(\{\s*rendezvous:\s*\{\s*sessionId,\s*linked\s*\}\s*\}\)/);
  });

  test('openChannel attach resolves peerAuth (tier + verified publicKey) for own-fleet auto-accept', () => {
    expect(main).toMatch(/onPeerAuth\(/);
    expect(main).toMatch(/classifyPublicKey\(/);
    expect(main).toMatch(/resolvePeerAuth\(\{\s*tier,\s*publicKey\s*\}\)/);
    expect(main).toMatch(/peerAuth/);
  });
});

describe('preload.cjs: exposes the receive-path bridge', () => {
  test('exposes transferIncoming/onTransferConsent/respondConsent', () => {
    for (const fn of ['transferIncoming', 'onTransferConsent', 'respondConsent']) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
    expect(preload).toMatch(/ipcRenderer\.invoke\('transfer:incoming'/);
    expect(preload).toMatch(/ipcRenderer\.send\('transfer:respond-consent'/);
  });
});

describe('renderer.js: TRANSFER_REQUEST handler + consent modal', () => {
  test('the host-registration signaling map forwards TRANSFER_REQUEST to main', () => {
    expect(renderer).toMatch(/\[MSG\.TRANSFER_REQUEST\]:/);
    expect(renderer).toMatch(/transferIncoming\(\{\s*sessionId:\s*m\.sessionId,\s*linked:[^}]*\}\)/);
  });

  test('subscribes to onTransferConsent and renders a manifest tree', () => {
    expect(renderer).toMatch(/onTransferConsent/);
    expect(renderer).toMatch(/buildManifestTree/);
    expect(renderer).toMatch(/renderManifestTree/);
  });

  test('Accept/Reject round-trip via respondConsent with a boolean accept flag', () => {
    expect(renderer).toMatch(/respondConsent\(\{\s*jobId:\s*pendingConsentId,\s*accept\s*\}\)/);
    expect(renderer).toMatch(/respondToTransferConsent\(true\)/);
    expect(renderer).toMatch(/respondToTransferConsent\(false\)/);
  });
});

describe('index.html: consent modal exists and is hidden by default', () => {
  test('has the consent modal with summary/dest/tree and accept/reject controls', () => {
    for (const id of ['transfer-consent', 'transfer-consent-summary', 'transfer-consent-dest', 'transfer-consent-tree', 'transfer-consent-accept', 'transfer-consent-reject']) {
      expect(html).toMatch(new RegExp(`id="${id}"`));
    }
  });

  test('the consent modal is hidden until a real offer arrives', () => {
    expect(html).toMatch(/id="transfer-consent"\s+class="overlay"\s+hidden/);
  });

  test('the modal carries NO inline style attributes (CSP style-src self)', () => {
    const modal = html.slice(html.indexOf('id="transfer-consent"'), html.indexOf('id="transfer-consent"') + 900);
    expect(modal).not.toMatch(/style="/);
  });
});
