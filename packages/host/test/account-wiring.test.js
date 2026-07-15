// Host account enrollment wiring (SP2 S2.5/S2.6). Signing into the account on the
// host machine links it as a Device under the owner's account (§4.3: local login
// on the host is the one-time consent gate) and heartbeats presence so it shows
// up online + versioned in the controller's fleet console. The account service
// (login/logout/status/fleet + heartbeat) is the shared, unit-tested one; here we
// only guard the host's main-process construction, IPC handlers, and preload
// bridge — mirroring the controller — using the project's static-wiring pattern.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');

describe('host account enrollment wiring', () => {
  test('main constructs the shared account service with safeStorage + app version', () => {
    expect(main).toMatch(/createAccountService/);
    expect(main).toMatch(/@farsight\/shared\/account-service/);
    // safeStorage must be imported from electron for the encrypted token store
    expect(main).toMatch(/\bsafeStorage\b/);
    // presence heartbeat reports this app's version
    expect(main).toMatch(/version:\s*app\.getVersion\(\)/);
  });

  test('main defaults the device name to the machine hostname', () => {
    // the sandboxed renderer can't read os.hostname(); main supplies it so the
    // fleet console labels the host by its machine name
    expect(main).toMatch(/hostname/);
  });

  test('main registers the account IPC handlers', () => {
    for (const ch of ['account:status', 'account:login', 'account:logout', 'account:register', 'account:resend-verification', 'account:request-password-reset', 'account:fleet']) {
      expect(main).toContain(`'${ch}'`);
    }
  });

  test('preload exposes the account bridge to the renderer', () => {
    for (const fn of ['accountStatus', 'accountLogin', 'accountLogout', 'accountRegister', 'accountResendVerification', 'accountRequestPasswordReset', 'accountFleet']) {
      expect(preload).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });
});
