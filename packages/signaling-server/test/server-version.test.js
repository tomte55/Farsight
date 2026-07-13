import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, ...over });

// SP1: the app version rides the signaling handshake so each peer learns the
// other's version at connect time (before WebRTC forms) — the carrier for
// graceful cross-version handling, and the foundation SP2's console builds on.
test('host version from REGISTER is relayed to the controller as peerVersion on connect', async () => {
  srv = createSignalingServer({ port: 8191, config: cfg({ port: 8191 }) });
  const host = await open('ws://127.0.0.1:8191');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw', version: '1.4.1' }));
  const reg = await hostRead();
  expect(reg.type).toBe(MSG.REGISTERED);

  const ctrl = await open('ws://127.0.0.1:8191');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', version: '1.5.0' }));

  const ctrlIce = await ctrlRead();
  expect(ctrlIce.type).toBe(MSG.ICE_SERVERS);
  expect(ctrlIce.peerVersion).toBe('1.4.1'); // host's version handed to controller

  // Host is told the controller's version on the relayed CONNECT.
  await hostRead(); // host ICE_SERVERS
  const hostConnect = await hostRead();
  expect(hostConnect.type).toBe(MSG.CONNECT);
  expect(hostConnect.peerVersion).toBe('1.5.0');

  host.close(); ctrl.close();
});

test('missing versions relay as undefined (old client / old peer), never crashing', async () => {
  srv = createSignalingServer({ port: 8192, config: cfg({ port: 8192 }) });
  const host = await open('ws://127.0.0.1:8192');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' })); // no version
  const reg = await hostRead();

  const ctrl = await open('ws://127.0.0.1:8192');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw' })); // no version

  const ctrlIce = await ctrlRead();
  expect(ctrlIce.type).toBe(MSG.ICE_SERVERS);
  expect(ctrlIce.peerVersion).toBeUndefined();

  await hostRead();
  const hostConnect = await hostRead();
  expect(hostConnect.type).toBe(MSG.CONNECT);
  expect(hostConnect.peerVersion).toBeUndefined();

  host.close(); ctrl.close();
});

test('a non-string version in REGISTER is ignored (not relayed)', async () => {
  srv = createSignalingServer({ port: 8193, config: cfg({ port: 8193 }) });
  const host = await open('ws://127.0.0.1:8193');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw', version: { evil: true } }));
  const reg = await hostRead();

  const ctrl = await open('ws://127.0.0.1:8193');
  const ctrlRead = reader(ctrl);
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: 'pw', version: 42 }));

  const ctrlIce = await ctrlRead();
  expect(ctrlIce.peerVersion).toBeUndefined();
  await hostRead();
  const hostConnect = await hostRead();
  expect(hostConnect.peerVersion).toBeUndefined();

  host.close(); ctrl.close();
});
