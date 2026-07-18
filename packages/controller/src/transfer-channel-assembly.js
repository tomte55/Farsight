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

import { createFlowSupervisor } from '@farsight/shared/transfer-flow-supervisor';

/**
 * SEND: build a flow SUPERVISOR that keeps `flowCount` slots filled — a
 * staggered initial dial plus a bounded-backoff re-dial of any slot that fails
 * to connect or dies mid-transfer — and fold it into the
 * {ctrl, flows, awaitFlow, onCtrlReplaced, close, onRendezvousError} shape
 * createMultiFlowSender consumes (via transfer-service).
 *
 * `flows` is the SAME live array the supervisor mutates: it starts EMPTY and
 * each slot appends a { sendBulk, isAlive } wrapper the instant it connects
 * (onFlowUp), so a re-dialed replacement flow becomes usable to the send pool
 * with no re-plumbing. `awaitFlow` is the supervisor's starvation waiter — the
 * pool awaits it (instead of throwing no_live_flows) whenever it has a chunk to
 * send but no live flow yet (staggered dial in progress, or a transient loss),
 * and it only rejects once every slot has exhausted its re-dial budget.
 *
 * The supervisor owns each worker's single-owner onSessionState slot, so it —
 * not this module — decides re-dial/aliveness. Two things it does NOT do that we
 * still must (both preserved from the pre-supervisor assembly):
 *   C1: on a slot going TERMINAL the supervisor marks not-alive + onFlowDown,
 *       but never fails the channel; a sendBulk already in flight on that dead
 *       flow would then hang the pool's Promise.race(inflight) forever. So
 *       onFlowDown fails the slot's channel to reject it.
 *   Rendezvous error: only slot 0 (the ctrl flow) surfaces a signaling-level
 *       'error:*' (bad_password/host_offline/…) to onRendezvousError so a send
 *       fails FAST instead of silently re-dialing 8× to exhaustion. Since the
 *       supervisor claims onSessionState, we MULTIPLEX slot 0's worker: our
 *       wrapper fans every state out to BOTH our error-forwarder and the
 *       supervisor's handler.
 *
 * @param {object} args
 * @param {number} args.flowCount
 * @param {(flowIndex: number) => { channel: any, onSessionState: Function, startRendezvous: Function, close: Function }} args.createWorker
 * @param {(flowIndex: number) => object} args.makeParams
 * @param {Function} [args.createSupervisor] injected for tests (default: real createFlowSupervisor)
 */
export function assembleSendFlows({
  flowCount,
  createWorker,
  makeParams,
  createSupervisor = createFlowSupervisor,
  staggerMs,
  backoff,
  maxRedialsPerSlot,
  setTimer,
  clearTimer,
}) {
  const flows = [];               // LIVE array the supervisor mutates (starts empty)
  const slotEntry = new Map();    // slotIndex -> { alive } (drives the current wrapper's isAlive)
  const slotWorker = new Map();   // slotIndex -> the worker handed to the supervisor
  const handed = new Set();       // every worker ever handed out (for close())
  let ctrlChannel = null;         // slot 0's current channel (initial + each re-dial)
  let closed = false;
  let rendezvousErrorCb = null;   // sender surfaces this as onRendezvousError
  let ctrlReplacedCb = null;      // transfer-service wires this to sender.setCtrl
  let bufferedCtrl = null;        // a ctrl swap that fired before ctrlReplacedCb registered
  let forwardedCtrl = null;       // the channel the sender currently holds (seeded below)

  function wrappedCreateWorker(slotIndex) {
    const worker = createWorker(slotIndex);
    let handedWorker = worker;
    if (slotIndex === 0) {
      // Multiplex slot 0's single-owner onSessionState (see header): forward
      // 'error:*' to onRendezvousError, then delegate to the supervisor.
      let supervisorCb = null;
      worker.onSessionState((state) => {
        if (typeof state === 'string' && state.startsWith('error:') && rendezvousErrorCb) {
          rendezvousErrorCb(state.slice('error:'.length));
        }
        if (supervisorCb) supervisorCb(state);
      });
      handedWorker = { ...worker, onSessionState(cb) { supervisorCb = cb; } };
      ctrlChannel = worker.channel; // initial ctrl; a re-dial re-runs this AND onCtrlReplaced
    }
    slotWorker.set(slotIndex, handedWorker);
    handed.add(handedWorker);
    return handedWorker;
  }

  const supervisor = createSupervisor({
    flowCount,
    createWorker: wrappedCreateWorker,
    makeParams,
    onFlowUp: (slotIndex, flow) => {
      const entry = { alive: true };
      slotEntry.set(slotIndex, entry);
      flows.push({
        sendBulk: (buf) => flow.sendBulk(buf),
        isAlive: () => entry.alive,
      });
    },
    onFlowDown: (slotIndex) => {
      const entry = slotEntry.get(slotIndex);
      if (entry) entry.alive = false;
      // C1: reject any sendBulk parked on the dead slot's channel so the pool's
      // Promise.race(inflight) settles instead of hanging on a dead flow.
      const w = slotWorker.get(slotIndex);
      if (w) { try { w.channel.fail('failed'); } catch { /* best-effort */ } }
    },
    onCtrlReplaced: (worker) => {
      ctrlChannel = worker.channel;
      // Minor #3: the supervisor fires onCtrlReplaced on EVERY slot-0 'connected',
      // including the initial one — but the sender was already seeded with that
      // exact channel via the get ctrl() getter at construction, so forwarding it
      // as a setCtrl would needlessly re-send the OFFER AND append a duplicate
      // onCtrl listener on the still-live flow-0 channel. Skip the swap whenever
      // the connecting channel is the one the sender already holds; forward only a
      // genuine re-dial (a DISTINCT channel object — Task 6). This is correct even
      // if the INITIAL dial never connected and a re-dial connects first: the
      // sender still holds the initial (dead) channel, which differs from the
      // re-dial's, so the swap fires.
      if (worker.channel === forwardedCtrl) return;
      forwardedCtrl = worker.channel;
      if (ctrlReplacedCb) ctrlReplacedCb(worker.channel);
      else bufferedCtrl = worker.channel; // registered late — replay on register
    },
    isRunning: () => !closed,
    staggerMs,
    backoff,
    maxRedialsPerSlot,
    setTimer,
    clearTimer,
  });

  supervisor.start();
  // Seed with the initial slot-0 channel (set synchronously by start()'s dial) —
  // the exact channel createMultiFlowSender reads from get ctrl() at construction.
  // onCtrlReplaced skips forwarding this one (Minor #3), forwarding only re-dials.
  forwardedCtrl = ctrlChannel;

  return {
    // Getter, not a captured value: slot 0's channel is set on the synchronous
    // start() dial and re-set by each re-dial. transfer-service reads it once to
    // seed createMultiFlowSender's ctrl; setCtrl (via onCtrlReplaced) swaps it
    // thereafter.
    get ctrl() { return ctrlChannel; },
    flows,
    awaitFlow: () => supervisor.awaitFlow(),
    // Task 9: cumulative re-dial count this transfer, for the sender's
    // aggregate progress health fields — threaded straight through from the
    // supervisor, which is the only thing that knows when a slot was ACTUALLY
    // re-dialed (vs. its initial staggered dial).
    redialCount: () => supervisor.redialCount(),
    // Registered by transfer-service AFTER it builds the sender: on every slot-0
    // (re)connect, swap the sender's ctrl channel to the fresh one so the OFFER/
    // range_report control plane survives a slot-0 death.
    onCtrlReplaced: (cb) => {
      ctrlReplacedCb = cb;
      if (bufferedCtrl != null) { const ch = bufferedCtrl; bufferedCtrl = null; cb(ch); }
    },
    // C2 (cancel-path leak fix): a user CANCEL calls close() directly, never
    // routing through a terminal session state, so nothing else fails the
    // channels. Fail every channel FIRST (rejects any in-flight sendBulk so the
    // pool unwinds and its generator's reader.close() runs), THEN stop the
    // supervisor (cancels pending (re-)dial timers + closes its current
    // workers), THEN close every worker ever handed out (the supervisor only
    // tracks each slot's CURRENT worker, so old re-dialed windows would leak).
    close: async () => {
      closed = true;
      for (const w of handed) { try { w.channel.fail('closed'); } catch { /* best-effort */ } }
      try { supervisor.stop(); } catch { /* best-effort */ }
      await Promise.all([...handed].map((w) => { try { return w.close(); } catch { return undefined; } }));
    },
    onRendezvousError: (cb) => { rendezvousErrorCb = cb; },
  };
}

/**
 * RECEIVE rolling-join dispatch: route a late/replacement flow (delivered by the
 * group rendezvous' onFlowJoin once the group has already fired) into the active
 * receiver. `sink` is the receiver's { addFlow, setCtrl } face (null when no
 * receive is active yet — the caller then closes the handle). Returns whether it
 * dispatched.
 *
 * Important #1: flow 0 is BOTH the ctrl channel AND a bulk flow — the sender
 * pushes a sendBulk wrapper for slot 0 (the pool dispatches bulk to it) and the
 * initial receive wires flow 0 as a bulk flow too (createMultiFlowReceiver
 * iterates ALL flows including ordered[0]). `setCtrl` only re-attaches the ctrl
 * handler; it never wires onBulk. So a re-dialed replacement flow 0 must be wired
 * BOTH ways — setCtrl (control plane) AND addFlow(channel, 0) (bulk routing) —
 * or every bulk chunk the sender puts on it lands nowhere (wasted bandwidth each
 * gap pass, and a hard stall to no_confirmation if it is the sole live flow).
 * There is no double-wire: setCtrl doesn't touch onBulk, and addFlow is
 * flow-agnostic (fileId+offset self-addressed bytes).
 */
export function dispatchReceiveFlowJoin(sink, channel, flowIndex) {
  if (!sink) return false;
  if (flowIndex === 0 && typeof sink.setCtrl === 'function') sink.setCtrl(channel);
  if (typeof sink.addFlow === 'function') sink.addFlow(channel, flowIndex);
  return true;
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
