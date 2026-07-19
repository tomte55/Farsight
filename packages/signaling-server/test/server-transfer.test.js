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
  srv = createSignalingServer({ port: 8281, config: cfg({ port: 8281 }) });
  const host = await open('ws://127.0.0.1:8281');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'abcd-efgh-jkmn' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8281');
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'abcd-efgh-jkmn', kind: 'transfer' }));

  const req = await hostRead();
  expect(req.type).toBe(MSG.TRANSFER_REQUEST);
  // The sessionId is an unguessable bearer capability (ATTACH does no targetId
  // check), so it must be a 128-bit token, NOT the ~30-bit 9-digit host id.
  expect(req.sessionId).toMatch(/^[0-9a-f]{32}$/);

  host.close(); sender.close();
});

test('a transfer request coexists with an active control pairing (not busy)', async () => {
  srv = createSignalingServer({ port: 8282, config: cfg({ port: 8282 }) });
  const host = await open('ws://127.0.0.1:8282');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const ctrl = await open('ws://127.0.0.1:8282');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw' }));
  expect((await ctrlRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  const sender = await open('ws://127.0.0.1:8282');
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer' }));
  expect((await hostRead()).type).toBe(MSG.TRANSFER_REQUEST);

  host.close(); ctrl.close(); sender.close();
});

test('a transfer CONNECT with a bad password is rejected and opens no session', async () => {
  srv = createSignalingServer({ port: 8283, config: cfg({ port: 8283 }) });
  const host = await open('ws://127.0.0.1:8283');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'right' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8283');
  const senderRead = reader(sender);
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'wrong', kind: 'transfer' }));
  expect((await senderRead()).reason).toBe('bad_password');

  host.close(); sender.close();
});

test('ATTACH pairs the transfer sockets, both get ICE_SERVERS, and OFFER relays', async () => {
  srv = createSignalingServer({ port: 8284, config: cfg({ port: 8284 }) });
  const host = await open('ws://127.0.0.1:8284');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8284');
  const senderRead = reader(sender);
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer' }));
  const req = await hostRead();
  expect(req.type).toBe(MSG.TRANSFER_REQUEST);

  // The host opens its transfer worker socket and attaches to the session.
  const worker = await open('ws://127.0.0.1:8284');
  const workerRead = reader(worker);
  worker.send(JSON.stringify({ type: MSG.ATTACH, sessionId: req.sessionId }));

  expect((await senderRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await workerRead()).type).toBe(MSG.ICE_SERVERS);

  // SDP relays between the paired transfer sockets.
  sender.send(JSON.stringify({ type: MSG.OFFER, sdp: 'x-sdp' }));
  const off = await workerRead();
  expect(off.type).toBe(MSG.OFFER);
  expect(off.sdp).toBe('x-sdp');

  host.close(); sender.close(); worker.close();
});

test('ATTACH to an unknown session is rejected', async () => {
  srv = createSignalingServer({ port: 8285, config: cfg({ port: 8285 }) });
  const w = await open('ws://127.0.0.1:8285');
  const wRead = reader(w);
  w.send(JSON.stringify({ type: MSG.ATTACH, sessionId: 'nope' }));
  expect((await wRead()).reason).toBe('no_session');
  w.close();
});

test('a second ATTACH to an already-attached session is rejected', async () => {
  srv = createSignalingServer({ port: 8288, config: cfg({ port: 8288 }) });
  const host = await open('ws://127.0.0.1:8288');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8288');
  const senderRead = reader(sender);
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer' }));
  const req = await hostRead();

  const worker = await open('ws://127.0.0.1:8288');
  const workerRead = reader(worker);
  worker.send(JSON.stringify({ type: MSG.ATTACH, sessionId: req.sessionId }));
  expect((await senderRead()).type).toBe(MSG.ICE_SERVERS);
  expect((await workerRead()).type).toBe(MSG.ICE_SERVERS);

  // A second worker cannot hijack the already-paired session.
  const intruder = await open('ws://127.0.0.1:8288');
  const intruderRead = reader(intruder);
  intruder.send(JSON.stringify({ type: MSG.ATTACH, sessionId: req.sessionId }));
  expect((await intruderRead()).reason).toBe('no_session');

  host.close(); sender.close(); worker.close(); intruder.close();
});

test('an unattached session times out and errors the initiator', async () => {
  srv = createSignalingServer({ port: 8286, config: cfg({ port: 8286, sessionTimeoutMs: 80 }) });
  const host = await open('ws://127.0.0.1:8286');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8286');
  const senderRead = reader(sender);
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer' }));
  expect((await hostRead()).type).toBe(MSG.TRANSFER_REQUEST);
  expect((await senderRead()).reason).toBe('transfer_timeout');

  host.close(); sender.close();
});

test('if the initiator drops before attach, the session is gone', async () => {
  srv = createSignalingServer({ port: 8287, config: cfg({ port: 8287 }) });
  const host = await open('ws://127.0.0.1:8287');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8287');
  sender.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer' }));
  const req = await hostRead();
  sender.close();
  await new Promise((r) => { const t = setTimeout(r, 40); if (t.unref) t.unref(); });

  const worker = await open('ws://127.0.0.1:8287');
  const workerRead = reader(worker);
  worker.send(JSON.stringify({ type: MSG.ATTACH, sessionId: req.sessionId }));
  expect((await workerRead()).reason).toBe('no_session');

  host.close(); worker.close();
});
