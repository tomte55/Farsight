import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');
const shellCss = readFileSync(path.join(dir, '../src/renderer/shell.css'), 'utf8');

// Regression guard for the setup -> shell flow. The setup panel is toggled via
// its `hidden` attribute (renderer.js: `setupEl.hidden = ...`). An inline
// `display` on the same element defeats [hidden]: inline style beats the UA
// `[hidden] { display: none }` rule, so the panel stays visible and the shell
// stacks BELOW it, forcing a scroll. Keep #setup's layout in the stylesheet
// (shell.css, via its `.setup-screen` class — unification step 1 retired the
// per-window inline <style> block and its id selector), with a
// `.setup-screen[hidden]` override so hiding actually wins over the
// (higher-specificity) `.setup-screen { display: grid }` rule.
test('#setup carries no inline display that would defeat its hidden attribute', () => {
  const tag = html.match(/<div id="setup"[^>]*>/);
  expect(tag).not.toBeNull();
  expect(tag[0]).toMatch(/\bhidden\b/);
  expect(tag[0]).not.toMatch(/display\s*:/i);
});

test('#setup carries the .setup-screen class that shell.css keys its layout on', () => {
  const tag = html.match(/<div id="setup"[^>]*>/);
  expect(tag[0]).toMatch(/class="setup-screen"/);
});

test('shell.css hides .setup-screen when the hidden attribute is present', () => {
  expect(shellCss).toMatch(/\.setup-screen\[hidden\]\s*\{[^}]*display\s*:\s*none/i);
});
