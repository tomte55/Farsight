// Unification step 2 moved the CONTROLLING-role remote-control session (and its
// connection-correlated logger) out of the shell's renderer.js and into the
// session window's own renderer — see session-window/session.js. Step 3 / Task 7
// then gave the shell a SEPARATE, legitimate per-connection correlated logger of
// its own for the opposite role — this machine BEING controlled (inbound
// consent/capture/peer/auth, ported from host/renderer.js) — so the shell now
// has its own `conn:${connId}` scope again, distinct from (and independent of)
// the session window's. What must still never come back into the shell is the
// CONTROLLING-side peer/signaling machinery itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
const dir = path.dirname(fileURLToPath(import.meta.url));
const r = readFileSync(path.join(dir, '../src/session-window/session.js'), 'utf8');
const shell = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

test('the session window builds a root logger and passes children into connection modules', () => {
  expect(r).toMatch(/createRendererLogger/);
  expect(r).toMatch(/createControllerPeer\(\{[\s\S]*log:/);
  expect(r).toMatch(/createSignalingClient\([\s\S]*log:/);
});
test('the session window stamps a connection correlation id', () => {
  expect(r).toMatch(/conn:/);
});
test('the shell never builds the CONTROLLING-role peer/signaling connection', () => {
  expect(shell).not.toContain('createControllerPeer');
  // The banned import is the ONE-SHOT session signaling client
  // (src/signaling-client.js, driven by session-window/session.js) — that
  // stays out of the shell. Task 6 legitimately imports a DIFFERENT file,
  // the auto-registering host-signaling-client.js, to register this machine
  // as a controllable host — a plain not.toContain('createSignalingClient')
  // would false-positive on that aliased import, so this checks the specific
  // banned import path instead.
  expect(shell).not.toMatch(/from\s*['"]\.\.?\/signaling-client\.js['"]/);
});
test('the shell stamps its OWN per-connection correlated logger for the HOSTING role (Task 7)', () => {
  // Task 6 uses createRendererLogger for host-REGISTRATION logging (a single,
  // long-lived scope); Task 7 adds a genuinely separate per-connection
  // correlation id on top of it — `clog = hlog.child(\`conn:${connId}\`)`,
  // re-stamped on every inbound MSG.CONNECT — mirroring host/renderer.js's own
  // pattern (and the session window's, for the other role) exactly.
  expect(shell).toMatch(/conn:\$\{connId\}/);
  expect(shell).toMatch(/connId = newConnId\(\)/);
});
