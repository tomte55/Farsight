// Controller (unified Farsight app) remote-update wiring (S2.7). Ported from the
// retired host's account-wiring.test.js: the v2.0 unification dropped the
// heartbeat directive → updater wiring, so a console "Update" click set the
// device's targetVersion but the device never acted on it (remote update broke
// at 2.0.0). This static-wiring guard pins the port so it can't silently regress.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');

describe('controller remote-update wiring (S2.7)', () => {
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
