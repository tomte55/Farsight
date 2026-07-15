import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('package.json exports the four SP3 transfer modules', () => {
  const pkg = require('../package.json');
  for (const sub of ['./transfer-manifest', './transfer-protocol', './remote-fs-protocol', './transfer-engine']) {
    expect(pkg.exports[sub]).toBe(`./src/${sub.slice(2)}.js`);
  }
});
