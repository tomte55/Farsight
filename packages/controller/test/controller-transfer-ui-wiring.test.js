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

  test('pick-paths offers files (multi-select) OR a folder by mode — never a combined dialog (Windows/Linux cannot show both)', () => {
    // Files mode: multi-select files. Folder mode: a single directory.
    expect(main).toMatch(/\['openFile',\s*'multiSelections'\]/);
    expect(main).toMatch(/\['openDirectory'\]/);
    // The buggy combined [openFile, multiSelections, openDirectory] dialog — which
    // silently degrades to folder-only on Windows/Linux — must be gone.
    expect(main).not.toMatch(/openFile[^\]]*multiSelections[^\]]*openDirectory/);
    // The mode is threaded from the renderer through the IPC arg.
    expect(main).toMatch(/ipcMain\.handle\('transfer:pick-paths',\s*async\s*\([^)]*mode/);
  });

  test('openChannel surfaces worker session-state errors via onRendezvousError (a stuck send fails fast with the real reason)', () => {
    expect(main).toMatch(/worker\.onSessionState/);
    expect(main).toMatch(/onRendezvousError/);
    expect(main).toMatch(/startsWith\('error:'\)/);
  });

  test('the legacy pick-file/save-file handlers (interim single-file transfer) are retired', () => {
    expect(main).not.toContain("ipcMain.handle('pick-file'");
    expect(main).not.toContain("ipcMain.handle('save-file'");
  });
});

describe('preload.cjs: SP3 transfer bridge', () => {
  test('exposes the documented transfer* API surface', () => {
    for (const fn of ['transferPickPaths', 'transferSend', 'transferList', 'transferCancel', 'onTransferEvent']) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  test('transferSend/transferList/transferCancel invoke; onTransferEvent subscribes', () => {
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:pick-paths['"],\s*mode\)/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:send['"]/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:list['"]\)/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(['"]transfer:cancel['"]/);
    expect(preload).toMatch(/ipcRenderer\.on\(['"]transfer:event['"]/);
  });
});

describe('renderer: Send… entry point + Transfers panel', () => {
  // Unification step 1: the standalone Send/Transfers menu entries and
  // full-screen panels were replaced by a single "Transfers" rail page (rail
  // markup itself is guarded by shell-wiring.test.js) that holds both the send
  // form and the live job list.
  test('index.html has a Transfers page reachable from the rail', () => {
    expect(html).toMatch(/<section id="page-transfers"/);
  });

  test('index.html has a send form with host id + password inputs reusing the .input styling', () => {
    expect(html).toMatch(/<input id="send-host-id" class="input"/);
    expect(html).toMatch(/<input id="send-host-pw" class="input"/);
    // Two explicit choices (Windows/Linux can't combine file+folder in one dialog).
    expect(html).toMatch(/<button id="send-files-btn"/);
    expect(html).toMatch(/<button id="send-folder-btn"/);
  });

  test('index.html has a job list container on the Transfers page', () => {
    expect(html).toMatch(/<section id="page-transfers"/);
    expect(html).toMatch(/<div id="transfers-list">/);
  });

  test('renderer.js wires both send buttons (files/folder) through transferPickPaths(mode) + transferSend', () => {
    expect(renderer).toMatch(/window\.farsightIpc\.transferPickPaths\(mode\)/);
    expect(renderer).toMatch(/doSend\(['"]files['"]\)/);
    expect(renderer).toMatch(/doSend\(['"]folder['"]\)/);
    expect(renderer).toMatch(/window\.farsightIpc\.transferSend\(/);
  });

  test('renderer.js subscribes to live progress and seeds the list on open', () => {
    expect(renderer).toMatch(/window\.farsightIpc\.onTransferEvent\(/);
    expect(renderer).toMatch(/window\.farsightIpc\.transferList\(\)/);
  });

  test('renderer.js sizes the bar from the BYTE fraction of the full manifest', () => {
    // Was `toMatch(/progress\.fraction/)`, which by the end only matched a stale
    // COMMENT — sendFraction stopped reading p.fraction when the bar went
    // byte-based, so the test passed while asserting nothing executable.
    expect(renderer).toMatch(/bytesDone\(p\)\s*\/\s*p\.total/);
    expect(renderer).toMatch(/xfer-bar-fill/);
    expect(renderer).toMatch(/barFill\.style\.width/);
  });

  test('renderer.js wires a per-job cancel button to transferCancel', () => {
    expect(renderer).toMatch(/window\.farsightIpc\.transferCancel\(/);
  });

  test("a send only shows 'Completed' on the delivery ack — it holds at 'finishing' after all bytes are sent", () => {
    // The sender emits 'all-sent' (bytes on the wire) then 'completed' (receiver
    // confirmed every file received + hash-verified). The controller must NOT
    // claim done on 'all-sent' / fraction===1 — only on 'completed'.
    expect(renderer).toMatch(/ev\.type === 'all-sent'/);
    expect(renderer).toMatch(/state = 'finishing'/);
    expect(renderer).toMatch(/ev\.type === 'completed'/);
    expect(renderer).toMatch(/case 'finishing'/);
    // No path that flips a send to 'done' merely because the byte fraction hit 1.
    expect(renderer).not.toMatch(/fraction >= 1 \? 'done'/);
  });

  test("a send shows 'awaiting-approval' until the peer's 'accepted' event — never a fake 'active' at 0", () => {
    // Fresh send starts awaiting approval, not active.
    expect(renderer).toMatch(/state:\s*'awaiting-approval'/);
    // Only the 'accepted' lifecycle event flips it to active.
    expect(renderer).toMatch(/ev\.type === 'accepted'/);
    // The waiting state has a human label.
    expect(renderer).toMatch(/'awaiting-approval':\s*return 'Waiting for approval/);
    // Declined/error are handled as terminal outcomes.
    expect(renderer).toMatch(/ev\.type === 'declined'/);
    expect(renderer).toMatch(/case 'declined'/);
  });

  test('a receive labels its row live from the manifest on the accepted event (no Refresh needed)', () => {
    // Field bug: the receiver's panel showed no file/folder name until Refresh,
    // because the receiver's live events carried no manifest. The receiver now
    // emits its manifest on accept and onTransferEvent must apply it.
    expect(renderer).toMatch(/if \(ev\.manifest\) existing\.manifest = ev\.manifest/);
  });

  test("a receive shows a 'verifying' state during hash-verification, not a misleading 'Transferring…'", () => {
    // The receiver emits 'verifying' while hashing the received files. With no
    // branch for it, it fell through to the progress path and read
    // "Transferring…" — with a live ETA that is meaningless during verify. Give
    // it its own state + label.
    expect(renderer).toMatch(/ev\.type === 'verifying'/);
    expect(renderer).toMatch(/case 'verifying'/);
  });

  test('controller renderer imports the rate helpers', () => {
    const src = readFileSync(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*createRateEstimator[^}]*\} from '@farsight\/shared\/transfer-rate'/);
  });

  test('controller send bar is byte-based now that sender bytes are absolute', () => {
    const src = readFileSync(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8');
    // The old files-sent/total bar existed only because the sender's byte progress
    // was quantized + relative; transfer-engine now reports absolute continuous bytes.
    expect(src).not.toContain('return p.filesSent / p.filesTotal;');
  });
});
