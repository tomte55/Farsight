// Host signaling client auto-reconnect + re-register (SP2 connect-from-console):
// a dropped socket must self-heal so the host stays registered/connectable.
import { expect, test, describe, beforeEach } from 'vitest';
import { MSG } from '@farsight/shared/protocol';
import { createSignalingClient } from '../src/host-signaling-client.js';

let instances;
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = {}; instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  emit(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); }
  fireOpen() { this.readyState = FakeWS.OPEN; this.emit('open'); }
}

let timers;
const setT = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
const clearT = () => {};
const opts = (extra) => ({ WebSocketImpl: FakeWS, setTimeout: setT, clearTimeout: clearT, ...extra });

beforeEach(() => { instances = []; timers = []; });

describe('host signaling client reconnect', () => {
  test('registers on open with acceptsLinked/version/password', () => {
    createSignalingClient('ws://127.0.0.1:8080', {}, opts({ password: 'pw', version: '1.7.2', acceptsLinked: true }));
    instances[0].fireOpen();
    const reg = JSON.parse(instances[0].sent[0]);
    expect(reg.type).toBe(MSG.REGISTER);
    expect(reg.acceptsLinked).toBe(true);
    expect(reg.version).toBe('1.7.2');
    expect(reg.password).toBe('pw');
  });

  test('reconnects and re-registers after an unexpected close', () => {
    createSignalingClient('ws://127.0.0.1:8080', {}, opts({ acceptsLinked: true }));
    instances[0].fireOpen();
    expect(instances).toHaveLength(1);

    instances[0].close();               // drop (e.g. server restart)
    expect(timers).toHaveLength(1);     // a reconnect was scheduled
    expect(timers[0].delay).toBe(1000); // first backoff = 1s

    timers[0].fn();                     // fire the reconnect
    expect(instances).toHaveLength(2);  // a new socket
    instances[1].fireOpen();
    expect(JSON.parse(instances[1].sent[0]).type).toBe(MSG.REGISTER); // re-registered
  });

  test('does NOT reconnect after an intentional close()', () => {
    const client = createSignalingClient('ws://127.0.0.1:8080', {}, opts());
    instances[0].fireOpen();
    client.close();
    expect(timers).toHaveLength(0);     // no reconnect scheduled
  });

  test('backoff grows and caps at 15s', () => {
    createSignalingClient('ws://127.0.0.1:8080', {}, opts());
    // never opens (attempt never resets) → 1s,2s,4s,8s,15s,15s...
    const delays = [];
    for (let i = 0; i < 6; i++) {
      instances[i].close();
      delays.push(timers[i].delay);
      timers[i].fn();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});
