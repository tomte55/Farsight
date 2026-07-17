// Unification step 2 moved the remote-control session (and therefore the
// connection-correlated logger it drives) out of the shell's renderer.js and
// into the session window's own renderer — see session-window/session.js.
// This guard now targets that file; the shell owns no connection logging.
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
test('the shell no longer builds the controller-session peer/signaling connection', () => {
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
test('the shell no longer stamps a PER-CONNECTION correlated logger — that moved with the session', () => {
  // Task 6 legitimately uses createRendererLogger for host-REGISTRATION
  // logging (a single, long-lived scope) — a different concern from the
  // session's per-connection correlation id (session.js's
  // `clog = rlog.child(\`conn:${connId}\`)`, re-stamped on every CONNECT).
  // That specific pattern is what must stay out of the shell.
  expect(shell).not.toMatch(/conn:\$\{/);
});
