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

  test('wires contacts IPC + preload bridges', () => {
    for (const topic of ['account:contacts', 'account:contact-add', 'account:contact-accept', 'account:contact-decline']) {
      expect(main).toContain(topic);
    }
    expect(preload).toMatch(/accountContacts:/);
    expect(preload).toMatch(/accountContactAdd:/);
    expect(preload).toMatch(/accountContactAccept:/);
    expect(preload).toMatch(/accountContactDecline:/);
  });
});

describe('host connect-from-console wiring (SP2 §4.4)', () => {
  test('main constructs the account service with a device-key file path', () => {
    expect(main).toMatch(/deviceKeyFilePath/);
  });

  test('the host advertises acceptsLinked on REGISTER (opts into password-free linked connect)', () => {
    const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');
    const client = readFileSync(path.join(dir, '../src/signaling-client.js'), 'utf8');
    // The renderer must pass acceptsLinked:true, and the signaling client must
    // include it in the REGISTER payload — else the server rejects linked connects
    // as bad_password.
    expect(renderer).toMatch(/acceptsLinked:\s*true/);
    expect(client).toMatch(/acceptsLinked/);
    expect(client).toMatch(/REGISTER,\s*\{[^}]*acceptsLinked/);
  });

  test('main publishes the signaling id to the account service on registration', () => {
    // set-host-id (renderer → main) must feed setSignalingId so the console can
    // learn where to dial this host (rendezvous).
    expect(main).toMatch(/set-host-id/);
    expect(main).toMatch(/setSignalingId/);
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
});

describe('host remote-update wiring (S2.7)', () => {
  test('acts on a converge-to directive from the account heartbeat', () => {
    // onUpdateDirective → shouldConverge gate → installWhenReady.
    expect(main).toMatch(/onUpdateDirective/);
    expect(main).toMatch(/shouldConverge/);
    expect(main).toMatch(/installWhenReady/);
    expect(main).toMatch(/import\s*\{[^}]*\bshouldConverge\b[^}]*\}\s*from\s*['"]@farsight\/shared\/update-policy['"]/);
  });

  test('the remote-update directive forces the install (overrides the session guard)', () => {
    // The owner pressed Update while connected to the host; without force the
    // install defers and nothing appears to happen (observed in the field).
    expect(main).toMatch(/installWhenReady\(\{\s*force:\s*true\s*\}\)/);
  });
});
