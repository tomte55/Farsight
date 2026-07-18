// packages/signaling-server/test/server-ice.test.js
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, turnSecret: 'sec', turnTtlSeconds: 3600, turnUri: 'turn:turn.example.org:3478', turnsUri: 'turns:turn.example.org:5349?transport=tcp', ...over });

// flatten RTCIceServer.urls (string or array) to a flat list of url strings
const urlsOf = (servers) => servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

// R-1: TURN/ICE credentials must be issued only AFTER successful auth, to both
// the controller (post-auth) and the host (immediately before CONNECT) — never
// in the pre-auth REGISTERED reply.
test('ICE servers issued to controller and host on authorized connect, not in REGISTERED', async () => {
  srv = createSignalingServer({ port: 8177, config: cfg({ port: 8177 }) });
  const host = await open('ws://127.0.0.1:8177');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'a-b-c' }));
  const reg = await hostRead();
  expect(reg.type).toBe(MSG.REGISTERED);
  expect(reg.iceServers).toBeUndefined(); // R-1: nothing before auth

  const ctrl = await open('ws://127.0.0.1:8177');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'a-b-c' }));

  const ctrlIce = await ctrlRead();
  expect(ctrlIce.type).toBe(MSG.ICE_SERVERS);
  const turn = ctrlIce.iceServers.find((s) => urlsOf([s]).some((u) => u.startsWith('turn:')));
  expect(turn.username).toMatch(/^\d+$/);
  expect(typeof turn.credential).toBe('string');
  const ctrlUrls = urlsOf(ctrlIce.iceServers);
  expect(ctrlUrls.some((u) => u.startsWith('stun:'))).toBe(true);
  expect(ctrlUrls.some((u) => u.startsWith('turn:'))).toBe(true);
  expect(ctrlUrls.some((u) => u.startsWith('turns:'))).toBe(true); // TLS URL handed out

  const hostIce = await hostRead();
  expect(hostIce.type).toBe(MSG.ICE_SERVERS);
  expect(urlsOf(hostIce.iceServers).some((u) => u.startsWith('turns:'))).toBe(true);
  expect((await hostRead()).type).toBe(MSG.CONNECT);

  host.close(); ctrl.close();
});

// Plan 3 Task 4 review (Part A): without a per-flow-unique TURN username, N
// parallel transfer flows share ONE credential username, so coturn's
// user-quota caps concurrent relay allocations well below what a real
// multi-flow transfer needs. makeTurnCredential already supports a
// `flowIndex` suffix (Plan 1) -- this proves the signaling server threads it
// through: the transfer CONNECT's (initiator-claimed) flowIndex is stored on
// the session and handed to BOTH ends at ATTACH (so they share one relay
// allocation), while a DIFFERENT flowIndex yields a DIFFERENT username, and
// the legacy control-CONNECT path (no flowIndex) is untouched.
test('transfer flow gets a per-flow TURN username shared by both ends; different flows differ; control connect stays legacy', async () => {
  srv = createSignalingServer({ port: 8179, config: cfg({ port: 8179 }) });
  const host = await open('ws://127.0.0.1:8179');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  // Flow A: flowIndex 2.
  const senderA = await open('ws://127.0.0.1:8179');
  const senderARead = reader(senderA);
  senderA.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer', flowIndex: 2 }));
  const reqA = await hostRead();
  expect(reqA.type).toBe(MSG.TRANSFER_REQUEST);

  const workerA = await open('ws://127.0.0.1:8179');
  const workerARead = reader(workerA);
  workerA.send(JSON.stringify({ type: MSG.ATTACH, sessionId: reqA.sessionId }));

  const senderAIce = await senderARead();
  const workerAIce = await workerARead();
  const turnA1 = senderAIce.iceServers.find((s) => urlsOf([s]).some((u) => u.startsWith('turn:')));
  const turnA2 = workerAIce.iceServers.find((s) => urlsOf([s]).some((u) => u.startsWith('turn:')));
  // makeTurnCredential's per-flow form is `<expiry>:<flowIndex>`.
  expect(turnA1.username).toMatch(/^\d+:2$/);
  // Both ends of the SAME flow share one relay allocation -> same username.
  expect(turnA2.username).toBe(turnA1.username);

  // Flow B: a different flowIndex on a fresh session must get a DIFFERENT username.
  const senderB = await open('ws://127.0.0.1:8179');
  const senderBRead = reader(senderB);
  senderB.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer', flowIndex: 5 }));
  const reqB = await hostRead();

  const workerB = await open('ws://127.0.0.1:8179');
  workerB.send(JSON.stringify({ type: MSG.ATTACH, sessionId: reqB.sessionId }));
  const senderBIce = await senderBRead();
  const turnB = senderBIce.iceServers.find((s) => urlsOf([s]).some((u) => u.startsWith('turn:')));
  expect(turnB.username).toMatch(/^\d+:5$/);
  expect(turnB.username).not.toBe(turnA1.username);

  // A plain control CONNECT (no flowIndex) still yields the legacy
  // timestamp-only username -- unchanged for non-transfer callers.
  const ctrl = await open('ws://127.0.0.1:8179');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw' }));
  const ctrlIce = await ctrlRead();
  const turnCtrl = ctrlIce.iceServers.find((s) => urlsOf([s]).some((u) => u.startsWith('turn:')));
  expect(turnCtrl.username).toMatch(/^\d+$/);

  host.close(); senderA.close(); workerA.close(); senderB.close(); workerB.close(); ctrl.close();
});

test('failed auth never leaks ICE servers', async () => {
  srv = createSignalingServer({ port: 8178, config: cfg({ port: 8178 }) });
  const host = await open('ws://127.0.0.1:8178');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'a-b-c' }));
  const reg = await hostRead();
  const ctrl = await open('ws://127.0.0.1:8178');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'WRONG' }));
  const msg = await ctrlRead();
  expect(msg.type).toBe(MSG.ERROR);
  expect(msg.reason).toBe('bad_password');
  host.close(); ctrl.close();
});
