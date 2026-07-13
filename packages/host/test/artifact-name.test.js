// Regression guard for the v1.2.1 auto-update failure ("found update, then
// Couldn't check for updates"). productName "Farsight Host" contains spaces, so
// the default artifactName is "Farsight Host Setup X.exe". electron-builder then
// writes the feed url with spaces→dashes ("Farsight-Host-Setup-X.exe"), while the
// GitHub release upload rewrites the asset's spaces→dots
// ("Farsight.Host.Setup.X.exe"). The two disagree, electron-updater 404s on the
// download, and the app shows "Couldn't check for updates." A space-free
// artifactName keeps the on-disk name, the feed url, and the uploaded asset name
// identical so the download resolves.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const cfg = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../electron-builder.yml'),
  'utf8',
);

test('host electron-builder.yml pins a space-free artifactName', () => {
  const m = cfg.match(/^\s*artifactName:\s*(.+)$/m);
  expect(m, 'artifactName must be set explicitly').not.toBeNull();
  const value = m[1].trim().replace(/^['"]|['"]$/g, '');
  expect(value).not.toMatch(/\s/);
});
