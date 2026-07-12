// Regression guard for the v1.1.0 crash: electron-updater is a CommonJS module,
// so a NAMED ESM import (`import { autoUpdater } from 'electron-updater'`) throws
// "Named export 'autoUpdater' not found" in the packaged app's ESM loader. The
// main process must use the CJS-safe default import + destructure instead.
// (node --check + vitest don't load main.js, so only this static guard catches it.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const mainSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main.js'),
  'utf8',
);

test('host main.js imports electron-updater via CJS-safe default import', () => {
  // No named import of autoUpdater from the CJS module.
  expect(mainSrc).not.toMatch(
    /import\s*\{[^}]*\bautoUpdater\b[^}]*\}\s*from\s*['"]electron-updater['"]/,
  );
  // Uses a default import instead.
  expect(mainSrc).toMatch(/import\s+\w+\s+from\s+['"]electron-updater['"]/);
});
