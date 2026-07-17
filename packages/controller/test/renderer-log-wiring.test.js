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
test('the shell no longer builds a connection-correlated logger — that moved with the session', () => {
  expect(shell).not.toContain('createRendererLogger');
  expect(shell).not.toContain('createControllerPeer');
  expect(shell).not.toContain('createSignalingClient');
});
