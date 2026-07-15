// Controller connect-from-console wiring (SP2 §4.4). The console's Connect action
// dials a fleet device by its signaling id (linked, no password) and runs the E2E
// device-keypair handshake; the crypto lives in main and is bridged to the renderer.
// Static-wiring guards, mirroring the account-wiring pattern.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

describe('controller connect-from-console wiring', () => {
  test('main constructs the account service with a device-key file path', () => {
    expect(main).toMatch(/deviceKeyFilePath/);
  });

  test('main registers the connect-auth crypto IPC handlers', () => {
    for (const ch of ['conn-auth:public-key', 'conn-auth:device-id', 'conn-auth:sign', 'conn-auth:verify', 'conn-auth:is-account-key']) {
      expect(main).toContain(`'${ch}'`);
    }
  });

  test('preload exposes the connect-auth bridge', () => {
    for (const fn of ['connAuthPublicKey', 'connAuthDeviceId', 'connAuthSign', 'connAuthVerify', 'connAuthIsAccountKey']) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  test('the console renders a Connect action that dials signalingId over the linked path', () => {
    expect(renderer).toMatch(/host-connect/);
    expect(renderer).toMatch(/signalingId/);
    expect(renderer).toMatch(/linked:\s*true/);
    expect(renderer).toMatch(/runConnectionAuth/);
  });

  // Regression guard (v1.7.2 bug): runConnectionAuth was USED but not IMPORTED →
  // ReferenceError at runtime → the controller crashed before sending hello and the
  // host timed out. Assert the actual import binding, not merely the identifier.
  test('the renderer IMPORTS runConnectionAuth (not just references it)', () => {
    expect(renderer).toMatch(/import\s*\{[^}]*\brunConnectionAuth\b[^}]*\}\s*from\s*['"]@farsight\/shared\/connection-auth['"]/);
  });
});
