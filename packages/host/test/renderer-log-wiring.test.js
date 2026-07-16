import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
const dir = path.dirname(fileURLToPath(import.meta.url));
const r = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

test('renderer builds a root logger and passes children into connection modules', () => {
  expect(r).toMatch(/createRendererLogger/);
  expect(r).toMatch(/createHostPeer\(\{[\s\S]*log:/);
  expect(r).toMatch(/createSignalingClient\([\s\S]*log:/);
});
test('renderer stamps a connection correlation id', () => {
  expect(r).toMatch(/conn:/);
});
