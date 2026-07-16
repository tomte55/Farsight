// packages/host/test/transfer-receive-wiring.test.js
// Static wiring guards for the SP3 RECEIVE path on the host app: the host is
// always the destination for a pushed transfer (a peer's transfer-worker
// initiates; this host attaches by sessionId — see transfer-worker-wiring.test.js
// for the worker itself). Mirrors the repo's existing wiring-test style
// (account-wiring.test.js, transfer-worker-wiring.test.js): parse the source
// files as text and assert the contract points line up. No Electron/WebRTC is
// launched — see host-receiver-report.md for what still needs live verification.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');

describe('main.js: transfer service construction (receive path)', () => {
  test('constructs a jobs-store under userData/transfers', () => {
    expect(main).toMatch(/createJobsStore/);
    expect(main).toMatch(/@farsight\/shared\/jobs-store/);
    expect(main).toMatch(/userData['"]\)\s*,\s*['"]transfers['"]/);
  });

  test('defaults received files under <Downloads>/Farsight/Received and creates the dir', () => {
    expect(main).toMatch(/getPath\(['"]downloads['"]\)/);
    expect(main).toMatch(/Farsight/);
    expect(main).toMatch(/Received/);
    expect(main).toMatch(/mkdirSync/);
  });

  test('constructs createTransferService with store/transferDir/consent/openChannel/onEvent', () => {
    expect(main).toMatch(/createTransferService/);
    expect(main).toMatch(/@farsight\/shared\/transfer-service/);
    expect(main).toMatch(/consent:\s*requestReceiveConsent/);
    expect(main).toMatch(/openChannel:\s*async/);
    expect(main).toMatch(/onEvent:/);
  });

  test('openChannel attaches a transfer worker by sessionId, not by initiating', () => {
    // Canonical rendezvous shape (SP3 coherence contract #1), identical to the
    // controller: openChannel is { role, target, sessionId, linked } — `linked`
    // added in SP3 Phase 4 so the attacher enforces the own-fleet handshake.
    expect(main).toMatch(/openChannel:\s*async\s*\(\{\s*role,\s*target,\s*sessionId,\s*linked\s*\}\)/);
    expect(main).toMatch(/role:\s*'attach'/);
    expect(main).toMatch(/role:\s*'attach',\s*signalingUrl,\s*sessionId,\s*linked:[^,]*,\s*version/);
  });

  test('progress is forwarded to the renderer via transfer:event', () => {
    expect(main).toMatch(/mainWindow\.webContents\.send\('transfer:event',\s*ev\)/);
  });
});

describe('main.js: transfer:incoming / transfer:list IPC', () => {
  test('registers transfer:incoming, validating sessionId before starting a receive', () => {
    expect(main).toContain(`'transfer:incoming'`);
    // SP3 Phase 4: carries the own-fleet `linked` flag from TRANSFER_REQUEST.
    expect(main).toMatch(/startReceive\(\{\s*rendezvous:\s*\{\s*sessionId,\s*linked\s*\}\s*\}\)/);
  });

  test('registers transfer:list', () => {
    expect(main).toContain(`'transfer:list'`);
    expect(main).toMatch(/listJobs\(\)/);
  });
});

describe('main.js: consent round-trip', () => {
  test('requestReceiveConsent sends transfer:consent-request with the REAL jobId/manifest/destDir and returns a boolean promise', () => {
    // SP3 coherence contract #2: the real transfer jobId (from createReceiver's
    // consent({jobId, manifest}) call), not a locally-minted correlation id.
    expect(main).toMatch(/function requestReceiveConsent\(\{\s*jobId,\s*manifest\s*\}\)/);
    expect(main).toMatch(/'transfer:consent-request'/);
    expect(main).toMatch(/jobId,\s*manifest,\s*destDir/);
  });

  test('registers transfer:respond-consent to resolve the pending prompt', () => {
    expect(main).toContain(`'transfer:respond-consent'`);
    expect(main).toMatch(/resolve\(!!accept\)/);
  });

  test('brings the window to attention when a consent prompt is shown (mirrors CONNECT)', () => {
    expect(main).toMatch(/bringWindowToAttention/);
  });
});

describe('preload.cjs: exposes the receive-path bridge', () => {
  test('exposes transferIncoming/transferList/onTransferEvent/onTransferConsent/respondConsent', () => {
    for (const fn of ['transferIncoming', 'transferList', 'onTransferEvent', 'onTransferConsent', 'respondConsent']) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  test('transferIncoming invokes transfer:incoming and respondConsent sends transfer:respond-consent', () => {
    expect(preload).toMatch(/ipcRenderer\.invoke\('transfer:incoming'/);
    expect(preload).toMatch(/ipcRenderer\.send\('transfer:respond-consent'/);
  });
});

describe('renderer.js: signaling handler forwards TRANSFER_REQUEST to main', () => {
  test('the signaling handler map includes MSG.TRANSFER_REQUEST', () => {
    expect(renderer).toMatch(/\[MSG\.TRANSFER_REQUEST\]:/);
  });

  test('the handler calls transferIncoming with the relayed sessionId and linked flag', () => {
    expect(renderer).toMatch(/transferIncoming\(\{\s*sessionId:\s*m\.sessionId,\s*linked:[^}]*\}\)/);
  });
});

describe('renderer.js: consent modal + transfers list wiring', () => {
  test('subscribes to onTransferConsent and renders a manifest tree', () => {
    expect(renderer).toMatch(/onTransferConsent/);
    expect(renderer).toMatch(/buildManifestTree/);
    expect(renderer).toMatch(/renderManifestTree/);
  });

  test('Accept/Reject both round-trip via respondConsent with a boolean accept flag', () => {
    expect(renderer).toMatch(/respondConsent\(\{\s*jobId:\s*pendingConsentId,\s*accept\s*\}\)/);
    expect(renderer).toMatch(/respondToTransferConsent\(true\)/);
    expect(renderer).toMatch(/respondToTransferConsent\(false\)/);
  });

  test('subscribes to onTransferEvent and transferList for the status list', () => {
    expect(renderer).toMatch(/onTransferEvent/);
    expect(renderer).toMatch(/transferList\(\)/);
  });
});

describe('index.html: consent modal + transfers panel + menu entry exist', () => {
  test('has a Transfers menu entry', () => {
    expect(html).toMatch(/id="menu-transfers"/);
  });

  test('has the transfers panel with list/empty/refresh elements', () => {
    for (const id of ['transfers-panel', 'transfers-list', 'transfers-empty', 'transfers-refresh', 'transfers-close']) {
      expect(html).toMatch(new RegExp(`id="${id}"`));
    }
  });

  test('has the consent modal with summary/dest/tree and accept/reject controls', () => {
    for (const id of ['transfer-consent', 'transfer-consent-summary', 'transfer-consent-dest', 'transfer-consent-tree', 'transfer-consent-accept', 'transfer-consent-reject']) {
      expect(html).toMatch(new RegExp(`id="${id}"`));
    }
  });

  test('the consent modal is hidden by default (nothing shown until a real offer arrives)', () => {
    expect(html).toMatch(/id="transfer-consent"\s+class="overlay"\s+hidden/);
  });
});
