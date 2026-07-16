import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');

test('controller main builds the app logger and installs global crash handlers', () => {
  expect(main).toMatch(/createAppLogger/);
  expect(main).toMatch(/['"]logs['"]\s*,\s*['"]main\.log['"]|'logs',\s*'main\.log'/);
  expect(main).toMatch(/uncaughtException/);
  expect(main).toMatch(/unhandledRejection/);
  expect(main).toMatch(/render-process-gone/);
});

test('controller wires the renderer error bridge', () => {
  expect(main).toMatch(/['"]log:renderer['"]/);
  expect(preload).toMatch(/reportError/);
});

test('exposes a scoped renderer log bridge', () => {
  expect(preload).toMatch(/log:\s*\(entry\)\s*=>\s*ipcRenderer\.send\('log:renderer'/);
  expect(main).toMatch(/renderer:\$\{|`renderer:/); // handler prefixes scope
});
