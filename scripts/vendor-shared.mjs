// Copy @farsight/shared source into each app's src/shared/ so the sandboxed
// renderer can resolve it via a stable relative import-map path (../shared/*.js)
// that works identically in dev and in the packaged app. The renderer can't do
// node_modules resolution, and dev (hoisted root node_modules) vs packaged
// (nested asar node_modules) are at different depths — vendoring sidesteps both.
// Run automatically via prestart/predist. Vendored dirs are gitignored.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedSrc = join(root, 'packages', 'shared', 'src');

for (const app of ['host', 'controller']) {
  const dest = join(root, 'packages', app, 'src', 'shared');
  mkdirSync(dest, { recursive: true });
  cpSync(sharedSrc, dest, { recursive: true });
  console.log(`vendored shared → packages/${app}/src/shared`);
}
