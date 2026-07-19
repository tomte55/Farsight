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
// single pending deferred that resolves on the NEXT onFlowUp and rejects only
// once a CONTINUOUS total outage (liveCount()===0 without interruption) has
// lasted `outageGiveupMs` — so the pool throws no_live_flows (→ last-resort
// whole-transfer resume) only when recovery has been impossible for a sustained
// window, NOT the instant every slot happens to be down. On a shared satellite/
// TURN path all N flows drop together (common-mode); a brief blip must ride out,
// so per-slot dead-ness alone must NEVER reject the waiter. onSlotStarved
// callbacks fire each time liveCount() falls to 0.
//
// Re-dial budget resets on connect: `maxRedialsPerSlot` bounds CONSECUTIVE
// establish failures since the slot last connected (a genuinely-broken slot),
// not lifetime drops — a slot reaching 'connected' resets its `attempt` to 0, so
// a flow that worked and then dropped starts its re-dial budget fresh.
//
// GENTLE re-dial (Task 3) — all N flows share one satellite/TURN path, so a blip
// drops them together (common-mode) and a naive supervisor re-dials all 8-16
// slots at once on a short backoff, and lingering dead workers hold TURN
// allocations: a live incident hit 755 concurrent coturn allocations (~flowCount×2
// expected), saturating the relay and causing MORE drops (a death spiral). Three
// bounds keep re-dialing gentle, all governing RE-dials (never the initial
// staggered dial):
//   3. CONCURRENCY CAP — at most `maxConcurrentDials` workers may be MID-DIAL
//      (created via createWorker, not yet 'connected' or terminal) at once. Excess
//      re-dials QUEUE and start as dial-slots free (a mid-dial worker connects or
//      goes terminal). Bounds the simultaneous TURN-allocation rate.
//   4. GROWN BACKOFF — the default tail reaches 15s so a chronically-failing slot
//      churns slowly, not every 4s.
//   5. TOTAL-OUTAGE PROBE MODE — when liveCount()===0 we do NOT fan out all slots;
//      only up to `maxConcurrentDials` PROBE slots dial (on the grown backoff) to
//      test the link, and the rest stay QUEUED until a probe reaches 'connected'
//      (link is back), then normal re-dialing of the rest resumes. Implemented as:
//      the cap bounds concurrent probes, and the queue drains ONLY while a flow is
//      live (drainQueue is a no-op during a total outage) — so a probe FAILURE
//      re-probes only itself and never releases a queued slot; a probe CONNECT does.

export function createFlowSupervisor({
  flowCount,
  createWorker,
  makeParams,
  onFlowUp,
  onFlowDown,
  onCtrlReplaced,
  staggerMs = 250,
  backoff = [500, 1000, 2000, 4000, 8000, 15000],
  maxRedialsPerSlot = 8,
  maxConcurrentDials = 4,
  outageGiveupMs = 180000,
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
    dialing: false, // true while this slot's CURRENT worker is mid-dial (created,
                    // not yet 'connected' or terminal) — it is then counted in
                    // inFlightDials and occupies one of the maxConcurrentDials
                    // dial slots. Cleared the moment it connects or goes terminal.
    dead: false, // set ONLY once this slot's re-dial budget is spent AND its
                 // final worker went terminal — see scheduleRedial. A slot with
                 // a pending final-attempt timer, or a final worker still
                 // connecting, is NOT dead (it may still recover the transfer).
  }));
  // Per-worker aliveness (a re-dial replaces slot.worker, so keying on the
  // worker keeps an OLD flow object's isAlive() honest after re-dial).
  const alive = new Map();
  const starvedCbs = [];
  let active = false;        // start() -> true, stop() -> false; hard kill-switch
  let allExhausted = false;  // continuous total outage reached outageGiveupMs — give up
  let outageTimer = null;    // armed while liveCount()===0; a connect cancels it
  let waiter = null;         // pending { promise, resolve, reject } for awaitFlow
  // Cumulative count of slots ACTUALLY re-dialed this transfer (a worker
  // created because a prior one went terminal — never the initial staggered
  // dial). Surfaced via redialCount() for UI health (Task 9); a `dial()` call
  // is a re-dial iff scheduleRedial already bumped slot.attempt past 0 before
  // arming the timer that leads here (see dial()'s check below).
  let redials = 0;
  // Concurrency-cap bookkeeping (Task 3). inFlightDials = number of slots whose
  // current worker is mid-dial (slot.dialing). dialQueue holds slotIndexes whose
  // RE-dial was deferred because the cap was full (or a total outage is being
  // probed); they start via drainQueue as dial-slots free AND a flow is live.
  let inFlightDials = 0;
  const dialQueue = [];

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
  // awaitFlow-compatible: resolves when the next flow comes up, rejects once a
  // continuous total outage has reached outageGiveupMs. Matches createSendPool's
  // `awaitFlow()` contract.
  function awaitFlow() {
    if (allExhausted) return Promise.reject(new Error('outage_giveup'));
    return ensureWaiter().promise;
  }

  // --- total-outage giveup ---------------------------------------------------
  // The waiter reject is governed by a CONTINUOUS total-outage timer, never by
  // per-slot dead-ness. On a shared satellite/TURN path all N flows drop at once
  // (common-mode), so every slot going dead is NOT proof the transfer can't
  // recover — a re-dial (or a slot still mid-connect) may bring one back. So:
  // while liveCount()===0, a single timer runs; only if it reaches
  // outageGiveupMs UNINTERRUPTED do we declare exhaustion and reject the waiter
  // (`outage_giveup` → last-resort whole-transfer resume). ANY slot reaching
  // 'connected' cancels the timer (see handleState), and it re-arms the next
  // time liveCount() falls to 0 — so a brief blip rides out for free.
  function armOutageTimer() {
    if (outageTimer != null || allExhausted) return;
    if (!active || !isRunning()) return;
    if (liveCount() !== 0) return;
    outageTimer = setTimer(onOutageGiveup, outageGiveupMs);
  }
  function cancelOutageTimer() {
    if (outageTimer != null) { clearTimer(outageTimer); outageTimer = null; }
  }
  function onOutageGiveup() {
    outageTimer = null;
    // Re-check: a connect may have restored a flow, or the transfer paused/
    // stopped, in the meantime — never reject while it can still recover.
    if (!active || !isRunning() || allExhausted) return;
    if (liveCount() !== 0) return;
    allExhausted = true;
    rejectWaiter(new Error('outage_giveup'));
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
    // slot.attempt is 0 only for the INITIAL dial (start()'s staggered loop);
    // scheduleRedial always increments it before arming the timer that calls
    // back in here, so attempt > 0 at this point means this dial is a re-dial.
    // The concurrency cap governs RE-dials ONLY — the initial staggered dial is
    // already spread by staggerMs and must always proceed. A re-dial that would
    // exceed maxConcurrentDials in-flight QUEUES instead; it starts later from
    // drainQueue when a dial-slot frees AND a flow is live (probe-mode gating).
    if (slot.attempt > 0 && inFlightDials >= maxConcurrentDials) {
      if (!dialQueue.includes(slotIndex)) dialQueue.push(slotIndex);
      return;
    }
    if (slot.attempt > 0) redials += 1;
    const worker = createWorker(slotIndex);
    slot.worker = worker;
    slot.dialing = true;
    inFlightDials += 1;
    alive.set(worker, false);
    worker.onSessionState((state) => handleState(slotIndex, worker, state));
    worker.startRendezvous(makeParams(slotIndex));
  }

  // A mid-dial worker just left mid-dial (connected or terminal): free its dial
  // slot so a queued re-dial can start.
  function releaseDialSlot(slot) {
    if (slot.dialing) { slot.dialing = false; inFlightDials -= 1; }
  }

  // Start queued re-dials as dial-slots free — but ONLY while a flow is live.
  // During a total outage (liveCount()===0) this is a no-op: the ≤ cap probe
  // slots keep re-dialing themselves on backoff, and the remaining slots stay
  // QUEUED until a probe reaches 'connected' (link is back), which resumes
  // draining. This is the total-outage PROBE mode — don't hammer a dead link
  // with all N slots.
  function drainQueue() {
    if (liveCount() === 0) return;
    while (dialQueue.length > 0 && inFlightDials < maxConcurrentDials) {
      dial(dialQueue.shift());
    }
  }

  function handleState(slotIndex, worker, state) {
    if (!active) return;
    const slot = slots[slotIndex];
    // Ignore state from a stale worker a re-dial already replaced.
    if (slot.worker !== worker) return;

    if (state === 'connected') {
      alive.set(worker, true);
      // This worker is no longer mid-dial — free its dial slot.
      releaseDialSlot(slot);
      // Re-dial budget resets on a successful connect: maxRedialsPerSlot now
      // counts CONSECUTIVE establish failures since this slot last connected,
      // not lifetime drops (a worked-then-dropped flow re-dials from backoff[0]).
      slot.attempt = 0;
      // A live flow ends the total outage — cancel any running outage timer.
      cancelOutageTimer();
      if (slotIndex === 0 && onCtrlReplaced) onCtrlReplaced(worker);
      if (onFlowUp) onFlowUp(slotIndex, makeFlow(worker));
      resolveWaiter();
      // A probe reached 'connected' (or a normal slot freed): the link is live,
      // so resume re-dialing any QUEUED slots (up to the cap).
      drainQueue();
      return;
    }
    if (state === 'disconnected') {
      // Transient — the worker debounces an ICE-restart. Mark not-alive but do
      // NOT re-dial; a true death escalates to 'failed' (terminal) below.
      alive.set(worker, false);
      if (liveCount() === 0) { fireStarved(); armOutageTimer(); }
      return;
    }
    const terminal = state === 'failed' || state === 'closed'
      || (typeof state === 'string' && state.startsWith('error:'));
    if (terminal) {
      alive.set(worker, false);
      // This worker is no longer mid-dial — free its dial slot before scheduling
      // the next re-dial (and before draining), so the freed slot is available.
      releaseDialSlot(slot);
      if (onFlowDown) onFlowDown(slotIndex);
      if (liveCount() === 0) { fireStarved(); armOutageTimer(); }
      scheduleRedial(slotIndex);
      // Release a queued re-dial only if a flow is still live — a no-op during a
      // total outage (probe mode keeps the rest queued until a probe connects).
      drainQueue();
      return;
    }
    // Unknown/intermediate states (e.g. 'connecting') are ignored.
  }

  function scheduleRedial(slotIndex) {
    const slot = slots[slotIndex];
    // A stopped/paused supervisor is NOT exhaustion — it must not reject the
    // waiter as `all_slots_exhausted`; it simply declines to re-dial for now.
    if (!active || !isRunning()) return;
    if (slot.attempt >= maxRedialsPerSlot) {
      // Budget spent and we reached here FROM the terminal handler, so the
      // current worker is terminal and no timer is pending: this slot has given
      // up re-dialing (a slot that never (re)connected within its budget — a
      // genuinely-broken slot). That is the only place `dead` is set. Note this
      // does NOT reject the waiter: the waiter reject is governed solely by the
      // total-outage timer (armOutageTimer), so a common-mode drop where every
      // slot goes dead still rides out until the outage window elapses, and any
      // slot that reconnects meanwhile clears it.
      slot.dead = true;
      return;
    }
    const delay = backoffFor(slot.attempt);
    slot.attempt += 1;
    slot.timer = setTimer(() => dial(slotIndex), delay);
  }

  function fireStarved() {
    // Guarded/best-effort: a throwing callback must not abort the terminal/
    // disconnected handler partway (mirrors the codebase's guarded-callback
    // pattern).
    starvedCbs.forEach((cb) => { try { cb(); } catch { /* best-effort */ } });
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
      // Nothing is connected yet — start the total-outage clock immediately, so
      // a start that NEVER brings a flow up also gives up after outageGiveupMs.
      armOutageTimer();
    },
    stop() {
      active = false;
      cancelOutageTimer();
      dialQueue.length = 0;
      inFlightDials = 0;
      for (const slot of slots) {
        if (slot.timer != null) { clearTimer(slot.timer); slot.timer = null; }
        slot.dialing = false;
        if (slot.worker) { try { slot.worker.close(); } catch { /* best-effort */ } }
      }
    },
    liveCount,
    redialCount: () => redials,
    onSlotStarved(cb) { if (typeof cb === 'function') starvedCbs.push(cb); },
    awaitFlow,
  };
}
