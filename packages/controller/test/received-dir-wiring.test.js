// Configurable received-files folder + disk-space check — static wiring guards,
// mirroring the repo's existing wiring-test style (controller-transfer-ui-wiring.test.js):
// parse the source files and assert the contract points line up. Live behavior is
// covered by received-dir.probe.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

describe('main.js: received-files-dir configurability', () => {
  test('receivedFilesDir() reads receivedFilesDir from stored config', () => {
    expect(main).toMatch(/function receivedFilesDir\(\)/);
    expect(main).toMatch(/stored\.receivedFilesDir/);
  });
  test('falls back to the Downloads default and validates absoluteness', () => {
    expect(main).toMatch(/path\.isAbsolute\(/);
    expect(main).toMatch(/app\.getPath\(['"]downloads['"]\)/);
  });
  test('passes transferDir as a function (per-receive resolution), not a captured string', () => {
    expect(main).toMatch(/transferDir:\s*ensureReceivedFilesDir/);
  });
  test('registers the three received-dir IPC channels', () => {
    for (const ch of ['received-dir:get', 'received-dir:choose', 'received-dir:reset']) {
      expect(main).toContain(`'${ch}'`);
    }
  });
  test('choose uses an openDirectory dialog and merges onto readStoredConfig', () => {
    expect(main).toMatch(/openDirectory/);
    expect(main).toMatch(/serializeConfig\(\s*\{\s*\.\.\.readStoredConfig\(\),\s*receivedFilesDir/);
  });
  test('consent-request payload includes freeBytes from a statfs-based measure', () => {
    expect(main).toMatch(/freeBytes/);
    expect(main).toMatch(/statfsSync/);
  });
});

describe('preload: received-dir bridge', () => {
  test('exposes get/choose/reset over the IPC bridge', () => {
    expect(preload).toMatch(/getReceivedDir:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('received-dir:get'\)/);
    expect(preload).toMatch(/chooseReceivedDir:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('received-dir:choose'\)/);
    expect(preload).toMatch(/resetReceivedDir:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('received-dir:reset'\)/);
  });
});

describe('renderer: received-dir settings + consent space', () => {
  test('settings has a received-dir display + Change/Reset buttons', () => {
    expect(html).toMatch(/id="settings-received-dir"/);
    expect(html).toMatch(/id="menu-change-received-dir"/);
    expect(html).toMatch(/id="menu-reset-received-dir"/);
  });
  test('consent modal has space + warning elements', () => {
    expect(html).toMatch(/id="transfer-consent-space"/);
    expect(html).toMatch(/id="transfer-consent-warning"/);
  });
  test('renderer imports classifyDiskSpace and wires the Change/Reset buttons', () => {
    expect(renderer).toMatch(/classifyDiskSpace/);
    expect(renderer).toMatch(/chooseReceivedDir\(\)/);
    expect(renderer).toMatch(/resetReceivedDir\(\)/);
  });
  test('consent handler classifies freeBytes against the manifest total', () => {
    expect(renderer).toMatch(/req\.freeBytes/);
  });
});
