// Guard the subtle app-version label wired end to end: main exposes
// app.getVersion() over IPC, the preload bridges it, and the renderer feeds it
// into the persistent status bar (unification step 1 retired the standalone
// bottom-left #version-tag element the bar absorbed — see shell-wiring.test.js
// for the guard that #version-tag itself is gone). The underlying contract this
// file guards — the build version is visible to the user — still holds; it just
// moved from its own fixed element into the bar's rightmost, low-contrast segment.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const main = read('../src/main.js');
const preload = read('../src/preload.cjs');
const html = read('../src/renderer/index.html');
const renderer = read('../src/renderer/renderer.js');
const statusBar = read('../../shared/src/status-bar.js');
const css = read('../../shared/src/farsight.css');

test('main exposes the app version over IPC via app.getVersion()', () => {
  expect(main).toMatch(/ipcMain\.handle\(\s*['"]get-app-version['"]\s*,\s*\(\)\s*=>\s*app\.getVersion\(\)\s*\)/);
});

test('preload bridges getAppVersion to the get-app-version channel', () => {
  expect(preload).toMatch(/getAppVersion:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]get-app-version['"]\s*\)/);
});

test('index.html carries the persistent status bar, not the retired #version-tag', () => {
  expect(html).toMatch(/id="statusbar"/);
  expect(html).not.toMatch(/id="version-tag"/);
});

test('renderer reads the app version and feeds it into the status bar state', () => {
  expect(renderer).toMatch(/getAppVersion\(\)/);
  expect(renderer).toMatch(/statusState\.appVersion\s*=\s*appVersion/);
  expect(renderer).toMatch(/renderStatusBar\(\)/);
});

test('the shared status-bar model prefixes the version segment with v', () => {
  expect(statusBar).toMatch(/`v\$\{appVersion\}`/);
});

test('shared stylesheet renders the version segment subtly (low-contrast, not strong)', () => {
  const rule = css.match(/\.sb-ver\s*\{[^}]*\}/);
  expect(rule).not.toBeNull();
  expect(rule[0]).toMatch(/opacity\s*:/);
});
