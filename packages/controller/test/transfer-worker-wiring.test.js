// packages/controller/test/transfer-worker-wiring.test.js
// Static wiring guards for the SP3 transfer worker (design doc §3), mirroring
// the repo's existing wiring-test style (conn-auth-wiring.test.js,
// logging-wiring.test.js): parse the source files as text and assert the
// contract points line up. No Electron/WebRTC is launched — see
// worker-window-report.md for what still needs live verification.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(path.join(dir, '../src/transfer-worker.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/transfer-worker-preload.cjs'), 'utf8');
const workerRenderer = readFileSync(path.join(dir, '../src/transfer-worker/worker.js'), 'utf8');
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');

describe('transfer worker window security posture (mirrors createWindow in main.js)', () => {
  test('the worker window is hidden and sandboxed', () => {
    expect(worker).toMatch(/show:\s*false/);
    expect(worker).toMatch(/sandbox:\s*true/);
    expect(worker).toMatch(/contextIsolation:\s*true/);
    expect(worker).toMatch(/nodeIntegration:\s*false/);
  });

  test('the worker window uses transfer-worker-preload.cjs', () => {
    expect(worker).toMatch(/transfer-worker-preload\.cjs/);
  });

  test('the worker window denies new windows and guards navigation, like the main window', () => {
    expect(worker).toMatch(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/);
    expect(worker).toMatch(/will-navigate/);
  });

  test('the worker window loads transfer-worker/index.html', () => {
    expect(worker).toMatch(/transfer-worker['"],\s*['"]index\.html['"]/);
  });
});

describe('createTransferWorker() exports the documented factory surface', () => {
  test('exports createTransferWorker', () => {
    expect(worker).toMatch(/export function createTransferWorker/);
  });

  test('returns startRendezvous/channel/onSessionState/getStats/close', () => {
    for (const key of ['startRendezvous', 'channel', 'onSessionState', 'getStats', 'close']) {
      expect(worker).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  test('wires createTransferChannel from @farsight/shared/transfer-channel', () => {
    expect(worker).toMatch(/import\s*\{[^}]*\bcreateTransferChannel\b[^}]*\}\s*from\s*['"]@farsight\/shared\/transfer-channel['"]/);
  });

  // SP3 Phase 2: createTransferWorker() is now wired into main.js's
  // getTransferService()/openChannel (send path) — see
  // controller-transfer-ui-wiring.test.js for the send/UI wiring guards.
  test('is wired into main.js (send-path orchestration)', () => {
    expect(main).toMatch(/createTransferWorker/);
  });
});

describe('per-worker IPC topics are namespaced by workerId (no cross-worker leakage)', () => {
  const topicBases = ['ft-ctrl', 'ft-bulk', 'ft-ctrl-in', 'ft-bulk-in', 'ft-bulk-credit', 'ft-start-rendezvous', 'ft-session-state', 'ft-stats-request', 'ft-stats-response'];

  test('transfer-worker.js builds every topic as `${base}:${workerId}`', () => {
    for (const base of topicBases) {
      expect(worker).toMatch(new RegExp(`${base}:\\$\\{workerId\\}`));
    }
  });

  test('transfer-worker-preload.cjs derives the SAME topic names from the same workerId scheme', () => {
    for (const base of topicBases) {
      expect(preload).toMatch(new RegExp(`${base}:\\$\\{workerId\\}`));
    }
    // Same source for workerId: the --ft-worker-id= additionalArgument.
    expect(worker).toMatch(/--ft-worker-id=/);
    expect(preload).toMatch(/--ft-worker-id=/);
  });
});

describe('transfer-worker-preload.cjs exposes the farsightTransfer bridge', () => {
  test('is CommonJS (require, not import) — sandbox:true forbids an ESM preload', () => {
    expect(preload).toMatch(/require\(['"]electron['"]\)/);
    expect(preload).not.toMatch(/^import /m);
  });

  test('exposes farsightTransfer with the documented API surface', () => {
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld\(['"]farsightTransfer['"]/);
    for (const fn of [
      'onStartRendezvous', 'onSendCtrl', 'onSendBulk',
      'emitCtrl', 'emitBulk', 'emitCredit',
      'reportSessionState', 'onStatsRequest', 'reportStats',
    ]) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });
});

describe('transfer-worker/worker.js bridges IPC <-> the ft-ctrl/ft-bulk/auth data channels', () => {
  test('reuses signaling-client.js (not a reimplementation)', () => {
    expect(workerRenderer).toMatch(/from\s*['"]\.\.\/signaling-client\.js['"]/);
  });

  test('creates the three transfer data channels by label', () => {
    for (const label of ['ft-ctrl', 'ft-bulk', 'auth']) {
      expect(workerRenderer).toContain(`'${label}'`);
    }
  });

  test('sets binaryType=arraybuffer and a bufferedAmountLowThreshold on ft-bulk, like peer.js\'s fileChannel', () => {
    expect(workerRenderer).toMatch(/binaryType\s*=\s*['"]arraybuffer['"]/);
    expect(workerRenderer).toMatch(/bufferedAmountLowThreshold\s*=\s*262144/);
  });

  test('emits a credit signal on ft-bulk bufferedamountlow', () => {
    expect(workerRenderer).toMatch(/bufferedamountlow/);
    expect(workerRenderer).toMatch(/emitCredit/);
  });

  test('speaks the transfer rendezvous: CONNECT{kind:\'transfer\'} for the initiator, ATTACH{sessionId} for the attacher', () => {
    expect(workerRenderer).toMatch(/kind:\s*['"]transfer['"]/);
    expect(workerRenderer).toMatch(/MSG\.ATTACH/);
    expect(workerRenderer).toMatch(/sessionId/);
  });
});
