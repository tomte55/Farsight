// packages/shared/test/transfer-flow-supervisor.test.js
// Plan (multi-flow) Task 3: the flow supervisor keeps N flow slots filled —
// staggered initial dial + bounded-backoff re-dial of DEAD slots. Pure module:
// timers + worker creation are injected, so a fake clock (manual, delay-aware
// virtual-time queue) and fake workers (whose onSessionState we drive) exercise
// every guard directly. No electron/WebRTC/DOM/fs.
import { describe, it, expect, vi } from 'vitest';
import { createFlowSupervisor } from '../src/transfer-flow-supervisor.js';

// Delay-aware fake clock: records armed timers with their due virtual time and
// fires them (in due order) as `advance(ms)` crosses their deadline. Timers
// armed DURING a fire (re-dials) are honored on later advances.
function fakeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map(); // id -> { at, fn }
  return {
    now: () => now,
    setTimer: (fn, delay) => { const id = seq++; timers.set(id, { at: now + (delay || 0), fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance: (ms) => {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, t] = due[0];
        timers.delete(id);
        t.fn();
      }
    },
    pending: () => timers.size,
  };
}

// Fake worker matching the shape assembleSendFlows uses: single-owner
// onSessionState, a channel with sendBulk, startRendezvous + close spies, plus
// a test-only `emit(state)` to drive the session-state machine.
function makeWorkerFactory() {
  const workers = [];
  function createWorker(slotIndex) {
    let cb = null;
    const worker = {
      slotIndex,
      channel: { sendBulk: vi.fn(() => Promise.resolve()) },
      onSessionState: (fn) => { cb = fn; },
      startRendezvous: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
      emit: (state) => { if (cb) cb(state); },
    };
    workers.push(worker);
    return worker;
  }
  // Latest worker created for a given slotIndex (re-dials push a fresh one).
  createWorker.latestFor = (slotIndex) => [...workers].reverse().find((w) => w.slotIndex === slotIndex);
  createWorker.all = workers;
  return createWorker;
}

function baseArgs(overrides = {}) {
  const clock = fakeClock();
  const createWorker = makeWorkerFactory();
  const args = {
    flowCount: 4,
    createWorker,
    makeParams: (i) => ({ slot: i }),
    onFlowUp: vi.fn(),
    onFlowDown: vi.fn(),
    onCtrlReplaced: vi.fn(),
    staggerMs: 250,
    backoff: [500, 1000, 2000, 4000],
    maxRedialsPerSlot: 8,
    isRunning: () => true,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  };
  return { clock, createWorker, args };
}

describe('transfer-flow-supervisor', () => {
  it('staggers the initial dial: slot 0 at t=0, then 1/2/3 at 250/500/750', () => {
    const { clock, createWorker, args } = baseArgs();
    const sup = createFlowSupervisor(args);
    sup.start();

    // slot 0 dials immediately at t=0
    expect(createWorker.all.map((w) => w.slotIndex)).toEqual([0]);

    clock.advance(250);
    expect(createWorker.all.map((w) => w.slotIndex)).toEqual([0, 1]);
    clock.advance(250); // t=500
    expect(createWorker.all.map((w) => w.slotIndex)).toEqual([0, 1, 2]);
    clock.advance(250); // t=750
    expect(createWorker.all.map((w) => w.slotIndex)).toEqual([0, 1, 2, 3]);

    // each dialed worker had its rendezvous kicked off with its own params
    createWorker.all.forEach((w) => {
      expect(w.startRendezvous).toHaveBeenCalledWith({ slot: w.slotIndex });
    });
  });

  it('connected -> onFlowUp(slotIndex, flow); flow.isAlive() true and sendBulk delegates to the worker channel', () => {
    const { createWorker, args } = baseArgs({ flowCount: 1 });
    const sup = createFlowSupervisor(args);
    sup.start();
    createWorker.latestFor(0).emit('connected');

    expect(args.onFlowUp).toHaveBeenCalledTimes(1);
    const [slotIndex, flow] = args.onFlowUp.mock.calls[0];
    expect(slotIndex).toBe(0);
    expect(flow.isAlive()).toBe(true);
    const buf = new Uint8Array([1, 2, 3]);
    flow.sendBulk(buf);
    expect(createWorker.latestFor(0).channel.sendBulk).toHaveBeenCalledWith(buf);
    expect(sup.liveCount()).toBe(1);
  });

  it('terminal state -> onFlowDown then re-dials the SAME slot after backoff[attempt]', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500, 1000, 2000] });
    const sup = createFlowSupervisor(args);
    sup.start();
    const w0 = createWorker.latestFor(0);

    w0.emit('failed');
    expect(args.onFlowDown).toHaveBeenCalledWith(0);
    // no immediate re-dial — waits backoff[0]
    expect(createWorker.all.length).toBe(1);
    clock.advance(499);
    expect(createWorker.all.length).toBe(1);
    clock.advance(1); // t=500 -> backoff[0]
    expect(createWorker.all.length).toBe(2);
    expect(createWorker.latestFor(0)).not.toBe(w0); // fresh worker, SAME slotIndex 0

    // second terminal uses backoff[1] = 1000
    createWorker.latestFor(0).emit('error:ice');
    clock.advance(999);
    expect(createWorker.all.length).toBe(2);
    clock.advance(1); // t=1000 later
    expect(createWorker.all.length).toBe(3);

    // third terminal uses backoff[2] = 2000
    createWorker.latestFor(0).emit('closed');
    clock.advance(1999);
    expect(createWorker.all.length).toBe(3);
    clock.advance(1);
    expect(createWorker.all.length).toBe(4);
  });

  it('backoff last value repeats once attempt exceeds the array length', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500, 1000], maxRedialsPerSlot: 8 });
    const sup = createFlowSupervisor(args);
    sup.start();

    // attempt 0 -> 500, attempt 1 -> 1000, attempt 2 -> 1000 (last repeats), attempt 3 -> 1000
    const delays = [500, 1000, 1000, 1000];
    let expected = 1;
    for (const d of delays) {
      createWorker.latestFor(0).emit('failed');
      clock.advance(d - 1);
      expect(createWorker.all.length).toBe(expected);
      clock.advance(1);
      expected += 1;
      expect(createWorker.all.length).toBe(expected);
    }
  });

  it('disconnected is TRANSIENT: never re-dials (worker self-heals via ICE-restart)', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1 });
    const sup = createFlowSupervisor(args);
    sup.start();
    createWorker.latestFor(0).emit('connected');
    expect(sup.liveCount()).toBe(1);

    createWorker.latestFor(0).emit('disconnected');
    expect(sup.liveCount()).toBe(0); // marked not-alive...
    clock.advance(100000);
    expect(createWorker.all.length).toBe(1); // ...but NO re-dial scheduled
  });

  // Per-slot cap applies ONLY when a flow is LIVE (not a total outage): a slot
  // that cannot connect while OTHER flows are up IS individually broken, so it
  // goes dead after maxRedialsPerSlot. (During a total outage the probe slots
  // keep dialing for the full outage window — see the recovery test below.)
  it('caps re-dials at maxRedialsPerSlot when a flow is live: the failing slot stops re-dialing afterward', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 2, maxConcurrentDials: 2, backoff: [500], maxRedialsPerSlot: 3 });
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(250); // slot 1 dialed
    createWorker.latestFor(0).emit('connected'); // slot 0 ALIVE -> NOT a total outage
    expect(sup.liveCount()).toBe(1);

    // 3 allowed re-dials of slot 1 produce fresh slot-1 workers.
    for (let i = 0; i < 3; i += 1) {
      createWorker.latestFor(1).emit('failed');
      clock.advance(500);
    }
    expect(createWorker.all.filter((w) => w.slotIndex === 1).length).toBe(4); // initial + 3

    // the 4th terminal is past the cap AND a flow is live -> slot goes dead, no further re-dial
    createWorker.latestFor(1).emit('failed');
    clock.advance(100000);
    expect(createWorker.all.filter((w) => w.slotIndex === 1).length).toBe(4);
  });

  it('resets the re-dial budget on connect: a slot that connected then dropped re-dials with attempt===0 (backoff[0])', () => {
    // A slot accumulates attempts, CONNECTS (works), then drops. Its next
    // re-dial must use backoff[0] again — connect resets `attempt` to 0, so
    // maxRedialsPerSlot counts consecutive failures SINCE the last connect, not
    // lifetime drops. (Mutation: drop the reset -> the fresh drop uses the
    // accumulated backoff[2]=2000 and no worker appears at t+500 -> this fails.)
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500, 1000, 2000] });
    const sup = createFlowSupervisor(args);
    sup.start();

    // Accumulate attempts WITHOUT connecting: attempt 0 -> backoff[0]=500,
    // attempt 1 -> backoff[1]=1000.
    createWorker.latestFor(0).emit('failed');
    clock.advance(500);                       // worker #2 (attempt now 1)
    createWorker.latestFor(0).emit('failed');
    clock.advance(1000);                      // worker #3 (attempt now 2)
    expect(createWorker.all.length).toBe(3);

    // Now the slot CONNECTS -> attempt resets to 0.
    createWorker.latestFor(0).emit('connected');

    // It later drops. Its next re-dial must use backoff[0]=500 (NOT backoff[2]=2000).
    createWorker.latestFor(0).emit('failed');
    clock.advance(499);
    expect(createWorker.all.length).toBe(3);  // not yet
    clock.advance(1);                         // t+500 -> re-dial fires -> worker #4
    expect(createWorker.all.length).toBe(4);
  });

  it('isRunning() === false gates re-dial: a terminal state does not re-dial', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, isRunning: () => false });
    const sup = createFlowSupervisor(args);
    sup.start();
    createWorker.latestFor(0).emit('failed');
    clock.advance(100000);
    expect(createWorker.all.length).toBe(1); // never re-dialed
  });

  it('slot 0 is ctrl: onCtrlReplaced fires with the connecting slot-0 worker (initial AND re-dial)', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500] });
    const sup = createFlowSupervisor(args);
    sup.start();
    const w0 = createWorker.latestFor(0);
    w0.emit('connected');
    expect(args.onCtrlReplaced).toHaveBeenCalledTimes(1);
    expect(args.onCtrlReplaced).toHaveBeenLastCalledWith(w0);

    // kill it, re-dial, connect the fresh slot-0 worker -> onCtrlReplaced again
    w0.emit('failed');
    clock.advance(500);
    const w0b = createWorker.latestFor(0);
    expect(w0b).not.toBe(w0);
    w0b.emit('connected');
    expect(args.onCtrlReplaced).toHaveBeenCalledTimes(2);
    expect(args.onCtrlReplaced).toHaveBeenLastCalledWith(w0b);
  });

  it('non-ctrl slots never trigger onCtrlReplaced', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 2 });
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(250); // dial slot 1
    createWorker.latestFor(1).emit('connected');
    expect(args.onCtrlReplaced).not.toHaveBeenCalled();
  });

  it('starvation: onSlotStarved fires when liveCount() reaches 0; awaitFlow resolves on the next connect', async () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500] });
    const sup = createFlowSupervisor(args);
    const starved = vi.fn();
    sup.onSlotStarved(starved);
    sup.start();

    const w0 = createWorker.latestFor(0);
    w0.emit('connected');
    expect(sup.liveCount()).toBe(1);
    expect(starved).not.toHaveBeenCalled();

    w0.emit('failed'); // liveCount -> 0
    expect(starved).toHaveBeenCalledTimes(1);

    const p = sup.awaitFlow();
    let settled = false;
    p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting

    clock.advance(500); // re-dial
    createWorker.latestFor(0).emit('connected');
    await expect(p).resolves.toBeUndefined(); // waiter resolved by the new flow
  });

  it('short total outage (liveCount()===0 for < outageGiveupMs) does NOT reject the waiter; a connect resets the outage timer', async () => {
    // The waiter reject is governed by a CONTINUOUS total-outage timer, not by
    // per-slot dead-ness. While liveCount()===0 for less than outageGiveupMs the
    // waiter must stay pending — a brief common-mode blip must not tear the
    // transfer down. A slot reaching 'connected' cancels/resets the timer.
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500], outageGiveupMs: 180000 });
    const sup = createFlowSupervisor(args);
    sup.start();

    const p = sup.awaitFlow();
    let rejected = false;
    p.catch(() => { rejected = true; });

    // liveCount()===0 (nothing connected yet) for just under the outage window.
    clock.advance(179000);
    await Promise.resolve();
    expect(rejected).toBe(false);

    // Connect -> resolves the waiter AND cancels the outage timer.
    createWorker.latestFor(0).emit('connected');
    await expect(p).resolves.toBeUndefined();

    // Drop again: a FRESH outage timer starts now (t=179000). Advancing another
    // ~179000 (total wall-clock ~358000, but only 179000 since the reset) must
    // NOT reject — proving the timer was reset by the connect, not accumulated.
    createWorker.latestFor(0).emit('failed');
    const p2 = sup.awaitFlow();
    let rejected2 = false;
    p2.catch(() => { rejected2 = true; });
    clock.advance(179000);
    await Promise.resolve();
    expect(rejected2).toBe(false);
  });

  it('total outage for >= outageGiveupMs rejects the waiter with outage_giveup (pool then does last-resort resume)', async () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500], outageGiveupMs: 180000 });
    const sup = createFlowSupervisor(args);
    sup.start();

    const p = sup.awaitFlow();
    // Nothing ever connects: liveCount()===0 continuously. At outageGiveupMs the
    // outage timer fires -> allExhausted -> waiter rejects.
    clock.advance(180000);

    await expect(p).rejects.toThrow('outage_giveup');
    // a fresh awaitFlow after outage giveup rejects immediately too
    await expect(sup.awaitFlow()).rejects.toThrow('outage_giveup');
  });

  // CRITICAL regression: the waiter must NOT reject while ANY slot is still
  // mid-recovery. With flowCount>=2, one slot can fully exhaust and go terminal
  // while ANOTHER slot's final-attempt re-dial timer is still pending (or its
  // final worker is still connecting) — that other flow may yet carry the whole
  // transfer, so `all_slots_exhausted` fired here would abort a recoverable
  // transfer (the exact Starlink scenario). Timeline (flowCount=2, max=1,
  // backoff=[500], stagger=250): slot 0's FINAL worker fails at t=500 while
  // slot 1's single allowed re-dial timer is still pending (fires t=750).
  it('does not reject the waiter while another slot is still mid-recovery; resolves when it connects', async () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 2, backoff: [500], maxRedialsPerSlot: 1 });
    const sup = createFlowSupervisor(args);
    sup.start();

    const p = sup.awaitFlow();
    let rejected = false;
    let resolved = false;
    p.then(() => { resolved = true; }, () => { rejected = true; });

    // t=0: slot 0 dialed. Fail it -> schedules its ONE allowed re-dial at t=500.
    createWorker.latestFor(0).emit('failed');
    clock.advance(250); // t=250: slot 1's staggered initial dial fires
    // Fail slot 1's initial worker -> schedules its ONE allowed re-dial at t=750.
    createWorker.latestFor(1).emit('failed');

    clock.advance(250); // t=500: slot 0's FINAL re-dial fires
    createWorker.latestFor(0).emit('failed'); // slot 0 now permanently dead...
    await Promise.resolve();
    // ...but slot 1's final re-dial timer is still pending — MUST NOT reject.
    expect(rejected).toBe(false);
    expect(resolved).toBe(false);

    clock.advance(250); // t=750: slot 1's FINAL re-dial fires
    createWorker.latestFor(1).emit('connected'); // the flow that carries the transfer
    await expect(p).resolves.toBeUndefined();
    expect(sup.liveCount()).toBe(1);
  });

  it('every slot dead (never connected) does NOT reject on its own — only the total-outage timer rejects, with outage_giveup', async () => {
    // Per-slot dead-ness no longer governs the waiter reject. Even after EVERY
    // slot has spent its re-dial budget and gone permanently dead, the waiter
    // stays pending until the continuous total-outage timer reaches
    // outageGiveupMs — THEN it rejects `outage_giveup`.
    const { clock, createWorker, args } = baseArgs({ flowCount: 2, backoff: [500], maxRedialsPerSlot: 1, outageGiveupMs: 180000 });
    const sup = createFlowSupervisor(args);
    sup.start();

    const p = sup.awaitFlow();
    let rejected = false;
    p.catch(() => { rejected = true; });

    createWorker.latestFor(0).emit('failed');    // slot 0 -> re-dial @500
    clock.advance(250);                          // slot 1 dialed
    createWorker.latestFor(1).emit('failed');    // slot 1 -> re-dial @750
    clock.advance(250);                          // t=500: slot 0 final worker
    createWorker.latestFor(0).emit('failed');    // slot 0 permanently dead
    clock.advance(250);                          // t=750: slot 1 final worker
    createWorker.latestFor(1).emit('failed');    // slot 1 permanently dead too -> ALL dead

    await Promise.resolve();
    expect(rejected).toBe(false);                // all dead, but outage timer not elapsed -> NO reject

    clock.advance(180000);                       // outage timer (armed at t=0) elapses
    await expect(p).rejects.toThrow('outage_giveup');
  });

  // Task 9: cumulative re-dial count, for UI health surfacing. Must count only
  // ACTUAL re-dials (a worker created because a prior one went terminal) — the
  // initial staggered dial of every slot in start() must NOT count, even though
  // it also calls dial().
  it('redialCount(): 0 after the initial staggered dial of every slot; increments once per ACTUAL re-dial, across multiple slots', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 2, backoff: [500] });
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(250); // both slots dialed (initial dial only)
    expect(sup.redialCount()).toBe(0);

    createWorker.latestFor(0).emit('failed'); // schedules slot 0's re-dial @+500
    clock.advance(500);
    expect(sup.redialCount()).toBe(1); // one real re-dial happened

    createWorker.latestFor(1).emit('closed'); // schedules slot 1's re-dial @+500
    clock.advance(500);
    expect(sup.redialCount()).toBe(2); // a second real re-dial, different slot

    // A transient 'disconnected' never re-dials — must not bump the counter.
    createWorker.latestFor(0).emit('connected');
    createWorker.latestFor(0).emit('disconnected');
    clock.advance(100000);
    expect(sup.redialCount()).toBe(2); // unchanged
  });

  // Task 3: gentle re-dial — a concurrency cap on in-flight dials so a
  // common-mode drop can't re-dial all N slots at once (the "755 TURN
  // allocations" storm). At most maxConcurrentDials workers may be MID-DIAL
  // (created, not yet connected-or-terminal) at once; excess RE-dials queue and
  // start as dial-slots free. The INITIAL staggered dial is NOT gated.
  it('re-dial concurrency cap: at most maxConcurrentDials workers are mid-dial at once; the rest dial as earlier ones settle', () => {
    const { clock, createWorker, args } = baseArgs({
      flowCount: 7, maxConcurrentDials: 2, backoff: [500], maxRedialsPerSlot: 20,
    });
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(1500); // dial all 7 (stagger 250 each: slot 6 at t=1500)
    expect(createWorker.all.length).toBe(7);

    // Keep slot 0 alive so we're NEVER in total outage (probe mode stays off) —
    // this isolates the plain re-dial cap.
    createWorker.latestFor(0).emit('connected');
    expect(sup.liveCount()).toBe(1);

    // Fail slots 1..6 all at once -> each schedules a re-dial at +500.
    for (let i = 1; i <= 6; i += 1) createWorker.latestFor(i).emit('failed');

    const before = createWorker.all.length; // 7
    clock.advance(500); // all six re-dial timers fire together...
    // ...but only cap(2) may be mid-dial at once -> only 2 new workers created.
    expect(createWorker.all.length - before).toBe(2);

    const redials = createWorker.all.slice(before);
    // Settle one mid-dial worker by CONNECTING it -> frees a dial slot; a live
    // flow exists so a queued slot dials.
    redials[0].emit('connected');
    expect(createWorker.all.length - before).toBe(3);
    // Settle the other by a TERMINAL state -> frees a dial slot -> next queued dials.
    redials[1].emit('failed');
    expect(createWorker.all.length - before).toBe(4);
    // At no point were more than cap new workers mid-dial simultaneously.
  });

  // Task 3: total-outage PROBE mode. When liveCount()===0, do NOT fan out all
  // slots — dial at most maxConcurrentDials PROBE slots to test the link and
  // keep the rest QUEUED until a probe reaches 'connected', THEN resume normal
  // re-dialing of the rest. Bounds TURN allocations against a dead link.
  it('total-outage probe mode: only maxConcurrentDials probes dial; the rest fan out ONLY after a probe connects', () => {
    const { clock, createWorker, args } = baseArgs({
      flowCount: 6, maxConcurrentDials: 2, backoff: [500], maxRedialsPerSlot: 20, outageGiveupMs: 1e9,
    });
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(1250); // dial all 6 (slot 5 at t=1250)
    // Connect all, then drop ALL at once = common-mode TOTAL outage.
    for (let i = 0; i < 6; i += 1) createWorker.latestFor(i).emit('connected');
    expect(sup.liveCount()).toBe(6);
    for (let i = 0; i < 6; i += 1) createWorker.latestFor(i).emit('failed');
    expect(sup.liveCount()).toBe(0); // TOTAL OUTAGE

    const before = createWorker.all.length; // 6
    const newSlots = () => new Set(createWorker.all.slice(before).map((w) => w.slotIndex));

    clock.advance(500); // all six re-dial timers fire together...
    // ...probe mode: only cap(2) distinct probe slots dial; the other 4 stay QUEUED.
    expect(newSlots().size).toBe(2);
    const probeSlots = [...newSlots()];

    // A probe FAILS -> must NOT release a queued slot (still a total outage);
    // it re-dials ITSELF on backoff.
    createWorker.latestFor(probeSlots[0]).emit('failed');
    clock.advance(500); // the failed probe's OWN re-dial fires (a re-probe)
    // Still only the same 2 slots have ever dialed — the 4 queued did NOT fan out.
    expect(newSlots().size).toBe(2);

    // NOW a probe CONNECTS -> the link is back -> the remaining slots fan out
    // (gated by the cap, then draining as each settles).
    createWorker.latestFor(probeSlots[0]).emit('connected');
    expect(sup.liveCount()).toBe(1);
    expect(newSlots().size).toBe(3); // one queued slot released immediately (up to cap)
    // Drive the rest to connect; the queue drains fully -> all 6 slots dial.
    for (let guard = 0; guard < 20 && newSlots().size < 6; guard += 1) {
      for (const w of [...createWorker.all]) {
        if (sup.liveCount() > 0 && newSlots().size < 6) w.emit('connected');
      }
    }
    expect(newSlots().size).toBe(6);
  });

  // Task 3 (review gap): during a TOTAL outage the probe slots must keep dialing
  // for the FULL outage window — a per-slot budget must NOT kill them, because
  // every slot is failing for one COMMON reason (the shared link is down). A
  // common-mode Starlink outage routinely lasts 60-180s; if the probes died at
  // ~60s (grown-backoff budget spent) an outage that recovers in the 60-180s
  // window could only end via outage_giveup -> heavyweight whole-transfer resume.
  it('total outage that recovers within outageGiveupMs: probes keep dialing PAST maxRedialsPerSlot and reconnect when the link returns', async () => {
    const { clock, createWorker, args } = baseArgs({
      flowCount: 2, maxConcurrentDials: 2, maxRedialsPerSlot: 8, outageGiveupMs: 180000,
    });
    delete args.backoff; // module DEFAULT grown backoff (500..15000)
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(250); // slot 1's staggered initial dial (stays parked mid-dial)

    const p = sup.awaitFlow();
    let rejected = false;
    p.catch(() => { rejected = true; });

    // Nothing connects -> total outage from t=0. Drive slot 0 to keep FAILING,
    // advancing 15000 (>= any backoff step) per round for 10 rounds -> t=150000:
    // WELL past maxRedialsPerSlot(8) and the ~60s point where the OLD per-slot
    // cap marked the slot dead, yet still under outageGiveupMs(180000).
    for (let i = 0; i < 10; i += 1) {
      createWorker.latestFor(0).emit('failed');
      clock.advance(15000);
    }
    await Promise.resolve();
    expect(rejected).toBe(false);                 // outage timer (180s) not reached
    expect(clock.now()).toBe(150250);
    // Probe kept re-dialing past the cap: initial + 10 re-dials = 11 slot-0 workers.
    // (MUTATION: re-apply the per-slot dead cap during liveCount()===0 -> the slot
    // dies at round 8 -> this count is < 11 -> this assertion fails.)
    expect(createWorker.all.filter((w) => w.slotIndex === 0).length).toBe(11);

    // The link returns: the still-dialing probe connects -> recovery, waiter resolves.
    createWorker.latestFor(0).emit('connected');
    await expect(p).resolves.toBeUndefined();
    expect(sup.liveCount()).toBe(1);
    expect(rejected).toBe(false);
  });

  // The fix must NOT defeat giveup: a genuine total outage that never recovers
  // still rejects with outage_giveup at outageGiveupMs, even though the probes
  // keep dialing the whole time.
  it('genuine total outage that never recovers still gives up at outageGiveupMs (probes keep dialing but never connect)', async () => {
    const { clock, createWorker, args } = baseArgs({
      flowCount: 2, maxConcurrentDials: 2, maxRedialsPerSlot: 8, outageGiveupMs: 180000,
    });
    delete args.backoff;
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(250);

    const p = sup.awaitFlow();
    // Probes cycle past the per-slot cap (no connect ever)...
    for (let i = 0; i < 8; i += 1) {
      createWorker.latestFor(0).emit('failed');
      clock.advance(15000);
    }
    // ...then let the total-outage timer (armed at t=0) reach outageGiveupMs.
    clock.advance(180000 - clock.now());
    await expect(p).rejects.toThrow('outage_giveup');
  });

  // Task 3: the DEFAULT backoff grows to a longer tail so a slot that keeps
  // failing churns slowly (every 15s), not every 4s.
  it('default backoff grows to the [500,1000,2000,4000,8000,15000] tail (last value repeats)', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, maxRedialsPerSlot: 10, outageGiveupMs: 1e9 });
    delete args.backoff; // use the module DEFAULT
    const sup = createFlowSupervisor(args);
    sup.start();

    const delays = [500, 1000, 2000, 4000, 8000, 15000, 15000];
    let expected = 1;
    for (const d of delays) {
      createWorker.latestFor(0).emit('failed');
      clock.advance(d - 1);
      expect(createWorker.all.length).toBe(expected); // not yet
      clock.advance(1);
      expected += 1;
      expect(createWorker.all.length).toBe(expected); // re-dial fired at exactly d
    }
  });

  // Task 4: a slot going terminal must have its OLD (dead) worker close()d
  // PROMPTLY — before/when the re-dial's backoff timer even fires — so its
  // RTCPeerConnection tears down and coturn frees the relay allocation right
  // away, instead of lingering until whole-transfer teardown (a live incident
  // let dead workers accumulate to 755 concurrent TURN allocations).
  it('closes the OLD worker promptly on terminal state, before the fresh re-dialed worker exists', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500] });
    const sup = createFlowSupervisor(args);
    sup.start();
    const w0 = createWorker.latestFor(0);

    w0.emit('failed');
    // Closed PROMPTLY -- immediately on terminal, well before the backoff
    // timer that re-dials this slot fires.
    expect(w0.close).toHaveBeenCalledTimes(1);

    clock.advance(500); // re-dial fires -> a fresh worker for the same slot
    const w0b = createWorker.latestFor(0);
    expect(w0b).not.toBe(w0);
    expect(w0b.close).not.toHaveBeenCalled(); // only the OLD worker was closed

    // stop() afterward must not double-close the already-closed old worker.
    sup.stop();
    expect(w0.close).toHaveBeenCalledTimes(1);
  });

  it('disconnected (transient) never closes the worker — it may ICE-restart and recover', () => {
    const { createWorker, args } = baseArgs({ flowCount: 1 });
    const sup = createFlowSupervisor(args);
    sup.start();
    const w0 = createWorker.latestFor(0);
    w0.emit('connected');
    w0.emit('disconnected');
    expect(w0.close).not.toHaveBeenCalled();
  });

  it('exactly-once close guard: multiple terminal-ish emits from the same dead worker close it only once', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500] });
    const sup = createFlowSupervisor(args);
    sup.start();
    const w0 = createWorker.latestFor(0);
    w0.emit('failed');
    w0.emit('closed'); // same stale worker, a second terminal-ish state before re-dial fires
    expect(w0.close).toHaveBeenCalledTimes(1);

    // Review follow-up: a double-terminal on the SAME still-current worker
    // must NOT stack two re-dial timers for the slot — scheduleRedial ran
    // twice (failed, then closed), and without clearing the prior timer
    // that would arm TWO timers that both fire, calling dial(slotIndex)
    // twice: two fresh workers, the first immediately orphaned when the
    // second overwrites slot.worker (never closed — its terminal events are
    // staleness-guarded away and stop() only sees the CURRENT slot.worker —
    // and its inFlightDials increment never released). Advance past the
    // single backoff and confirm EXACTLY ONE fresh worker exists for this
    // slot, with nothing orphaned/un-closed left behind.
    clock.advance(500);
    const slot0Workers = createWorker.all.filter((w) => w.slotIndex === 0);
    expect(slot0Workers.length).toBe(2); // initial w0 + exactly one re-dial
    const w0b = slot0Workers[1];
    expect(w0b).not.toBe(w0);
    expect(w0b.close).not.toHaveBeenCalled(); // the fresh worker is untouched
  });

  it('stop(): cancels pending re-dial timers and closes live workers; no re-dials afterward', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 2, backoff: [500] });
    const sup = createFlowSupervisor(args);
    sup.start();
    clock.advance(250); // both slots dialed
    const w0 = createWorker.latestFor(0);
    const w1 = createWorker.latestFor(1);
    w0.emit('connected');
    w1.emit('connected');

    // arm a pending re-dial on slot 1
    w1.emit('failed');
    expect(clock.pending()).toBeGreaterThan(0);

    sup.stop();
    expect(clock.pending()).toBe(0);      // all pending timers cancelled
    expect(w0.close).toHaveBeenCalled();  // live workers closed

    // after stop, the previously-armed re-dial does NOT fire
    const countAtStop = createWorker.all.length;
    clock.advance(100000);
    expect(createWorker.all.length).toBe(countAtStop);
  });
});
