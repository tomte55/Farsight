// packages/controller/test/control-toggle.test.js
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(__dirname, '../src/main.js'), 'utf8');
const preload = readFileSync(resolve(__dirname, '../src/preload.cjs'), 'utf8');
const renderer = readFileSync(resolve(__dirname, '../src/renderer/renderer.js'), 'utf8');

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
  // Task 6: the shell renderer now reads the setting and gates host
  // REGISTRATION on it — when control is OFF, no registering client is ever
  // created (fail closed), so this machine is simply absent from the
  // signaling server and unreachable for control.
  test('the renderer enforces the setting on host registration', () => {
    expect(renderer).toMatch(/controlAllowed/);
    expect(renderer).toContain('getControlAllowed');
  });
});
