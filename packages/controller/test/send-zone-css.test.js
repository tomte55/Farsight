// packages/controller/test/send-zone-css.test.js
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const css = readFileSync(fileURLToPath(new URL('../../shared/src/farsight.css', import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../src/renderer/index.html', import.meta.url)), 'utf8');

test('send-zone markup present', () => {
  expect(html).toMatch(/id="xfer-send"/);
  expect(html).toMatch(/id="xfer-recipients"/);
  expect(html).toMatch(/id="send-host-id"/); // ad-hoc ids preserved
});
test('send-zone + drag-over CSS present', () => {
  expect(css).toMatch(/\.xfer-send\./);  // compound selectors (.xfer-send.xfer-drop-over, etc.) remain
  expect(css).toMatch(/\.xfer-drop-over\s*\{/);
  expect(css).toMatch(/\.xfer-recip\s*\{/);
});
