// packages/controller/test/theme-css.test.js
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

test('the shared Aurora stylesheet defines the shell primitives the rail markup needs', () => {
  const css = readFileSync(resolve(__dirname, '../../shared/src/farsight.css'), 'utf8');
  for (const sel of ['.shell', '.rail', '.rail-item', '.rail-badge', '.pane', '.page', '.statusbar', '.sb-seg', '.sb-bar-fill']) {
    expect(css, `farsight.css must define ${sel}`).toContain(sel);
  }
});

test('the shell primitives are additive — the host renderer still gets its existing selectors', () => {
  const css = readFileSync(resolve(__dirname, '../../shared/src/farsight.css'), 'utf8');
  // packages/host is frozen in unification step 1 and links this same stylesheet.
  for (const sel of ['.wm', '.lbl', '.chip', '.pill', '.btn', '.input', '.card', '.statusline', '.sessionbar', '.overlay', '.veil', '.toast', '.cog', '.menu']) {
    expect(css, `farsight.css must keep ${sel} for the frozen host`).toContain(sel);
  }
});
