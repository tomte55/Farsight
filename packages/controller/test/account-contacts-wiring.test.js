// Controller contacts wiring (SP3 Phase 3 Task 2). Mirrors the host's
// account-wiring.test.js pattern: static guards that the account:contact*
// IPC handlers are registered in main and bridged to the renderer via
// preload — no existing controller test covers the base account:fleet-style
// wiring, so this file also anchors that pattern for the controller.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preloadSrc = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');

describe('controller contacts wiring', () => {
  test('wires contacts IPC + preload bridges', () => {
    for (const topic of ['account:contacts', 'account:contact-add', 'account:contact-accept', 'account:contact-decline']) {
      expect(mainSrc).toContain(topic);
    }
    expect(preloadSrc).toMatch(/accountContacts:/);
    expect(preloadSrc).toMatch(/accountContactAdd:/);
    expect(preloadSrc).toMatch(/accountContactAccept:/);
    expect(preloadSrc).toMatch(/accountContactDecline:/);
  });
});
