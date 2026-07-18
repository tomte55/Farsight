// packages/shared/src/transfer-flow-supervisor.js
// Pure, runtime-agnostic supervisor that keeps N transfer "flow slots" filled.
// It replaces assembleSendFlows' one-shot "dial all N at once, never re-dial a
// dead one" loop, which lost 3/8 flows to a startup connection storm on a lossy
// Starlink link and never recovered them. Two fixes, both here:
//   1. STAGGERED initial dial — slot 0 at t=0, slots 1..N-1 at staggerMs
//      increments — so N simultaneous ICE gathers don't stampede the link.
//   2. Bounded-backoff RE-DIAL of a slot that goes TERMINAL — same slotIndex,
//      after backoff[min(attempt, backoff.length-1)] (last value repeats), only
//      while isRunning() and attempt < maxRedialsPerSlot.
//
// No electron/WebRTC/DOM/fs: timers (setTimer/clearTimer) and worker creation
// (createWorker) are injected, so a fake clock + fake workers unit-test every
// guard. A LATER task wires this into the Electron transfer layer.
//
// Session-state semantics mirror assembleSendFlows' wireAliveness():
//   'connected'                      -> ALIVE (a flow appeared)
//   'disconnected'                   -> not-alive but TRANSIENT (worker debounces
//                                       an ICE-restart; never re-dial here)
//   'failed' | 'closed' | 'error:*'  -> TERMINAL (re-dial this slot)
//
// Slot 0 is the ctrl flow: whenever slot 0's worker connects (initial or
// re-dial), onCtrlReplaced(worker) fires so the caller can re-anchor the
// manifest/ctrl channel on the fresh worker.
//
// Starvation waiter (awaitFlow-compatible, feeds the send pool's awaitFlow): a
// single pending deferred that resolves on the NEXT onFlowUp and rejects once
// EVERY slot has exhausted maxRedialsPerSlot with none alive — so the pool
// throws no_live_flows only when recovery is truly impossible. onSlotStarved
// callbacks fire each time liveCount() falls to 0.

export function createFlowSupervisor({
  flowCount,
  createWorker,
  makeParams,
  onFlowUp,
  onFlowDown,
  onCtrlReplaced,
  staggerMs = 250,
  backoff = [500, 1000, 2000, 4000],
  maxRedialsPerSlot = 8,
  isRunning,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // Per-slot state. `attempt` = number of re-dials already scheduled for this
  // slot (0 on the initial dial); it also indexes `backoff`. `timer` is a
  // pending stagger-dial or re-dial timer id (null when none armed).
  const slots = Array.from({ length: flowCount }, () => ({
    worker: null,
    attempt: 0,
    timer: null,
  }));
  // Per-worker aliveness (a re-dial replaces slot.worker, so keying on the
  // worker keeps an OLD flow object's isAlive() honest after re-dial).
  const alive = new Map();
  const starvedCbs = [];
  let active = false;        // start() -> true, stop() -> false; hard kill-switch
  let allExhausted = false;  // every slot ran out of re-dials with none alive
  let waiter = null;         // pending { promise, resolve, reject } for awaitFlow

  const backoffFor = (attempt) => backoff[Math.min(attempt, backoff.length - 1)];

  function liveCount() {
    return slots.filter((s) => s.worker && alive.get(s.worker)).length;
  }

  // --- starvation waiter -----------------------------------------------------
  function ensureWaiter() {
    if (!waiter) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      waiter = { promise, resolve, reject };
    }
    return waiter;
  }
  function resolveWaiter() {
    if (waiter) { const w = waiter; waiter = null; w.resolve(); }
  }
  function rejectWaiter(err) {
    if (waiter) { const w = waiter; waiter = null; w.reject(err); }
  }
  // awaitFlow-compatible: resolves when the next flow comes up, rejects once
  // every slot is exhausted. Matches createSendPool's `awaitFlow()` contract.
  function awaitFlow() {
    if (allExhausted) return Promise.reject(new Error('all_slots_exhausted'));
    return ensureWaiter().promise;
  }

  // A slot is exhausted when it can never produce another dial: it has used up
  // its re-dial budget (attempt >= max) and its current worker is not alive.
  function slotExhausted(slot) {
    return slot.attempt >= maxRedialsPerSlot && !(slot.worker && alive.get(slot.worker));
  }
  function checkAllExhausted() {
    if (allExhausted) return;
    if (liveCount() === 0 && slots.every((s) => slotExhausted(s))) {
      allExhausted = true;
      rejectWaiter(new Error('all_slots_exhausted'));
    }
  }

  // --- dialing ---------------------------------------------------------------
  function makeFlow(worker) {
    return {
      sendBulk: (buf) => worker.channel.sendBulk(buf),
      isAlive: () => !!alive.get(worker),
    };
  }

  function dial(slotIndex) {
    if (!active) return;
    const slot = slots[slotIndex];
    slot.timer = null;
    const worker = createWorker(slotIndex);
    slot.worker = worker;
    alive.set(worker, false);
    worker.onSessionState((state) => handleState(slotIndex, worker, state));
    worker.startRendezvous(makeParams(slotIndex));
  }

  function handleState(slotIndex, worker, state) {
    if (!active) return;
    const slot = slots[slotIndex];
    // Ignore state from a stale worker a re-dial already replaced.
    if (slot.worker !== worker) return;

    if (state === 'connected') {
      alive.set(worker, true);
      if (slotIndex === 0 && onCtrlReplaced) onCtrlReplaced(worker);
      if (onFlowUp) onFlowUp(slotIndex, makeFlow(worker));
      resolveWaiter();
      return;
    }
    if (state === 'disconnected') {
      // Transient — the worker debounces an ICE-restart. Mark not-alive but do
      // NOT re-dial; a true death escalates to 'failed' (terminal) below.
      alive.set(worker, false);
      if (liveCount() === 0) fireStarved();
      return;
    }
    const terminal = state === 'failed' || state === 'closed'
      || (typeof state === 'string' && state.startsWith('error:'));
    if (terminal) {
      alive.set(worker, false);
      if (onFlowDown) onFlowDown(slotIndex);
      if (liveCount() === 0) fireStarved();
      scheduleRedial(slotIndex);
      return;
    }
    // Unknown/intermediate states (e.g. 'connecting') are ignored.
  }

  function scheduleRedial(slotIndex) {
    const slot = slots[slotIndex];
    if (!active || !isRunning() || slot.attempt >= maxRedialsPerSlot) {
      // No further dial for this slot — it may have just become exhausted.
      checkAllExhausted();
      return;
    }
    const delay = backoffFor(slot.attempt);
    slot.attempt += 1;
    slot.timer = setTimer(() => dial(slotIndex), delay);
  }

  function fireStarved() {
    starvedCbs.forEach((cb) => cb());
  }

  // --- public API ------------------------------------------------------------
  return {
    start() {
      if (active) return;
      active = true;
      // slot 0 immediately (t=0); the rest at staggerMs increments.
      dial(0);
      for (let i = 1; i < flowCount; i += 1) {
        slots[i].timer = setTimer(((idx) => () => dial(idx))(i), staggerMs * i);
      }
    },
    stop() {
      active = false;
      for (const slot of slots) {
        if (slot.timer != null) { clearTimer(slot.timer); slot.timer = null; }
        if (slot.worker) { try { slot.worker.close(); } catch { /* best-effort */ } }
      }
    },
    liveCount,
    onSlotStarved(cb) { if (typeof cb === 'function') starvedCbs.push(cb); },
    awaitFlow,
  };
}
