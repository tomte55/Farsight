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
import { assembleReceiveGroup } from '../src/transfer-channel-assembly.js';
import { createGroupRendezvous } from '@farsight/shared/transfer-group-rendezvous';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const workerModule = readFileSync(path.join(dir, '../src/transfer-worker.js'), 'utf8');
const workerRenderer = readFileSync(path.join(dir, '../src/transfer-worker/worker.js'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

// NOTE: the former `assembleSendFlows (SEND multi-flow assembly)` describe block
// lived here. Task 7 (resilient multi-flow) rewrote assembleSendFlows on top of
// the flow supervisor (staggered dial + bounded re-dial + a LIVE flows array),
// so its unit contract moved to transfer-channel-assembly.test.js (injected fake
// supervisor). The C1 (fail-on-terminal) and C2 (fail-on-close) invariants those
// old tests pinned are re-encoded there against the supervisor model.

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

  // C1 (I1): createGroupRendezvous can fire onGroupReady with a PARTIAL group
  // (its join-window timeout fires with whatever flows connected -- exactly
  // the Starlink-handover scenario: flow 0 died before ever connecting). The
  // paired sender ALWAYS sends the manifest OFFER on ITS flow 0, so silently
  // anchoring ctrl on the lowest-CONNECTED flow (flow 1 here) would listen for
  // that OFFER on the wrong data channel forever -- a silent hang, not a
  // clean failure. Must abort (return null) instead.
  test('a partial group with NO flowIndex-0 handle aborts instead of anchoring ctrl on flow 1', () => {
    const h1 = fakeHandle(1), h2 = fakeHandle(2);
    const bundle = assembleReceiveGroup([h1, h2]);
    expect(bundle).toBeNull();
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

  // C1 (I1): assembleReceiveGroup returns null for a partial group missing
  // flowIndex 0. onGroupReady must check for that and bail out BEFORE ever
  // calling startReceive/populating pendingGroupReceives (both of which the
  // "assembles the bundle" test above already anchors on `bundle`) -- and
  // still release the group's resources (close the flows that DID connect,
  // cancel the group) instead of leaking them.
  test('onGroupReady aborts (does not call startReceive) when the bundle is null, and still releases the group', () => {
    expect(main).toMatch(/if\s*\(\s*!bundle\s*\)\s*\{/);
    expect(main).toMatch(/Promise\.all\(flows\.map\(\(f\)\s*=>\s*f\.close\(\)\)\)/);
    expect(main).toMatch(/if\s*\(\s*!bundle\s*\)\s*\{[\s\S]*?groupRendezvous\.cancel\(groupId\);[\s\S]*?return;[\s\S]*?\}/);
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
