import { expect, test, afterEach } from 'vitest';
import { createSignalingServer } from '../src/server.js';
import { MSG } from '@farsight/shared/protocol';
import { passwordCandidates } from '@farsight/shared/credentials-format';
import { open, reader } from './ws-helpers.js';

let srv;
afterEach(async () => { if (srv) await srv.close(); });
const cfg = (over) => ({ maxAttempts: 5, windowMs: 1000, ...over });

// SP1 live-break regression: a pre-v1.4 host registered the DASHED literal it
// showed on screen. A v1.4+ controller normalizes what the user types (strips
// dashes) — that normalized value no longer matches, so the connect fails on
// the first candidate and must succeed on the raw typed value. This drives the
// exact two-attempt sequence the controller performs, against the real auth path.
test('controller connects to an old dashed-literal host by falling back to the raw typed value', async () => {
  srv = createSignalingServer({ port: 8195, config: cfg({ port: 8195 }) });
  const host = await open('ws://127.0.0.1:8195');
  const hostRead = reader(host);
  // Old host: the session password IS the dashed literal shown on its screen.
  host.send(JSON.stringify({ type: MSG.REGISTER, password: 'AB-CD-EF' }));
  const reg = await hostRead();
  expect(reg.type).toBe(MSG.REGISTERED);

  // User types exactly what the old host displays; controller derives candidates.
  const candidates = passwordCandidates('AB-CD-EF');
  expect(candidates).toEqual(['abcdef', 'AB-CD-EF']); // normalized first, raw fallback

  const ctrl = await open('ws://127.0.0.1:8195');
  const ctrlRead = reader(ctrl);

  // Attempt 1: normalized → rejected (old host stored the dashed literal).
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: candidates[0] }));
  const first = await ctrlRead();
  expect(first.type).toBe(MSG.ERROR);
  expect(first.reason).toBe('bad_password');

  // Attempt 2: raw typed value → accepted.
  ctrl.send(JSON.stringify({ type: MSG.CONNECT, targetId: reg.id, password: candidates[1] }));
  const second = await ctrlRead();
  expect(second.type).toBe(MSG.ICE_SERVERS);

  host.close(); ctrl.close();
});
