import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = readFileSync(fileURLToPath(new URL('../src/preload.cjs', import.meta.url)), 'utf8');

test('preload requires webUtils and exposes pathForFile', () => {
  expect(src).toMatch(/webUtils/);
  expect(src).toMatch(/pathForFile:\s*\(file\)\s*=>\s*webUtils\.getPathForFile\(file\)/);
});
