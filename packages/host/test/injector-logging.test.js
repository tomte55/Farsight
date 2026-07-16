// packages/host/test/injector-logging.test.js
// Verbose diagnostic logging (see docs/private/superpowers): the injector logs
// counts/shape-level facts only — never key values or coordinates.
import { expect, test } from 'vitest';
import { createInjector } from '../src/input-injector.js';

function makeLog() {
  const calls = [];
  const mk = () => ({
    debug: (m) => calls.push(m),
    info: (m) => calls.push(m),
    warn: (m) => calls.push(m),
    error: (m) => calls.push(m),
    child: mk,
  });
  return { log: mk(), calls };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const primary = { bounds: { x: 0, y: 0, width: 1, height: 1 }, index: 0, primary: true };
const secondary = { bounds: { x: 0, y: 0, width: 2, height: 2 }, index: 1, primary: false };

test('injector logs a warning on an invalid event, without the payload', () => {
  const { log, calls } = makeLog();
  const inj = createInjector({ nut: {}, display: primary, dipToScreen: (p) => p, log });
  inj.inject({ type: 'key', key: 'TOPSECRET', bogus: true }); // shape-invalid
  expect(calls.join('\n')).toMatch(/invalid|dropped/i);
  expect(calls.join('\n')).not.toMatch(/TOPSECRET/);
});

test('injector logs info on a display switch', () => {
  const { log, calls } = makeLog();
  const inj = createInjector({ nut: {}, display: primary, dipToScreen: (p) => p, log });
  inj.setDisplay(secondary);
  expect(calls.join('\n')).toMatch(/display/i);
});

test('injector logs an injection failure by message only (no coords/key values)', async () => {
  const { log, calls } = makeLog();
  const nut = { moveMouse: async () => { throw new Error('nut boom'); } };
  const inj = createInjector({ nut, display: primary, dipToScreen: (p) => p, log });
  inj.inject({ type: 'mousemove', x: 0.999, y: 0.111 });
  await tick();
  expect(calls.join('\n')).toMatch(/injection failed/i);
  expect(calls.join('\n')).toMatch(/nut boom/);
  expect(calls.join('\n')).not.toMatch(/0\.999|0\.111/);
});
