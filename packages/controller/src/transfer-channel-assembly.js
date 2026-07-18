// packages/controller/src/transfer-channel-assembly.js
// Plan 3 Task 4: pure (Electron-free) assembly logic for a MULTI-FLOW
// openChannel. Building the N-worker send bundle and folding N already-opened
// attach handles into the receive bundle is plain data-shaping — kept out of
// main.js and free of any `electron`/BrowserWindow import so it can be
// unit-tested directly (inject a fake worker/handle shape), unlike main.js
// itself which can't be imported outside a real Electron process.
//
// Shapes (must match transfer-service.js's Plan 3 Task 3 consumption exactly):
//   SEND   ctrl.{sendCtrl,onCtrl} + flows[].{sendBulk,isAlive}  (createSendPool)
//   RECEIVE ctrl.{sendCtrl,onCtrl} + flows[].{onBulk}            (createMultiFlowReceiver)
// Both come out of createTransferChannel(), so `worker.channel` already
// satisfies whichever shape is needed — SEND wraps it (sendBulk/isAlive),
// RECEIVE uses it directly (it already has onBulk).

// A transfer-worker's onSessionState callback slot is single-owner (exactly one
// handler per worker — see transfer-worker.js), so the ONE handler installed
// per worker here has to do both jobs: track aliveness for createSendPool, and
// (flow 0 only, mirroring the single-flow openChannel's onRendezvousError)
// forward a rendezvous-level error.
//
// C1 (critical deadlock fix): a flow that dies must not just stop being
// dispatched NEW chunks (isAlive()->false) — any sendBulk ALREADY in flight on
// it has to be forced to settle too, or the send pool's Promise.race(inflight)
// waits forever on a promise nothing will ever resolve (the worker only
// credits an open data channel). So on a TERMINAL state ('failed', 'closed',
// or any 'error:*') we both mark not-alive AND call channel.fail(state) to
// reject any pending sendBulk. 'disconnected' is deliberately treated as only
// transient here — wireConnectionState() in transfer-worker/worker.js debounces
// a single ICE-restart attempt on it, so it may recover; if it truly dies the
// connection escalates to 'failed', which IS terminal and calls fail().
function wireAliveness(worker, aliveMap, onError) {
  worker.onSessionState((state) => {
    if (state === 'connected') { aliveMap.set(worker, true); return; }
    if (state === 'disconnected') { aliveMap.set(worker, false); return; } // transient — may ICE-restart
    if (state === 'failed' || state === 'closed') {
      aliveMap.set(worker, false);
      worker.channel.fail(state);
      return;
    }
    if (typeof state === 'string' && state.startsWith('error:')) {
      aliveMap.set(worker, false);
      worker.channel.fail(state);
      if (onError) onError(state.slice('error:'.length));
    }
  });
}

/**
 * SEND: open `flowCount` workers (via `createWorker(flowIndex)`), kick off
 * each one's initiator rendezvous (via `makeParams(flowIndex)` -> the params
 * object passed to `worker.startRendezvous`), and fold them into the
 * {ctrl, flows, close, onRendezvousError} shape createMultiFlowSender expects.
 *
 * @param {object} args
 * @param {number} args.flowCount
 * @param {(flowIndex: number) => { channel: any, onSessionState: Function, startRendezvous: Function, close: Function }} args.createWorker
 * @param {(flowIndex: number) => object} args.makeParams
 */
export function assembleSendFlows({ flowCount, createWorker, makeParams }) {
  const workers = [];
  const alive = new Map();
  let rendezvousErrorCb = null;
  for (let flowIndex = 0; flowIndex < flowCount; flowIndex += 1) {
    const worker = createWorker(flowIndex);
    alive.set(worker, false);
    wireAliveness(worker, alive, flowIndex === 0 ? (reason) => { if (rendezvousErrorCb) rendezvousErrorCb(reason); } : null);
    worker.startRendezvous(makeParams(flowIndex));
    workers.push(worker);
  }
  return {
    ctrl: workers[0].channel,
    flows: workers.map((w) => ({
      sendBulk: (buf) => w.channel.sendBulk(buf),
      isAlive: () => !!alive.get(w),
    })),
    close: async () => { await Promise.all(workers.map((w) => w.close())); },
    onRendezvousError: (cb) => { rendezvousErrorCb = cb; },
  };
}

/**
 * RECEIVE: fold N already-opened attach handles (one per flow, each
 * `{channel, close, peerAuth, flowIndex?}` — the same shape the single-flow
 * openChannel attach branch already returns, plus a `flowIndex` so this can
 * order them correctly) into the {ctrl, flows, close, peerAuth} shape
 * transfer-service.js's runMultiFlowReceive expects.
 *
 * Handles are NOT guaranteed to arrive index-ordered (each flow is an
 * independent WebRTC/signaling race — see transfer-group-rendezvous.js), so
 * this sorts by flowIndex before picking flowIndex-0's channel as `ctrl`: the
 * paired sender ALWAYS uses its flowIndex-0 worker as ctrl (assembleSendFlows
 * above builds workers in order), so the receiver must line up the same flow
 * or it listens for the manifest OFFER on the wrong data channel and the
 * transfer hangs at 0.
 *
 * C1 (I1): `createGroupRendezvous` can fire a PARTIAL group — its join-window
 * timeout fires `onGroupReady` with whichever flows arrived, even if fewer
 * than `flowCount` (exactly the Starlink-handover scenario: a flow died before
 * ever connecting). If that partial group has NO flowIndex-0 handle at all,
 * there is nothing to anchor `ctrl` on: the sender will send its manifest
 * OFFER on ITS flow 0 regardless, so silently substituting the lowest
 * connected flow (e.g. flow 1) as ctrl means the OFFER never arrives on the
 * channel we're listening on — a silent hang, not a clean failure. Returns
 * `null` in that case so the caller aborts the receive instead of hanging.
 */
export function assembleReceiveGroup(handles) {
  const ordered = [...handles].sort((a, b) => {
    const ai = Number.isInteger(a.flowIndex) ? a.flowIndex : 0;
    const bi = Number.isInteger(b.flowIndex) ? b.flowIndex : 0;
    return ai - bi;
  });
  if (!ordered.some((h) => h.flowIndex === 0)) return null;
  return {
    ctrl: ordered[0].channel,
    flows: ordered.map((h) => h.channel),
    close: async () => { await Promise.all(ordered.map((h) => h.close())); },
    peerAuth: ordered[0].peerAuth,
  };
}
