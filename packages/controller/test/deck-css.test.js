import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../shared/src/farsight.css', import.meta.url)), 'utf8');

test('two-column workspace grid exists', () => {
  expect(css).toMatch(/\.xfer-work\s*\{[^}]*display:\s*grid/);
  expect(css).toMatch(/\.xfer-work\s*\{[^}]*grid-template-columns:\s*1\.55fr\s+1fr/);
});

test('flow-lane fill uses the teal go hue (health), not the progress accent', () => {
  // A healthy lane is teal; a dead lane is the hairline colour.
  expect(css).toMatch(/\.xfer-lane\s*\{[^}]*var\(--go/);
  expect(css).toMatch(/\.xfer-lane\.dead\s*\{[^}]*var\(--line/);
});

test('the deck progress bar uses the acc→acc2 progress gradient', () => {
  expect(css).toMatch(/\.xfer-deck-bar-fill\s*\{[^}]*linear-gradient\(90deg,\s*var\(--acc\),\s*var\(--acc2\)\)/);
});

test('columns stack on narrow windows', () => {
  expect(css).toMatch(/@media\s*\(max-width:\s*900px\)/);
});
