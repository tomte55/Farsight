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
