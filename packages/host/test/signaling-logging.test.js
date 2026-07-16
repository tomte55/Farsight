import { expect, test } from 'vitest';
import { createSignalingClient } from '../src/signaling-client.js';

class FakeWS {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.listeners = {}; FakeWS.last = this; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  send() {}
  close() {}
  fire(t, ev = {}) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
}

function makeLog() { const calls = []; const mk = () => ({ debug: (m) => calls.push(m), info: (m) => calls.push(m), warn: (m) => calls.push(m), error: (m) => calls.push(m), child: mk }); return { log: mk(), calls }; }

test('logs open/register and close-with-reconnect', () => {
  const { log, calls } = makeLog();
  const timers = [];
  createSignalingClient('wss://x/y', {}, {
    WebSocketImpl: FakeWS, log,
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return 1; }, clearTimeout: () => {},
  });
  FakeWS.last.readyState = FakeWS.OPEN;
  FakeWS.last.fire('open');
  FakeWS.last.fire('close');
  const text = calls.join('\n');
  expect(text).toMatch(/register sent|socket open/);
  expect(text).toMatch(/reconnect .*(1000|attempt)/);
});

test('never logs the password', () => {
  const { log, calls } = makeLog();
  createSignalingClient('wss://x/y', {}, { WebSocketImpl: FakeWS, log, password: 'SECRET123', setTimeout: () => 1, clearTimeout: () => {} });
  FakeWS.last.readyState = FakeWS.OPEN;
  FakeWS.last.fire('open');
  expect(calls.join('\n')).not.toMatch(/SECRET123/);
});
