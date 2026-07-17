// packages/controller/test/host-capability-wiring.test.js
// Static guards for Task 7 (unification step 3): the shell renderer's
// inbound-control path — consent, capture, host peer, device-keypair auth gate,
// and validated input injection. The project does not run DOM tests (vitest
// environment:'node'); renderer wiring is guarded by source-text assertions
// plus the headless-Electron probes (shell-launch.probe.mjs,
// session-launch.probe.mjs), which supply POSITIVE proof the module graph
// executed. See CLAUDE.md: mutation-test any guard that pins an invariant —
// the input-gate test below is written as an exact, whole-line string match
// specifically so that stripping `|| peerAuthed` (or any other token in the
// gate) breaks it; this was verified by hand (temporarily removing
// `|| peerAuthed` from renderer.js, confirming this test fails, then
// restoring it) as part of completing this task — see task-7-report.md.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const renderer = readFileSync(resolve(__dirname, '../src/renderer/renderer.js'), 'utf8');
const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8');
const injector = readFileSync(resolve(__dirname, '../src/input-injector.js'), 'utf8');

describe('host capability — imports', () => {
  test('renderer imports createHostPeer from host-peer.js', () => {
    expect(renderer).toMatch(/import\s*\{\s*createHostPeer\s*\}\s*from\s*['"]\.\.\/host-peer\.js['"]/);
  });
  test('renderer imports createSession from session.js', () => {
    expect(renderer).toMatch(/import\s*\{\s*createSession\s*\}\s*from\s*['"]\.\.\/session\.js['"]/);
  });
  test('renderer imports createSessionTimers from timeouts.js', () => {
    expect(renderer).toMatch(/import\s*\{\s*createSessionTimers\s*\}\s*from\s*['"]\.\.\/timeouts\.js['"]/);
  });
  test('renderer imports monitorsForControl from capture.js', () => {
    expect(renderer).toMatch(/import\s*\{\s*monitorsForControl\s*\}\s*from\s*['"]\.\.\/capture\.js['"]/);
  });
  test('renderer imports runConnectionAuth for the HOST role', () => {
    expect(renderer).toMatch(/import\s*\{\s*runConnectionAuth\s*\}\s*from\s*['"]@farsight\/shared\/connection-auth['"]/);
    expect(renderer).toMatch(/role:\s*'host'/);
  });
});

describe('host capability — SECURITY: the input gate', () => {
  // The non-negotiable gate from CLAUDE.md/the brief, ported byte-for-byte from
  // host/src/renderer/renderer.js:280. A linked (own-fleet, password-free)
  // session must NOT inject input until the device-keypair handshake sets
  // peerAuthed = true — `session.isActive()` alone is not enough for that path.
  test('onInput forwards to main IFF session.isActive() && (!linkedConnect || peerAuthed) — verbatim', () => {
    expect(renderer).toContain(
      'onInput: (evt) => { if (session.isActive() && (!linkedConnect || peerAuthed)) { window.farsightIpc.injectInput(evt); if (timers) timers.activity(); } },',
    );
  });

  test('peerAuthed only flips true after runConnectionAuth resolves (the handshake, not a sender-supplied flag)', () => {
    const fn = renderer.slice(renderer.indexOf('async function runHostAuth'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/await p;\s*\n\s*peerAuthed = true;/);
  });

  test('linkedConnect is set from the SERVER-relayed CONNECT flag, never trusted from elsewhere', () => {
    expect(renderer).toMatch(/linkedConnect = !!\(m && m\.linked\)/);
  });
});

describe('host capability — control-channel validation', () => {
  test('onControl validates every inbound control frame before acting on it', () => {
    const fn = renderer.slice(renderer.indexOf('async function onControl'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/try\s*\{\s*evt = validateControlEvent\(raw\);\s*\}\s*catch\s*\{\s*return;\s*\}/);
  });
  test('renderer imports validateControlEvent from the shared control-events module', () => {
    expect(renderer).toMatch(/import\s*\{\s*CONTROL,\s*validateControlEvent\s*\}\s*from\s*['"]@farsight\/shared\/control-events['"]/);
  });
  test('input events are ALSO validated in the main-process injector (second, independent layer)', () => {
    expect(injector).toMatch(/import\s*\{\s*validateInputEvent[^}]*\}\s*from\s*['"]@farsight\/shared\/input-events['"]/);
    expect(injector).toMatch(/validateInputEvent\(rawEvent\)/);
  });
});

describe('host capability — consent markup', () => {
  test('the consent modal and its Allow/Deny buttons exist', () => {
    expect(html).toContain('id="consent"');
    expect(html).toContain('id="allow"');
    expect(html).toContain('id="deny"');
  });
  test('the consent modal reuses the shared overlay/veil/card primitives (no bespoke modal CSS)', () => {
    const modal = html.slice(html.indexOf('id="consent"'), html.indexOf('id="consent"') + 600);
    expect(modal).toMatch(/class="overlay"/);
    expect(modal).toContain('class="veil"');
    expect(modal).toMatch(/class="card/);
  });
  test('the panic-unavailable warning bar exists', () => {
    expect(html).toContain('id="panic-warning"');
  });
});

describe('host capability — consent state machine', () => {
  test('linked connects auto-accept: requestConsent() + allow() + startSession(), no visible prompt', () => {
    const branch = renderer.slice(renderer.indexOf('if (linkedConnect) {'), renderer.indexOf('} else {'));
    expect(branch).toMatch(/session\.requestConsent\(\);/);
    expect(branch).toMatch(/session\.allow\(\);/);
    expect(branch).toMatch(/startSession\(\);/);
  });
  test('password (ad-hoc) connects show a real consent prompt: requestConsent() WITHOUT an immediate allow()', () => {
    const start = renderer.indexOf('} else {', renderer.indexOf('if (linkedConnect) {'));
    const branch = renderer.slice(start, renderer.indexOf('\n      },', start));
    expect(branch).toMatch(/session\.requestConsent\(\);/);
    expect(branch).not.toMatch(/session\.allow\(\);/);
    expect(branch).not.toMatch(/startSession\(\);/);
  });
  test('the Allow button starts the session; Deny tears down without ever capturing', () => {
    expect(renderer).toMatch(/getElementById\('allow'\)\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{\s*\n\s*session\.allow\(\);/);
    expect(renderer).toMatch(/getElementById\('deny'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*\n\s*session\.deny\(\);\s*\n\s*teardown\(\);/);
  });
});

describe('host capability — reachability is gated on control being allowed (Task 6)', () => {
  test('MSG.CONNECT/OFFER/CANDIDATE/PEER_DISCONNECTED all live on hostSignal\'s own handler map', () => {
    // i.e. inside startHostRegistration(), NOT a second, always-on signaling
    // client — so this whole path only exists while hostSignal exists (control
    // allowed AND a signaling URL configured).
    const fnStart = renderer.indexOf('async function startHostRegistration');
    const fnEnd = renderer.indexOf('\nfunction stopHostRegistration', fnStart);
    const body = renderer.slice(fnStart, fnEnd);
    for (const handler of ['[MSG.CONNECT]:', '[MSG.OFFER]:', '[MSG.CANDIDATE]:', '[MSG.PEER_DISCONNECTED]:']) {
      expect(body, `${handler} must be inside startHostRegistration`).toContain(handler);
    }
  });
});
