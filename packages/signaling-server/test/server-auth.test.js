// packages/signaling-server/test/server-auth.test.js
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', ...over });

test('wrong password is rejected; correct password connects', async () => {
  srv = createSignalingServer({ port: 8155, config: cfg({ port: 8155 }) });
  const host = await open('ws://127.0.0.1:8155');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'abcd-efgh-jkmn' }));
  const reg = await hostRead();

  const bad = await open('ws://127.0.0.1:8155');
  const badRead = reader(bad);
  bad.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'wrong-wrong-wrng' }));
  expect((await badRead()).reason).toBe('bad_password');

  const good = await open('ws://127.0.0.1:8155');
  good.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'abcd-efgh-jkmn' }));
  // R-1: host receives ICE_SERVERS before the CONNECT notification.
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  host.close(); bad.close(); good.close();
});

test('locks out after repeated wrong passwords', async () => {
  srv = createSignalingServer({ port: 8156, config: cfg({ port: 8156, maxAttempts: 2, windowMs: 10000 }) });
  const host = await open('ws://127.0.0.1:8156');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'right-right-rite' }));
  const reg = await hostRead();
  for (let i = 0; i < 2; i++) {
    const c = await open('ws://127.0.0.1:8156');
    const cRead = reader(c);
    c.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'nope-nope-nope0' }));
    expect((await cRead()).reason).toBe('bad_password');
    c.close();
  }
  const c = await open('ws://127.0.0.1:8156');
  const cRead = reader(c);
  c.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'right-right-rite' }));
  expect((await cRead()).reason).toBe('locked');
  host.close(); c.close();
});

// R-5: a second controller cannot hijack a host already in a session.
test('rejects a concurrent connect with busy', async () => {
  srv = createSignalingServer({ port: 8157, config: cfg({ port: 8157 }) });
  const host = await open('ws://127.0.0.1:8157');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'busy-busy-busy0' }));
  const reg = await hostRead();

  const first = await open('ws://127.0.0.1:8157');
  first.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'busy-busy-busy0' }));
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS); // R-1
  expect((await hostRead()).type).toBe(MSG.CONNECT);      // first controller paired

  const second = await open('ws://127.0.0.1:8157');
  const secondRead = reader(second);
  second.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'busy-busy-busy0' }));
  expect((await secondRead()).reason).toBe('busy');

  host.close(); first.close(); second.close();
});
