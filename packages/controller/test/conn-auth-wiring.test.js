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
// Unification step 2: the actual E2E device-keypair handshake (runConnectionAuth)
// moved with the rest of the connection logic into the session window's own
// renderer. The shell's fleet Connect button now only launches that window.
const session = readFileSync(path.join(dir, '../src/session-window/session.js'), 'utf8');

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

  test('the console renders a Connect action that dials signalingId over the linked path by launching the session window', () => {
    expect(renderer).toMatch(/host-connect/);
    expect(renderer).toMatch(/signalingId/);
    expect(renderer).toMatch(/linked:\s*true/);
    expect(renderer).toMatch(/openSession\(/);
    // The shell itself never runs the CONTROLLING side of the handshake — that
    // lives in the session window. Unification step 3 (Task 7) gave the shell a
    // SEPARATE, legitimate runConnectionAuth call for the opposite role: this
    // machine BEING controlled (host/renderer.js's runHostAuth, ported
    // verbatim). Guard the role instead of banning the import outright.
    expect(renderer).toMatch(/import\s*\{[^}]*\brunConnectionAuth\b[^}]*\}\s*from\s*['"]@farsight\/shared\/connection-auth['"]/);
    expect(renderer).toMatch(/role:\s*'host'/);
    expect(renderer).not.toMatch(/role:\s*'controller'/);
  });

  // Regression guard (v1.7.2 bug): runConnectionAuth was USED but not IMPORTED →
  // ReferenceError at runtime → the controller crashed before sending hello and the
  // host timed out. Assert the actual import binding, not merely the identifier.
  // Unification step 2 moved the handshake into the session window, so this now
  // guards session.js instead of the shell's renderer.js.
  test('the session window IMPORTS runConnectionAuth (not just references it)', () => {
    expect(session).toMatch(/import\s*\{[^}]*\brunConnectionAuth\b[^}]*\}\s*from\s*['"]@farsight\/shared\/connection-auth['"]/);
  });

  test('remote-update wiring: IPC + preload + console Update button (S2.7)', () => {
    expect(main).toContain("'account:request-update'");
    expect(preload).toMatch(/\baccountRequestUpdate\b/);
    expect(renderer).toMatch(/accountRequestUpdate/);
    expect(renderer).toMatch(/host-update/);
  });

  // Regression guard: navigating away from the fleet page (showPage('home') etc,
  // which also happens on connect) must not leave the "Updating…" re-poll interval
  // making IPC calls + DOM writes into a page nobody can see for up to 60s.
  test('the fleet re-poll bails out once the fleet page is no longer active', () => {
    const pollBlock = renderer.match(/const t = setInterval\(\(\) => \{[\s\S]*?\}, 5000\);/);
    expect(pollBlock).toBeTruthy();
    expect(pollBlock[0]).toMatch(/activePage !== 'fleet'/);
    expect(pollBlock[0]).toMatch(/clearInterval\(t\)/);
  });
});
