// Connect-from-console (SP2): a host may advertise `acceptsLinked` so the owner's
// own account devices can pair WITHOUT a session password (real auth is the E2E
// keypair handshake downstream). A linked connect to a host that did NOT advertise
// it still requires the password.
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', ...over });

test('linked controller pairs with an acceptsLinked host and no password', async () => {
  srv = createSignalingServer({ port: 8171, config: cfg({ port: 8171 }) });
  const host = await open('ws://127.0.0.1:8171');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, acceptsLinked: true }));
  const reg = await hostRead();
  expect(reg.type).toBe(MSG.REGISTERED);

  const ctrl = await open('ws://127.0.0.1:8171');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, linked: true }));
  // Paired: controller gets ICE_SERVERS (not an ERROR).
  expect((await ctrlRead()).type).toBe(MSG.ICE_SERVERS);
  // Host also gets ICE_SERVERS then CONNECT.
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  host.close(); ctrl.close();
});

test('linked connect is rejected when the host did NOT advertise acceptsLinked', async () => {
  srv = createSignalingServer({ port: 8172, config: cfg({ port: 8172 }) });
  const host = await open('ws://127.0.0.1:8172');
  const hostRead = reader(host);
  // No acceptsLinked, no password.
  host.send(JSON.stringify({ type: MSG.REGISTER }));
  const reg = await hostRead();

  const ctrl = await open('ws://127.0.0.1:8172');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, linked: true }));
  expect((await ctrlRead()).reason).toBe('bad_password');

  host.close(); ctrl.close();
});

test('a normal password connect still works on an acceptsLinked host', async () => {
  srv = createSignalingServer({ port: 8173, config: cfg({ port: 8173 }) });
  const host = await open('ws://127.0.0.1:8173');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, acceptsLinked: true, password: 'abcd-efgh-jkmn' }));
  const reg = await hostRead();

  const ctrl = await open('ws://127.0.0.1:8173');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'abcd-efgh-jkmn' }));
  expect((await ctrlRead()).type).toBe(MSG.ICE_SERVERS);

  host.close(); ctrl.close();
});
