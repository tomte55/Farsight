import { expect, test } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(dir, '../src');

// Every module under src/ MUST have a matching `exports` subpath, otherwise a
// MAIN-process `import '@farsight/shared/<name>'` throws ERR_PACKAGE_PATH_NOT_EXPORTED
// in the packaged app (Node honors the exports map — renderer imports go through the
// vendored importmap instead, but main-process imports don't). v1.10.0 shipped a
// crash-on-launch because diagnostics-bundle.js was added without an exports entry.
test('every shared src module is declared in package.json exports', () => {
  const pkg = require('../package.json');
  const modules = readdirSync(srcDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -'.js'.length));

  const missing = modules.filter((name) => pkg.exports[`./${name}`] !== `./src/${name}.js`);
  expect(missing, `missing/incorrect exports for: ${missing.join(', ')}`).toEqual([]);
});

// Guard the specific main-process subpath that regressed, and confirm it actually
// resolves by name through the exports map (not just a relative-path import).
test('main-process shared subpaths resolve through the exports map', async () => {
  for (const sub of ['@farsight/shared/diagnostics-bundle', '@farsight/shared/app-log', '@farsight/shared/account-service']) {
    const mod = await import(sub);
    expect(mod, sub).toBeTruthy();
  }
  const { buildDiagnosticsBundle } = await import('@farsight/shared/diagnostics-bundle');
  expect(typeof buildDiagnosticsBundle).toBe('function');
});
