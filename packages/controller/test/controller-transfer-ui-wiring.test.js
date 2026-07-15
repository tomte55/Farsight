// SP3 file transfer (send path) UI wiring — Phase 2. Static text-based guards,
// mirroring the repo's existing wiring-test style (conn-auth-wiring.test.js,
// transfer-worker-wiring.test.js): parse the source files and assert the
// contract points line up. No Electron is launched — see
// controller-ui-report.md (scratchpad) for what still needs live verification.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

describe('main.js: SP3 send-path IPC handlers', () => {
  test('registers the four transfer IPC channels', () => {
    for (const ch of ['transfer:pick-paths', 'transfer:send', 'transfer:list', 'transfer:cancel']) {
      expect(main).toContain(`'${ch}'`);
    }
  });

  test('wires createTransferService from @farsight/shared/transfer-service', () => {
    expect(main).toMatch(/import\s*\{[^}]*\bcreateTransferService\b[^}]*\}\s*from\s*['"]@farsight\/shared\/transfer-service['"]/);
  });

  test('constructs a jobs-store under app.getPath(\'userData\')/transfers', () => {
    expect(main).toMatch(/createJobsStore\(\s*\{\s*dir:\s*path\.join\(app\.getPath\(['"]userData['"]\),\s*['"]transfers['"]\)/);
  });

  test('openChannel builds a createTransferWorker() and calls its startRendezvous', () => {
    expect(main).toMatch(/createTransferWorker\(\)/);
    expect(main).toMatch(/worker\.startRendezvous\(/);
  });

  test('the initiate role maps to the worker\'s initiator rendezvous role', () => {
    expect(main).toMatch(/role\s*===\s*['"]initiate['"]/);
    expect(main).toMatch(/role:\s*['"]initiator['"]/);
  });

  test('transfer:send walks the picked paths, builds a manifest, mints a jobId, and starts the send', () => {
    expect(main).toMatch(/walkSource\(/);
    expect(main).toMatch(/buildManifest\(/);
    expect(main).toMatch(/newJobId\(\)/);
    expect(main).toMatch(/\.startSend\(/);
  });

  test('progress is pushed to the renderer as \'transfer:event\'', () => {
    expect(main).toMatch(/mainWindow\.webContents\.send\(['"]transfer:event['"]/);
  });

  test('pick-paths uses an OS dialog with file+multi-select+directory support', () => {
    expect(main).toMatch(/showOpenDialog\(\{\s*properties:\s*\[[^\]]*openFile[^\]]*multiSelections[^\]]*openDirectory[^\]]*\]/);
  });

  test('the legacy pick-file/save-file handlers are untouched (retired in a later plan, not this one)', () => {
    expect(main).toContain("ipcMain.handle('pick-file'");
    expect(main).toContain("ipcMain.handle('save-file'");
  });
});

describe('preload.cjs: SP3 transfer bridge', () => {
  test('exposes the documented transfer* API surface', () => {
    for (const fn of ['transferPickPaths', 'transferSend', 'transferList', 'transferCancel', 'onTransferEvent']) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  test('transferSend/transferList/transferCancel invoke; onTransferEvent subscribes', () => {
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:pick-paths['"]\)/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:send['"]/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:list['"]\)/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:cancel['"]/);
    expect(preload).toMatch(/ipcRenderer\.on\(['"]transfer:event['"]/);
  });
});

describe('renderer: Send… entry point + Transfers panel', () => {
  test('index.html has the Send… and Transfers… menu entries', () => {
    expect(html).toMatch(/<button id="menu-send">/);
    expect(html).toMatch(/<button id="menu-transfers">/);
  });

  test('index.html has a send panel with host id + password inputs reusing the .input styling', () => {
    expect(html).toMatch(/<div id="send-panel"/);
    expect(html).toMatch(/<input id="send-host-id" class="input"/);
    expect(html).toMatch(/<input id="send-host-pw" class="input"/);
    expect(html).toMatch(/<button id="send-choose-btn"/);
  });

  test('index.html has a transfers panel with a job list container', () => {
    expect(html).toMatch(/<div id="transfers-panel"/);
    expect(html).toMatch(/<div id="transfers-list">/);
  });

  test('renderer.js wires the Send… button to transferPickPaths + transferSend', () => {
    expect(renderer).toMatch(/window\.farsightIpc\.transferPickPaths\(\)/);
    expect(renderer).toMatch(/window\.farsightIpc\.transferSend\(/);
  });

  test('renderer.js subscribes to live progress and seeds the list on open', () => {
    expect(renderer).toMatch(/window\.farsightIpc\.onTransferEvent\(/);
    expect(renderer).toMatch(/window\.farsightIpc\.transferList\(\)/);
  });

  test('renderer.js renders progress as a fraction-based bar width', () => {
    expect(renderer).toMatch(/progress\.fraction/);
    expect(renderer).toMatch(/xfer-bar-fill/);
  });

  test('renderer.js wires a per-job cancel button to transferCancel', () => {
    expect(renderer).toMatch(/window\.farsightIpc\.transferCancel\(/);
  });
});
