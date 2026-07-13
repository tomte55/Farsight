// packages/signaling-server/test/server-update-password.test.js
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', ...over });
const tick = () => new Promise((r) => setTimeout(r, 25));

test('UPDATE_PASSWORD changes the accepted password', async () => {
  srv = createSignalingServer({ port: 8181, config: cfg({ port: 8181 }) });
  const host = await open('ws://127.0.0.1:8181');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'oldpw0' }));
  const reg = await hostRead();

  host.send(JSON.stringify({ type: MSG.UPDATE_PASSWORD, password: 'newpw1' }));
  await tick();

  const bad = await open('ws://127.0.0.1:8181');
  const badRead = reader(bad);
  bad.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'oldpw0' }));
  expect((await badRead()).reason).toBe('bad_password');

  const good = await open('ws://127.0.0.1:8181');
  good.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'newpw1' }));
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  host.close(); bad.close(); good.close();
});

test('UPDATE_PASSWORD from a non-registered socket does not affect a host', async () => {
  srv = createSignalingServer({ port: 8182, config: cfg({ port: 8182 }) });
  const host = await open('ws://127.0.0.1:8182');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'realpw' }));
  const reg = await hostRead();

  const stranger = await open('ws://127.0.0.1:8182');
  stranger.send(JSON.stringify({ type: MSG.UPDATE_PASSWORD, password: 'hijack' }));
  await tick();

  const good = await open('ws://127.0.0.1:8182');
  good.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'realpw' }));
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  host.close(); stranger.close(); good.close();
});
