// packages/controller/test/control-toggle.test.js
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(__dirname, '../src/main.js'), 'utf8');
const preload = readFileSync(resolve(__dirname, '../src/preload.cjs'), 'utf8');

describe('control-allowed setting', () => {
  test('main persists and exposes the setting, defaulting to allowed', () => {
    expect(main).toContain('control-allowed:get');
    expect(main).toContain('control-allowed:set');
    // default true — the maintainer's decision; the DEFAULT is what actually ships.
    expect(main).toMatch(/control-?[Aa]llowed[^\n]*(\?\?|default)[^\n]*true|true[^\n]*\/\/[^\n]*default/i);
  });
  test('preload bridges the setting both ways', () => {
    expect(preload).toContain('getControlAllowed');
    expect(preload).toContain('setControlAllowed');
  });
  // NOTE: the renderer enforcement assertion (checking that
  // packages/controller/src/renderer/renderer.js references `controlAllowed`)
  // is deliberately NOT included here — enforcement wiring lands in Task 6/7.
  // This task's scope is the persisted setting + main/preload plumbing only,
  // so it must be independently green without the renderer change.
});
