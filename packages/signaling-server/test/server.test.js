// packages/signaling-server/test/server.test.js
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });

test('host registers and controller relay reaches host', async () => {
  srv = createSignalingServer({ port: 8137 });
  const host = await open('ws://127.0.0.1:8137');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'test-test-test' }));
  const reg = await hostRead();
  expect(reg.type).toBe(MSG.REGISTERED);
  expect(reg.id).toMatch(/^[1-9]\d{8}$/);

  const ctrl = await open('ws://127.0.0.1:8137');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'test-test-test' }));
  // R-1: controller gets ICE_SERVERS; host gets ICE_SERVERS then CONNECT.
  expect((await ctrlRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  host.send(JSON.stringify({ type: MSG.OFFER, sdp: 'v=0' }));
  const relayed = await ctrlRead();
  expect(relayed.type).toBe(MSG.OFFER);
  expect(relayed.sdp).toBe('v=0');

  host.close(); ctrl.close();
});
