// packages/controller/test/session-window-wiring.test.js
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(__dirname, '../src/main.js'), 'utf8');
const preload = readFileSync(resolve(__dirname, '../src/preload.cjs'), 'utf8');

describe('session-window main wiring', () => {
  test('main constructs the session window via the factory', () => {
    expect(main).toContain("from './session-window.js'");
    expect(main).toMatch(/createSessionWindow\(/);
  });
  test('main handles session:open and session:focus from the shell', () => {
    expect(main).toContain("'session:open'");
    expect(main).toContain("'session:focus'");
  });
  test('main forwards session status and close to the shell window', () => {
    expect(main).toContain("'session:status'");
    expect(main).toContain("'session:closed'");
  });
});

describe('shell preload exposes the session bridge', () => {
  test('openSession, focusSession, onSessionStatus, onSessionClosed', () => {
    for (const m of ['openSession', 'focusSession', 'onSessionStatus', 'onSessionClosed']) {
      expect(preload, `preload must expose ${m}`).toContain(m);
    }
  });
});
