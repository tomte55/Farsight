// packages/host/test/theme-css.test.js
// Guard: the renderer must link the vendored Aurora stylesheet via the
// packaging-safe ../shared/*.css path (same reasoning as importmap.test.js —
// ../shared/ resolves identically in dev and in the packaged asar).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8');

test('renderer links farsight.css via the packaging-safe ../shared path', () => {
  const m = html.match(/<link[^>]+href="([^"]+farsight\.css)"/);
  expect(m).not.toBeNull();
  expect(m[1]).toBe('../shared/farsight.css');
  expect(existsSync(resolve(__dirname, '../../shared/src/farsight.css'))).toBe(true);
});
