import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');

// Regression guard for the setup -> connect flow. The setup panel is toggled via
// its `hidden` attribute (renderer.js: `setupEl.hidden = ...`). An inline
// `display` on the same element defeats [hidden]: inline style beats the UA
// `[hidden] { display: none }` rule, so the panel stays visible and the connect
// page stacks BELOW it, forcing a scroll. Keep #setup's layout in the
// stylesheet, with a `#setup[hidden]` override so hiding actually wins over the
// (higher-specificity) `#setup { display: grid }` rule.
test('#setup carries no inline display that would defeat its hidden attribute', () => {
  const tag = html.match(/<div id="setup"[^>]*>/);
  expect(tag).not.toBeNull();
  expect(tag[0]).toMatch(/\bhidden\b/);
  expect(tag[0]).not.toMatch(/display\s*:/i);
});

test('stylesheet hides #setup when the hidden attribute is present', () => {
  expect(html).toMatch(/#setup\[hidden\]\s*\{[^}]*display\s*:\s*none/i);
});
