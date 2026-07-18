// packages/controller/test/transfer-channel-assembly.test.js
// Resilient multi-flow, Task 7 (Electron wire-up): the supervisor-backed
// assembleSendFlows and the receive-side rolling-join dispatch. These run as
// REAL executable tests against an INJECTED fake supervisor / fake workers /
// fake receiver sink (no electron/BrowserWindow), unlike main.js itself which
// imports 'electron' at module scope and can only be verified via the text-based
// wiring guards at the bottom (same convention as openchannel-multiflow.test.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, test, expect, vi } from 'vitest';
import { assembleSendFlows, dispatchReceiveFlowJoin } from '../src/transfer-channel-assembly.js';
import { createTransferChannel } from '@farsight/shared/transfer-channel';
import { createSendPool } from '@farsight/shared/transfer-send-pool';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');

// A fake transfer-worker: same shape as createTransferWorker() (channel/
// onSessionState/startRendezvous/close), with a synchronously-driveable
// session-state slot (single-owner, exactly like the real one).
function fakeWorker() {
  let stateCb = null;
  return {
    channel: { sendCtrl: vi.fn(), onCtrl: vi.fn(), sendBulk: vi.fn(), onBulk: vi.fn(), fail: vi.fn() },
    onSessionState: vi.fn((cb) => { stateCb = cb; }),
    startRendezvous: vi.fn(),
    close: vi.fn(async () => {}),
    __emit: (s) => stateCb && stateCb(s),
  };
}

// A fake createFlowSupervisor: captures the config so the test can drive the
// onFlowUp/onFlowDown/onCtrlReplaced callbacks, and mimics the real one's
// synchronous slot-0 dial on start() (so `ctrl` is captured and the worker set
// is populated). stop()/awaitFlow() are spies.
function fakeSupervisorFactory() {
  let cfg = null;
  const stop = vi.fn();
  const awaitFlow = vi.fn(() => new Promise(() => {})); // never resolves
  const redialCount = vi.fn(() => 0);
  const factory = (config) => {
    cfg = config;
    return {
      start: () => { for (let i = 0; i < config.flowCount; i += 1) config.createWorker(i); },
      stop,
      liveCount: () => 0,
      onSlotStarved: vi.fn(),
      awaitFlow,
      redialCount,
    };
  };
  factory.cfg = () => cfg;
  factory.stop = stop;
  factory.awaitFlow = awaitFlow;
  factory.redialCount = redialCount;
  return factory;
}

function build({ flowCount = 3 } = {}) {
  const workers = [];
  const sup = fakeSupervisorFactory();
  const bundle = assembleSendFlows({
    flowCount,
    createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
    makeParams: (flowIndex) => ({ flowIndex }),
    createSupervisor: sup,
  });
  return { workers, sup, bundle, cfg: sup.cfg() };
}

describe('assembleSendFlows (supervisor-backed)', () => {
  test('constructs the supervisor with flowCount/createWorker/makeParams and starts it', () => {
    const { cfg, workers } = build({ flowCount: 3 });
    expect(cfg.flowCount).toBe(3);
    // start() (mimicking the real staggered dial) created slot 0's worker at least.
    expect(workers.length).toBeGreaterThanOrEqual(1);
    expect(typeof cfg.createWorker).toBe('function');
    expect(typeof cfg.makeParams).toBe('function');
  });

  test('flows starts EMPTY and is the LIVE array the supervisor mutates via onFlowUp', () => {
    const { bundle, cfg } = build();
    expect(bundle.flows.length).toBe(0);
    const flow2 = { sendBulk: vi.fn(), isAlive: () => true };
    cfg.onFlowUp(2, flow2);
    expect(bundle.flows.length).toBe(1);
    expect(bundle.flows[0].isAlive()).toBe(true);
    const buf = new ArrayBuffer(4);
    bundle.flows[0].sendBulk(buf);
    expect(flow2.sendBulk).toHaveBeenCalledWith(buf);
  });

  test('onFlowDown retires the slot flow (isAlive→false) AND fails its channel (C1: reject in-flight sendBulk)', () => {
    const { bundle, cfg, workers } = build({ flowCount: 3 });
    const flow1 = { sendBulk: vi.fn(), isAlive: () => true };
    cfg.onFlowUp(1, flow1);
    const entry = bundle.flows[bundle.flows.length - 1];
    expect(entry.isAlive()).toBe(true);
    cfg.onFlowDown(1);
    expect(entry.isAlive()).toBe(false);
    // slot 1's worker channel is failed so any parked sendBulk rejects instead of
    // hanging the pool's Promise.race(inflight) forever.
    expect(workers[1].channel.fail).toHaveBeenCalled();
  });

  test('ctrl is slot-0 worker\'s channel (captured on the synchronous start() dial)', () => {
    const { bundle, workers } = build();
    expect(bundle.ctrl).toBe(workers[0].channel);
  });

  test('slot-0 onCtrlReplaced is delivered to a registered callback (transfer-service wires it to sender.setCtrl)', () => {
    const { bundle, cfg } = build();
    const setCtrl = vi.fn();
    bundle.onCtrlReplaced((ch) => setCtrl(ch));
    const redialed = fakeWorker();
    cfg.onCtrlReplaced(redialed);
    expect(setCtrl).toHaveBeenCalledWith(redialed.channel);
  });

  test('an onCtrlReplaced that fires BEFORE registration is buffered and replayed on register', () => {
    const { bundle, cfg } = build();
    const redialed = fakeWorker();
    cfg.onCtrlReplaced(redialed); // fires early
    const setCtrl = vi.fn();
    bundle.onCtrlReplaced((ch) => setCtrl(ch));
    expect(setCtrl).toHaveBeenCalledWith(redialed.channel);
  });

  // Minor #3: the supervisor fires onCtrlReplaced on the INITIAL slot-0 connect
  // too, but the sender is already seeded with that channel via get ctrl() — so
  // forwarding it would re-send the OFFER and append a duplicate onCtrl listener.
  // Skip it; forward only a genuine re-dial (a DISTINCT channel object).
  test('the INITIAL slot-0 connect does NOT re-fire setCtrl (only a re-dial swaps)', () => {
    const { bundle, cfg, workers } = build();
    const setCtrl = vi.fn();
    bundle.onCtrlReplaced((ch) => setCtrl(ch));
    // Initial connect: same channel the sender already holds (bundle.ctrl).
    cfg.onCtrlReplaced(workers[0]);
    expect(setCtrl).not.toHaveBeenCalled();
    // A genuine re-dial (distinct channel) DOES swap.
    const redial = fakeWorker();
    cfg.onCtrlReplaced(redial);
    expect(setCtrl).toHaveBeenCalledTimes(1);
    expect(setCtrl).toHaveBeenCalledWith(redial.channel);
  });

  // Final-review #1: onFlowUp re-fires on EVERY 'connected' (including a
  // transient disconnected->connected blip / ICE-restart, which is NOT a re-dial
  // and NOT bounded by maxRedialsPerSlot). Appending a wrapper each time grew
  // `flows` unboundedly and let aliveCount()/flowsLive over-report past
  // flowsTotal. The fix keeps EXACTLY ONE wrapper per slotIndex.
  describe('Final-review #1: one wrapper per slot (flowsLive can\'t over-report)', () => {
    // Fake supervisor per-worker flow: isAlive() is controllable so the test can
    // mirror the real supervisor marking a worker not-alive on 'disconnected'.
    const flow = (aliveRef) => ({ sendBulk: vi.fn(), isAlive: () => aliveRef.v });

    test('a slot that reconnects REPLACES (not appends) its wrapper — flows.length bounded by slot count, not reconnect count', () => {
      const { bundle, cfg } = build({ flowCount: 2 });
      const a0 = { v: true }, b0 = { v: true };
      // Slot 0 connects, blips, reconnects many times; slot 1 connects once.
      cfg.onFlowUp(0, flow(a0));
      cfg.onFlowUp(1, flow(b0));
      for (let i = 0; i < 20; i += 1) cfg.onFlowUp(0, flow({ v: true })); // 20 reconnect blips
      // Never more than one entry per slot: 2 slots -> at most 2 wrappers.
      expect(bundle.flows.length).toBe(2);
    });

    test('aliveCount()/flowsLive NEVER exceeds flowsTotal across reconnect blips (mutation: revert to append -> this fails)', () => {
      const flowCount = 3;
      const { bundle, cfg } = build({ flowCount });
      const pool = createSendPool({ flows: bundle.flows });
      // Every slot connects, then every slot blips-and-reconnects repeatedly.
      for (let i = 0; i < flowCount; i += 1) cfg.onFlowUp(i, flow({ v: true }));
      expect(pool.aliveCount()).toBe(flowCount);
      for (let round = 0; round < 10; round += 1) {
        for (let i = 0; i < flowCount; i += 1) cfg.onFlowUp(i, flow({ v: true }));
        // The whole point: with append, this climbs to 33; with dedup it stays 3.
        expect(pool.aliveCount()).toBeLessThanOrEqual(flowCount);
      }
      expect(pool.aliveCount()).toBe(flowCount);
    });

    test('a slot that goes \'disconnected\' (supervisor marks not-alive, NO onFlowDown) stops counting live', () => {
      const { bundle, cfg } = build({ flowCount: 2 });
      const pool = createSendPool({ flows: bundle.flows });
      const a = { v: true }, b = { v: true };
      cfg.onFlowUp(0, flow(a));
      cfg.onFlowUp(1, flow(b));
      expect(pool.aliveCount()).toBe(2);
      a.v = false; // slot 0 'disconnected' — supervisor flips per-worker aliveness
      expect(pool.aliveCount()).toBe(1); // delegated liveness reflects it immediately
    });

    test('a slot that goes disconnected then failed is not counted live', () => {
      const { bundle, cfg } = build({ flowCount: 2 });
      const pool = createSendPool({ flows: bundle.flows });
      const a = { v: true }, b = { v: true };
      cfg.onFlowUp(0, flow(a));
      cfg.onFlowUp(1, flow(b));
      a.v = false;          // disconnected
      cfg.onFlowDown(0);    // then terminal/failed
      expect(pool.aliveCount()).toBe(1);
      // Even if the supervisor's per-worker flow somehow reported alive again, the
      // wrapper's own down-override keeps it dead until a fresh onFlowUp replaces it.
      a.v = true;
      expect(pool.aliveCount()).toBe(1);
    });
  });

  test('awaitFlow delegates to the supervisor\'s waiter (feeds the send pool)', () => {
    const { bundle, sup } = build();
    bundle.awaitFlow();
    expect(sup.awaitFlow).toHaveBeenCalled();
  });

  // Task 9: the bundle's redialCount is the supervisor's — the sender's
  // aggregate progress reads this for its `redials` health field.
  test('redialCount delegates to the supervisor\'s cumulative re-dial counter', () => {
    const { bundle, sup } = build();
    sup.redialCount.mockReturnValue(3);
    expect(bundle.redialCount()).toBe(3);
    expect(sup.redialCount).toHaveBeenCalled();
  });

  test('a slot-0 error: state is forwarded to onRendezvousError (fail fast on bad_password); non-slot-0 is not', () => {
    const { bundle, workers } = build({ flowCount: 2 });
    const errors = [];
    bundle.onRendezvousError((r) => errors.push(r));
    workers[1].__emit('error:host_offline'); // non-primary — not surfaced
    expect(errors).toEqual([]);
    workers[0].__emit('error:bad_password');
    expect(errors).toEqual(['bad_password']);
  });

  test('close() calls supervisor.stop() and fails+closes every worker channel (C2 cancel-path)', async () => {
    const { bundle, sup, workers } = build({ flowCount: 3 });
    await bundle.close();
    expect(sup.stop).toHaveBeenCalledTimes(1);
    workers.forEach((w) => {
      expect(w.channel.fail).toHaveBeenCalledWith('closed');
      expect(w.close).toHaveBeenCalled();
    });
  });

  // C2 with a REAL channel (mirrors openchannel-multiflow.test.js): an in-flight
  // sendBulk parked on a worker whose window will be destroyed must REJECT when
  // close() fails the channel first, not hang forever.
  test('close() fails a REAL channel first so an in-flight sendBulk rejects instead of hanging', async () => {
    const captured = [];
    const sup = fakeSupervisorFactory();
    const { close } = assembleSendFlows({
      flowCount: 1,
      createWorker: () => {
        const channel = createTransferChannel({ send: () => {}, on: () => {} });
        const w = { channel, onSessionState: vi.fn(), startRendezvous: vi.fn(), close: vi.fn(async () => {}) };
        captured.push(w);
        return w;
      },
      makeParams: () => ({}),
      createSupervisor: sup,
    });
    const pending = captured[0].channel.sendBulk(new ArrayBuffer(4));
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    await close();
    await expect(pending).rejects.toThrow();
  });
});

describe('dispatchReceiveFlowJoin (receiver rolling-join dispatch)', () => {
  test('flowIndex !== 0 routes to receiver.addFlow(channel, flowIndex)', () => {
    const sink = { addFlow: vi.fn(), setCtrl: vi.fn() };
    const ch = { onBulk: vi.fn() };
    dispatchReceiveFlowJoin(sink, ch, 2);
    expect(sink.addFlow).toHaveBeenCalledWith(ch, 2);
    expect(sink.setCtrl).not.toHaveBeenCalled();
  });

  // Important #1: flow 0 is BOTH ctrl AND bulk, so a re-dialed replacement flow 0
  // must be wired BOTH ways — setCtrl (control plane) AND addFlow(channel, 0)
  // (bulk routing) — or every bulk chunk on it lands nowhere (stall).
  test('flowIndex === 0 wires BOTH setCtrl AND addFlow(channel, 0) (ctrl + bulk)', () => {
    const sink = { addFlow: vi.fn(), setCtrl: vi.fn() };
    const ch = { onCtrl: vi.fn(), onBulk: vi.fn() };
    dispatchReceiveFlowJoin(sink, ch, 0);
    expect(sink.setCtrl).toHaveBeenCalledWith(ch);
    expect(sink.addFlow).toHaveBeenCalledWith(ch, 0);
  });

  test('a null sink (no active receive) is a no-op and returns false', () => {
    expect(dispatchReceiveFlowJoin(null, { onBulk() {} }, 2)).toBe(false);
  });
});

describe('main.js: rolling-join receive wiring (text-based — main.js imports electron)', () => {
  test('imports dispatchReceiveFlowJoin from the assembly module', () => {
    expect(main).toMatch(/import\s*\{[^}]*\bdispatchReceiveFlowJoin\b[^}]*\}\s*from\s*['"]\.\/transfer-channel-assembly\.js['"]/);
  });
  test('createGroupRendezvous is given an onFlowJoin handler', () => {
    expect(main).toMatch(/onFlowJoin:/);
  });
  test('onFlowJoin looks up the active receive sink by the handle\'s groupId and dispatches (or closes the handle)', () => {
    expect(main).toMatch(/getReceiveFlowSink\(/);
    expect(main).toMatch(/dispatchReceiveFlowJoin\(/);
  });
  test('the attach handle carries groupId so a late join can be routed to the right receive', () => {
    expect(main).toMatch(/openAttachFlow[\s\S]{0,400}groupId,/);
  });
});
