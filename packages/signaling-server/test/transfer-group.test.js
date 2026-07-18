// SP3 multi-flow (Plan 2 Task 6): a CONNECT kind:'transfer' can carry the
// group fields (groupId/flowIndex/flowCount) so N parallel flows can be
// grouped by the receiver into one logical transfer with a single consent.
// These are RELAYED verbatim (whitelisted, R-6) — pairing/session logic is
// unchanged; each flow is still its own session/socket pair.
import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', ...over });

test('CONNECT kind:transfer relays valid groupId/flowIndex/flowCount on TRANSFER_REQUEST', async () => {
  srv = createSignalingServer({ port: 8290, config: cfg({ port: 8290 }) });
  const host = await open('ws://127.0.0.1:8290');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const groupId = 'a'.repeat(32);
  const sender = await open('ws://127.0.0.1:8290');
  sender.send(JSON.stringify({
    type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer',
    groupId, flowIndex: 2, flowCount: 4,
  }));

  const req = await hostRead();
  expect(req.type).toBe(MSG.TRANSFER_REQUEST);
  expect(typeof req.sessionId).toBe('string');
  expect(req.groupId).toBe(groupId);
  expect(req.flowIndex).toBe(2);
  expect(req.flowCount).toBe(4);

  host.close(); sender.close();
});

test('a malformed groupId is dropped, not relayed, and the transfer still proceeds', async () => {
  srv = createSignalingServer({ port: 8291, config: cfg({ port: 8291 }) });
  const host = await open('ws://127.0.0.1:8291');
  const hostRead = reader(host);
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'pw' }));
  const reg = await hostRead();

  const sender = await open('ws://127.0.0.1:8291');
  sender.send(JSON.stringify({
    type: MSG.CONNECT, targetId: reg.id, password: 'pw', kind: 'transfer',
    groupId: 'not-a-valid-group-id', flowIndex: -1, flowCount: 0,
  }));

  const req = await hostRead();
  expect(req.type).toBe(MSG.TRANSFER_REQUEST);
  expect(typeof req.sessionId).toBe('string');
  expect(req.groupId).toBeUndefined();
  expect(req.flowIndex).toBeUndefined();
  expect(req.flowCount).toBeUndefined();

  host.close(); sender.close();
});
