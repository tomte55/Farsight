// SP3 (spec §4): a CONNECT with kind:'transfer' starts a multiplexed transfer
// session — the target is notified without consuming its control pairing.
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', ...over });

test('CONNECT kind:transfer notifies the target with a sessionId', async () => {
  srv = createSignalingServer({ port: 8191, config: cfg({ port: 8191 }) });
  const host = await open('ws://127.0.0.1:8191');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'abcd-efgh-jkmn' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8191');
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'abcd-efgh-jkmn', kind: 'transfer' }));

  const req = await hostRead();
  expect(req.type).toBe(MSG.TRANSFER_REQUEST);
  expect(typeof req.sessionId).toBe('string');
  expect(req.sessionId.length).toBeGreaterThan(0);

  host.close(); sender.close();
});

test('a transfer request coexists with an active control pairing (not busy)', async () => {
  srv = createSignalingServer({ port: 8192, config: cfg({ port: 8192 }) });
  const host = await open('ws://127.0.0.1:8192');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const ctrl = await open('ws://127.0.0.1:8192');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw' }));
  expect((await ctrlRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  const sender = await open('ws://127.0.0.1:8192');
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer' }));
  expect((await hostRead()).type).toBe(MSG.TRANSFER_REQUEST);

  host.close(); ctrl.close(); sender.close();
});

test('a transfer CONNECT with a bad password is rejected and opens no session', async () => {
  srv = createSignalingServer({ port: 8195, config: cfg({ port: 8195 }) });
  const host = await open('ws://127.0.0.1:8195');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'right' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8195');
  const senderRead = reader(sender);
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'wrong', kind: 'transfer' }));
  expect((await senderRead()).reason).toBe('bad_password');

  host.close(); sender.close();
});
