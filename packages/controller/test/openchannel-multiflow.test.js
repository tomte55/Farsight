// packages/controller/test/openchannel-multiflow.test.js
// Plan 3 Task 4: unit tests for the pure (Electron-free) assembly helpers that
// main.js's openChannel now delegates to — assembleSendFlows (SEND, N workers
// -> {ctrl,flows,close,onRendezvousError}) and assembleReceiveGroup (RECEIVE,
// N already-opened attach handles -> the same {ctrl,flows,close,peerAuth}
// shape). These run as REAL executable tests against fake worker objects (no
// electron/BrowserWindow involved), unlike main.js itself which can only be
// verified via text-based wiring guards (it imports 'electron' at module
// scope and can't be loaded outside a real Electron process — see
// transfer-worker-wiring.test.js / controller-transfer-ui-wiring.test.js for
// that existing convention, extended below for the new group-field threading).
//
// Also exercises the REAL createGroupRendezvous (shared, Plan 3 Task 2)
// end-to-end with a fake openFlow, proving the exact interplay main.js relies
// on: out-of-order flow arrival still yields a correctly flowIndex-0-anchored
// {ctrl,flows} bundle.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, test, expect, vi } from 'vitest';
import { assembleSendFlows, assembleReceiveGroup } from '../src/transfer-channel-assembly.js';
import { createGroupRendezvous } from '@farsight/shared/transfer-group-rendezvous';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const workerModule = readFileSync(path.join(dir, '../src/transfer-worker.js'), 'utf8');
const workerRenderer = readFileSync(path.join(dir, '../src/transfer-worker/worker.js'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

// A fake transfer-worker: same shape as createTransferWorker()'s return value
// (channel/onSessionState/startRendezvous/close), but with a spy-able,
// synchronously-driveable session-state slot instead of a real IPC round trip.
function fakeWorker() {
  let stateCb = null;
  return {
    channel: { sendCtrl: vi.fn(), onCtrl: vi.fn(), sendBulk: vi.fn(), onBulk: vi.fn() },
    onSessionState: vi.fn((cb) => { stateCb = cb; }),
    startRendezvous: vi.fn(),
    close: vi.fn(async () => {}),
    __emit: (state) => stateCb && stateCb(state),
  };
}

describe('assembleSendFlows (SEND multi-flow assembly)', () => {
  test('creates exactly flowCount workers and starts each rendezvous with its own flowIndex', () => {
    const workers = [];
    const created = [];
    assembleSendFlows({
      flowCount: 3,
      createWorker: (i) => { const w = fakeWorker(); workers.push(w); return w; },
      makeParams: (flowIndex) => { created.push(flowIndex); return { role: 'initiator', groupId: 'g', flowIndex, flowCount: 3 }; },
    });
    expect(workers.length).toBe(3);
    expect(created).toEqual([0, 1, 2]);
    workers.forEach((w, i) => {
      expect(w.startRendezvous).toHaveBeenCalledTimes(1);
      expect(w.startRendezvous.mock.calls[0][0]).toMatchObject({ flowIndex: i, flowCount: 3, groupId: 'g' });
    });
  });

  test('ctrl is worker 0\'s channel; flows.length === flowCount, each wired to its own worker\'s sendBulk', () => {
    const workers = [];
    const { ctrl, flows } = assembleSendFlows({
      flowCount: 3,
      createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
      makeParams: (flowIndex) => ({ flowIndex }),
    });
    expect(ctrl).toBe(workers[0].channel);
    expect(flows.length).toBe(3);
    const buf = new ArrayBuffer(4);
    flows[1].sendBulk(buf);
    expect(workers[1].channel.sendBulk).toHaveBeenCalledWith(buf);
    expect(workers[0].channel.sendBulk).not.toHaveBeenCalled();
    expect(workers[2].channel.sendBulk).not.toHaveBeenCalled();
  });

  test('isAlive() tracks each worker\'s OWN session state independently (connected/disconnected/closed)', () => {
    const workers = [];
    const { flows } = assembleSendFlows({
      flowCount: 2,
      createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
      makeParams: () => ({}),
    });
    expect(flows[0].isAlive()).toBe(false);
    expect(flows[1].isAlive()).toBe(false);
    workers[0].__emit('connected');
    expect(flows[0].isAlive()).toBe(true);
    expect(flows[1].isAlive()).toBe(false); // worker 1 untouched
    workers[1].__emit('connected');
    expect(flows[1].isAlive()).toBe(true);
    workers[0].__emit('disconnected');
    expect(flows[0].isAlive()).toBe(false);
    expect(flows[1].isAlive()).toBe(true); // still alive
    workers[1].__emit('closed');
    expect(flows[1].isAlive()).toBe(false);
  });

  test('an error: state marks that worker not-alive, and (worker 0 only) forwards to onRendezvousError', () => {
    const workers = [];
    const { flows, onRendezvousError } = assembleSendFlows({
      flowCount: 2,
      createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
      makeParams: () => ({}),
    });
    const errors = [];
    onRendezvousError((reason) => errors.push(reason));
    workers[0].__emit('connected');
    workers[1].__emit('connected');
    // A non-primary worker's rendezvous error marks it dead but is NOT surfaced
    // (only worker 0 -- the one whose channel IS `ctrl` -- reports rendezvous
    // errors, mirroring the single-flow openChannel's onRendezvousError).
    workers[1].__emit('error:host_offline');
    expect(flows[1].isAlive()).toBe(false);
    expect(errors).toEqual([]);
    workers[0].__emit('error:bad_password');
    expect(flows[0].isAlive()).toBe(false);
    expect(errors).toEqual(['bad_password']);
  });

  test('close() closes every worker', async () => {
    const workers = [];
    const { close } = assembleSendFlows({
      flowCount: 3,
      createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
      makeParams: () => ({}),
    });
    await close();
    workers.forEach((w) => expect(w.close).toHaveBeenCalledTimes(1));
  });
});

describe('assembleReceiveGroup (RECEIVE multi-flow assembly)', () => {
  function fakeHandle(flowIndex) {
    return { channel: { onBulk: vi.fn(), onCtrl: vi.fn(), sendCtrl: vi.fn() }, close: vi.fn(async () => {}), peerAuth: Promise.resolve({ tier: 'fleet' }), flowIndex };
  }

  test('picks flowIndex-0\'s channel as ctrl and peerAuth even when handles arrive OUT OF ORDER', () => {
    const h2 = fakeHandle(2), h0 = fakeHandle(0), h1 = fakeHandle(1);
    // Arrival order deliberately scrambled -- this is the realistic case: each
    // flow is an independent WebRTC/signaling race, so flowIndex 0 need not be
    // first. The paired SENDER always uses ITS flowIndex-0 worker as ctrl
    // (assembleSendFlows), so the receiver must agree or it listens for the
    // OFFER on the wrong data channel and the transfer hangs at 0.
    const bundle = assembleReceiveGroup([h2, h0, h1]);
    expect(bundle.ctrl).toBe(h0.channel);
    expect(bundle.peerAuth).toBe(h0.peerAuth);
    expect(bundle.flows).toEqual([h0.channel, h1.channel, h2.channel]);
  });

  test('close() closes every handle', async () => {
    const handles = [fakeHandle(0), fakeHandle(1)];
    await assembleReceiveGroup(handles).close();
    handles.forEach((h) => expect(h.close).toHaveBeenCalledTimes(1));
  });
});

describe('assembleReceiveGroup wired to the REAL createGroupRendezvous (shared, Plan 3 Task 2)', () => {
  test('a real 3-flow group, offered out of order, yields onGroupReady -> assembleReceiveGroup with the correct ctrl', () => {
    const GROUP = 'g'.repeat(32);
    const handlesByFlow = new Map();
    function openFlow({ sessionId, flowIndex, groupId, linked }) {
      const h = { channel: { onBulk: vi.fn(), tag: `ch${flowIndex}` }, close: vi.fn(async () => {}), peerAuth: Promise.resolve({ tier: null }), flowIndex };
      handlesByFlow.set(flowIndex, h);
      return h;
    }
    let readyGroup = null;
    const gr = createGroupRendezvous({
      openFlow,
      onGroupReady: (g) => { readyGroup = g; },
    });
    // Offered out of order: flow 2, then 0, then 1.
    gr.offer({ sessionId: 's2', groupId: GROUP, flowIndex: 2, flowCount: 3, linked: false });
    gr.offer({ sessionId: 's0', groupId: GROUP, flowIndex: 0, flowCount: 3, linked: false });
    expect(readyGroup).toBeNull();
    gr.offer({ sessionId: 's1', groupId: GROUP, flowIndex: 1, flowCount: 3, linked: false });
    expect(readyGroup).not.toBeNull();
    expect(readyGroup.flowCount).toBe(3);

    const bundle = assembleReceiveGroup(readyGroup.flows);
    expect(bundle.ctrl).toBe(handlesByFlow.get(0).channel);
    expect(bundle.ctrl.tag).toBe('ch0');

    gr.cancel(GROUP); // Task 2 review note: must not throw / must not re-close live flows
  });

  test('a legacy request (no groupId/flowCount) fires onGroupReady immediately with a single flow', () => {
    const ready = [];
    const gr = createGroupRendezvous({
      openFlow: ({ sessionId }) => ({ channel: { tag: 'solo' }, close: vi.fn(async () => {}), peerAuth: Promise.resolve({ tier: null }), flowIndex: 0 }),
      onGroupReady: (g) => ready.push(g),
    });
    gr.offer({ sessionId: 'solo-session', linked: false });
    expect(ready.length).toBe(1);
    expect(ready[0].flowCount).toBe(1);
    // main.js's onGroupReady uses flows[0] directly (NOT assembleReceiveGroup)
    // for the legacy/flowCount===1 case -- confirm that shape still round-trips.
    expect(ready[0].flows[0].channel.tag).toBe('solo');
  });
});

describe('main.js: SEND assembly wiring (text-based — main.js imports electron, can only run in Electron)', () => {
  test('imports assembleSendFlows/assembleReceiveGroup from the new pure module', () => {
    expect(main).toMatch(/import\s*\{[^}]*\bassembleSendFlows\b[^}]*\bassembleReceiveGroup\b[^}]*\}\s*from\s*['"]\.\/transfer-channel-assembly\.js['"]/);
  });

  test('imports createGroupRendezvous from @farsight/shared/transfer-group-rendezvous', () => {
    expect(main).toMatch(/import\s*\{\s*createGroupRendezvous\s*\}\s*from\s*['"]@farsight\/shared\/transfer-group-rendezvous['"]/);
  });

  test('openChannel routes flowCount>1 SEND through assembleSendFlows with a minted groupId', () => {
    expect(main).toMatch(/flowCount\s*>\s*1/);
    expect(main).toMatch(/const groupId = newJobId\(\);/);
    expect(main).toMatch(/assembleSendFlows\(\{/);
  });

  test('transfer:incoming feeds groupRendezvous.offer(...) instead of calling startReceive directly', () => {
    expect(main).toContain("'transfer:incoming'");
    expect(main).toMatch(/groupRendezvous\.offer\(\{\s*sessionId,\s*groupId,\s*flowIndex,\s*flowCount,\s*linked\s*\}\)/);
  });

  test('onGroupReady assembles the bundle and calls startReceive, then cancels the group (no map leak)', () => {
    expect(main).toMatch(/onGroupReady:\s*\(\{\s*groupId,\s*flowCount,\s*flows\s*\}\)\s*=>/);
    expect(main).toMatch(/flowCount\s*>\s*1\s*\?\s*assembleReceiveGroup\(flows\)\s*:\s*flows\[0\]/);
    // Tightened (Plan 3 Task 4 review): a bare substring match on
    // `groupRendezvous.cancel(groupId)` passes even if the call were hoisted
    // out of the .finally(...) and run unconditionally (before startReceive
    // resolves, or even if startReceive never settles) -- which would
    // re-open the "group map leak" bug this line exists to close. Require the
    // actual .finally(...) wiring so moving the call out of it fails this test.
    expect(main).toMatch(/\.finally\(\(\)\s*=>\s*groupRendezvous\.cancel\(groupId\)\)/);
  });

  test('openChannel(attach) looks up the pre-opened bundle from pendingGroupReceives by sessionId', () => {
    expect(main).toMatch(/pendingGroupReceives\.get\(sessionId\)/);
    expect(main).toMatch(/pendingGroupReceives\.delete\(sessionId\)/);
  });

  test('the flowCount<=1 SEND path still returns the existing {channel,close,onRendezvousError,peerAuth} shape', () => {
    // Tightened (Plan 3 Task 4 review): `worker.onSessionState` /
    // `onRendezvousError` / `startsWith('error:')` / `channel: worker.channel,`
    // ALSO appear verbatim in openAttachFlow (the RECEIVE/attach branch above),
    // so those four substrings alone can't distinguish "the single-flow SEND
    // branch was deleted" from "only the attach branch remains". Anchor on
    // text that exists ONLY in this branch: the bare `signalingUrl` local
    // (attach/multi-flow both call `currentSignalingUrl()` inline instead)
    // feeding the initiator startRendezvous call with no groupId/flowIndex/
    // flowCount fields, and a return object that ends right after `peerAuth,`
    // (openAttachFlow's return has `linked`/`flowIndex` fields after peerAuth).
    expect(main).toMatch(/const signalingUrl = currentSignalingUrl\(\);/);
    expect(main).toMatch(/worker\.startRendezvous\(\{\s*\n\s*role: 'initiator',\s*\n\s*signalingUrl,\s*\n\s*targetId: target\?\.id,\s*\n\s*password: target\?\.password,/);
    expect(main).toMatch(/onRendezvousError:\s*\(cb\)\s*=>\s*\{\s*rendezvousErrorCb\s*=\s*cb;\s*\},\s*\n\s*peerAuth,\s*\n\s*\};/);
  });
});

describe('transfer-worker.js / worker.js: groupId/flowIndex/flowCount threaded onto CONNECT + ATTACH', () => {
  test('transfer-worker.js\'s startRendezvous doc now documents the group fields (transparent passthrough, no logic change)', () => {
    expect(workerModule).toMatch(/groupId\?/);
    expect(workerModule).toMatch(/flowIndex\?/);
    expect(workerModule).toMatch(/flowCount\?/);
  });

  test('worker.js destructures groupId/flowIndex/flowCount from the rendezvous params', () => {
    expect(workerRenderer).toMatch(/const\s*\{[^}]*\bgroupId\b[^}]*\bflowIndex\b[^}]*\bflowCount\b[^}]*\}\s*=\s*params/);
  });

  test('the initiator CONNECT carries groupId/flowIndex/flowCount', () => {
    expect(workerRenderer).toMatch(/MSG\.CONNECT,\s*\{[^}]*groupId[^}]*flowIndex[^}]*flowCount[^}]*\}/);
  });

  test('the attacher ATTACH carries groupId/flowIndex', () => {
    expect(workerRenderer).toMatch(/MSG\.ATTACH,\s*\{[^}]*groupId[^}]*flowIndex[^}]*\}/);
  });
});

describe('renderer.js: TRANSFER_REQUEST forwards the group fields to main', () => {
  test('groupId/flowIndex/flowCount ride along on transferIncoming', () => {
    expect(renderer).toMatch(/transferIncoming\(\{\s*sessionId:\s*m\.sessionId,\s*linked:\s*!!m\.linked,\s*groupId:\s*m\.groupId,\s*flowIndex:\s*m\.flowIndex,\s*flowCount:\s*m\.flowCount\s*\}\)/);
  });
});
