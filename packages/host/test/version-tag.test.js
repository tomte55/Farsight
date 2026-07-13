// Guard the subtle app-version label wired end to end: main exposes
// app.getVersion() over IPC, the preload bridges it, the renderer paints it
// into a fixed corner element, and the shared stylesheet positions that
// element bottom-left and out of the way (non-interactive).
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
const css = read('../../shared/src/farsight.css');

test('main exposes the app version over IPC via app.getVersion()', () => {
  expect(main).toMatch(/ipcMain\.handle\(\s*['"]get-app-version['"]\s*,\s*\(\)\s*=>\s*app\.getVersion\(\)\s*\)/);
});

test('preload bridges getAppVersion to the get-app-version channel', () => {
  expect(preload).toMatch(/getAppVersion:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]get-app-version['"]\s*\)/);
});

test('index.html carries a #version-tag element', () => {
  expect(html).toMatch(/id="version-tag"/);
});

test('renderer paints the version into #version-tag prefixed with v', () => {
  expect(renderer).toMatch(/getAppVersion\(\)/);
  expect(renderer).toMatch(/version-tag/);
  expect(renderer).toMatch(/`v\$\{/);
});

test('version tag lifts clear of the panic-warning banner while it is shown', () => {
  // The panic-warning banner is full-width, opaque, and pinned bottom:0 with a
  // higher z-index; without this the subtle version label hides behind it.
  expect(css).toMatch(/#panic-warning:not\(\[hidden\]\)\s*~\s*#version-tag\s*\{[^}]*bottom\s*:/);
});

test('shared stylesheet pins #version-tag bottom-left and non-interactive', () => {
  const rule = css.match(/#version-tag\s*\{[^}]*\}/);
  expect(rule).not.toBeNull();
  expect(rule[0]).toMatch(/position\s*:\s*fixed/);
  expect(rule[0]).toMatch(/bottom\s*:/);
  expect(rule[0]).toMatch(/left\s*:/);
  expect(rule[0]).toMatch(/pointer-events\s*:\s*none/);
});
