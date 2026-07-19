import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../shared/src/farsight.css', import.meta.url)), 'utf8');

test('the 560px page cap is gone', () => {
  expect(css).not.toMatch(/\.page\s*\{[^}]*max-width:\s*560px/);
});

test('.page allows a wide content column', () => {
  expect(css).toMatch(/\.page\s*\{[^}]*max-width:\s*1180px/);
});
