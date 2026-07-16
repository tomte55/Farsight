import { expect, test } from 'vitest';
import { createSignalingClient } from '../src/signaling-client.js';

// The controller's signaling-client is a simpler, non-reconnecting one-shot
// CONNECT-flow socket (unlike the host's auto-reconnect client) — no
// WebSocketImpl/timer injection exists, so this stubs the global WebSocket.
class FakeWS extends EventTarget {
  static OPEN = 1;
  constructor() { super(); this.readyState = 0; FakeWS.last = this; }
  send() {}
  close() {}
}

// Tag each call with its level so tests can assert on warn-vs-info intent.
function makeLog() { const calls = []; const mk = () => ({ debug: (m) => calls.push(['debug', m]), info: (m) => calls.push(['info', m]), warn: (m) => calls.push(['warn', m]), error: (m) => calls.push(['error', m]), child: mk }); return { log: mk(), calls }; }
const text = (calls) => calls.map((c) => c.join(' ')).join('\n');

test('logs connecting then socket open', () => {
  global.WebSocket = FakeWS;
  const { log, calls } = makeLog();
  createSignalingClient('wss://x/y', {}, { log });
  FakeWS.last.readyState = FakeWS.OPEN;
  FakeWS.last.dispatchEvent(new Event('open'));
  const t = text(calls);
  expect(t).toMatch(/connecting/);
  expect(t).toMatch(/socket open/);
});

test('an intentional close() logs at info, NOT warn', () => {
  global.WebSocket = FakeWS;
  const { log, calls } = makeLog();
  const client = createSignalingClient('wss://x/y', {}, { log });
  // Normal teardown: caller invokes close(), the socket then fires its close event.
  client.close();
  FakeWS.last.dispatchEvent(new Event('close'));
  const t = text(calls);
  expect(t).toMatch(/info socket closed/);
  expect(t).not.toMatch(/warn socket closed/);
});

test('a spontaneous close event (no close() call) logs at warn', () => {
  global.WebSocket = FakeWS;
  const { log, calls } = makeLog();
  createSignalingClient('wss://x/y', {}, { log });
  // Socket drops on its own — never called close().
  FakeWS.last.dispatchEvent(new Event('close'));
  expect(text(calls)).toMatch(/warn socket closed unexpectedly/);
});

test('logs a warning on socket error', () => {
  global.WebSocket = FakeWS;
  const { log, calls } = makeLog();
  createSignalingClient('wss://x/y', {}, { log });
  FakeWS.last.dispatchEvent(new Event('error'));
  expect(text(calls)).toMatch(/warn socket error/);
});

test('never logs the password', () => {
  global.WebSocket = FakeWS;
  const { log, calls } = makeLog();
  createSignalingClient('wss://x/y', {}, { log, password: 'SECRET123' });
  FakeWS.last.readyState = FakeWS.OPEN;
  FakeWS.last.dispatchEvent(new Event('open'));
  expect(text(calls)).not.toMatch(/SECRET123/);
});
