// packages/controller/test/transfer-signaling-client.test.js
// F-B1 (Plan 1b Task 5): the transfer worker's ONE-SHOT signaling client must
// REPORT its own failure instead of hanging `await signal.ready` forever.
//
// Before this fix, createSignalingClient registered only open/message and `ready`
// only ever resolved — a socket that errored, or closed before opening, wedged the
// worker's `await signal.ready` and the supervisor slot stuck `dialing`. These
// tests pin the BEHAVIOUR: ready rejects on error / close-before-open / connect
// timeout, resolves on open, and a drop AFTER open notifies onClose (so worker.js
// can surface a terminal session-state) while an intentional close() does not.
//
// The WebSocket + timers are injected (same pattern as host-signaling-client.test.js)
// so no real socket/clock is needed. Mutation checks: revert each new handler in
// signaling-client.js and the matching test hangs/fails.
import { expect, test, describe, beforeEach, vi } from 'vitest';
import { createSignalingClient } from '../src/transfer-worker/signaling-client.js';

let instances;
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = {}; instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  emit(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); }
  fireOpen() { this.readyState = FakeWS.OPEN; this.emit('open'); }
  fireError() { this.emit('error', new Error('boom')); }
  fireClose() { this.readyState = 3; this.emit('close'); }
}

let timers;
const setT = (fn, delay) => { const id = timers.length; timers.push({ fn, delay, id }); return id; };
const clearT = (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; };
// wss url so assertSecureSignalingUrl accepts it off-localhost too.
const opts = (extra) => ({ WebSocketImpl: FakeWS, setTimeout: setT, clearTimeout: clearT, ...extra });

beforeEach(() => { instances = []; timers = []; });

describe('transfer signaling-client reports failure (F-B1)', () => {
  test('ready RESOLVES on open and clears the connect timeout (no late rejection)', async () => {
    const c = createSignalingClient('wss://sig.example/', {}, opts({ connectTimeoutMs: 5000 }));
    instances[0].fireOpen();
    await expect(c.ready).resolves.toBeUndefined();
    // the connect-timeout timer was cleared on open so it can't reject later
    expect(timers.some((t) => t.cleared)).toBe(true);
  });

  test('ready REJECTS when the socket errors before open (was: hang forever)', async () => {
    const c = createSignalingClient('wss://sig.example/', {}, opts());
    instances[0].fireError();
    await expect(c.ready).rejects.toThrow(/error|signaling/i);
  });

  test('ready REJECTS when the socket closes before ever opening', async () => {
    const c = createSignalingClient('wss://sig.example/', {}, opts());
    instances[0].fireClose();
    await expect(c.ready).rejects.toThrow(/closed|signaling/i);
  });

  test('ready REJECTS on connect timeout when the socket never opens', async () => {
    const c = createSignalingClient('wss://sig.example/', {}, opts({ connectTimeoutMs: 8000 }));
    const timer = timers.find((t) => t.delay === 8000);
    expect(timer).toBeTruthy(); // a bounded connect timeout was armed
    timer.fn();                 // fire it (socket still never opened)
    await expect(c.ready).rejects.toThrow(/timeout|signaling/i);
  });

  test('a drop AFTER open notifies onClose (so the worker surfaces a terminal state)', async () => {
    const onClose = vi.fn();
    const c = createSignalingClient('wss://sig.example/', {}, opts({ onClose }));
    instances[0].fireOpen();
    await c.ready;
    expect(onClose).not.toHaveBeenCalled();
    instances[0].fireClose(); // e.g. signaling server restarts mid-transfer
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('an INTENTIONAL close() does NOT notify onClose (no spurious terminal on teardown)', async () => {
    const onClose = vi.fn();
    const c = createSignalingClient('wss://sig.example/', {}, opts({ onClose }));
    instances[0].fireOpen();
    await c.ready;
    c.close();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('an error AFTER a resolved ready does not throw an unhandled rejection on ready', async () => {
    const c = createSignalingClient('wss://sig.example/', {}, opts());
    instances[0].fireOpen();
    await expect(c.ready).resolves.toBeUndefined();
    // late error must not re-settle the already-resolved ready
    expect(() => instances[0].fireError()).not.toThrow();
  });
});
