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

  it('caps re-dials at maxRedialsPerSlot: the slot stops re-dialing afterward', () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500], maxRedialsPerSlot: 3 });
    const sup = createFlowSupervisor(args);
    sup.start();

    // 3 allowed re-dials produce workers #2, #3, #4 (initial is #1)
    for (let i = 0; i < 3; i += 1) {
      createWorker.latestFor(0).emit('failed');
      clock.advance(500);
    }
    expect(createWorker.all.length).toBe(4);

    // the 4th terminal is past the cap -> no further re-dial
    createWorker.latestFor(0).emit('failed');
    clock.advance(100000);
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

  it('awaitFlow rejects once every slot has exhausted maxRedialsPerSlot (pool then throws no_live_flows)', async () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 1, backoff: [500], maxRedialsPerSlot: 2 });
    const sup = createFlowSupervisor(args);
    sup.start();

    const p = sup.awaitFlow();
    // exhaust: initial + 2 re-dials, all terminal
    createWorker.latestFor(0).emit('failed');
    clock.advance(500);
    createWorker.latestFor(0).emit('failed');
    clock.advance(500);
    createWorker.latestFor(0).emit('failed'); // now attempt == max -> no re-dial -> exhausted

    await expect(p).rejects.toThrow();
    // a fresh awaitFlow after full exhaustion rejects immediately too
    await expect(sup.awaitFlow()).rejects.toThrow();
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

  it('rejects all_slots_exhausted only once EVERY slot is permanently dead (multi-slot)', async () => {
    const { clock, createWorker, args } = baseArgs({ flowCount: 2, backoff: [500], maxRedialsPerSlot: 1 });
    const sup = createFlowSupervisor(args);
    sup.start();

    const p = sup.awaitFlow();
    createWorker.latestFor(0).emit('failed');    // slot 0 -> re-dial @500
    clock.advance(250);                          // slot 1 dialed
    createWorker.latestFor(1).emit('failed');    // slot 1 -> re-dial @750

    clock.advance(250);                          // t=500: slot 0 final worker
    createWorker.latestFor(0).emit('failed');    // slot 0 dead; slot 1 still pending -> no reject yet
    let rejectedEarly = false;
    p.catch(() => { rejectedEarly = true; });
    await Promise.resolve();
    expect(rejectedEarly).toBe(false);

    clock.advance(250);                          // t=750: slot 1 final worker
    createWorker.latestFor(1).emit('failed');    // slot 1 now dead too -> ALL dead
    await expect(p).rejects.toThrow('all_slots_exhausted');
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
