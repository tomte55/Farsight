// packages/controller/test/status-bar-fill-css.test.js
// Guard: the bottom status-bar progress fill must be a BLOCK box. paintSeg builds
// .sb-bar-fill as a <span> (inline), and width/height do not apply to inline
// boxes — without display:block the fill renders 0×0 (measured fillW:0) and the
// progress bar shows nothing regardless of the percentage.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, '../../shared/src/farsight.css'), 'utf8');

function ruleBody(source, selector) {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = noComments.indexOf(selector + ' {');
  if (idx === -1) return null;
  const open = noComments.indexOf('{', idx);
  return noComments.slice(open + 1, noComments.indexOf('}', open));
}

test('.sb-bar-fill is display:block so its width% actually paints', () => {
  const body = ruleBody(css, '.sb-bar-fill');
  expect(body, 'no .sb-bar-fill rule').not.toBeNull();
  expect(body).toMatch(/display\s*:\s*block/);
});
