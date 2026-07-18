// packages/controller/test/multiflow-teardown.test.js
// Plan 3 Task 5: deterministic teardown of ALL N multi-flow transfer workers.
//
// CLAUDE.md gotcha ("a hidden transfer-worker BrowserWindow keeps the app
// alive") now applies xN: a multi-flow transfer opens N hidden BrowserWindows
// (createTransferWorker() per flow — see transfer-worker.js), and Electron's
// window-all-closed only fires once EVERY open window (main + session + all N
// workers) is actually closed. Task 4 already wired assembleSendFlows/
// assembleReceiveGroup's close() to Promise.all over every worker/handle (see
// openchannel-multiflow.test.js's "close() closes every worker/handle" tests)
// — this file adds the harder-to-fake invariants the brief calls for:
//   1. a worker that never got to 'connected' (errored, or simply never
//      progressed) is still tracked and still closed — not just the alive ones.
//   2. close() may legitimately fire TWICE for one transfer (transfer-service's
//      cancel() closes the channel directly, and runSend's/runMultiFlowReceive's
//      own `finally` ALSO calls close() once the aborted sender/receiver
//      settles — see transfer-service.js). This is only safe because
//      transfer-worker.js's real close() is idempotent (`if (closed) return;`
//      before win.destroy()) — pinned here as a text guard, since transfer-
//      worker.js imports 'electron' and can't be exercised directly outside a
//      real Electron process (codebase convention — see transfer-worker-
//      wiring.test.js).
//   3. a PARTIAL receive group (K < flowCount, join-window timeout) still
//      closes exactly its K opened handles, and a cancel(groupId) AFTER the
//      group already fired must not re-close handles already handed off to the
//      receiver (transfer-group-rendezvous.js's `!group.fired` guard) — while a
//      cancel BEFORE it fires must close what WAS opened, not leak it.
//   4. no app-alive leak: each createTransferWorker() call constructs a
//      genuinely NEW BrowserWindow (so N workers really are N windows Electron
//      counts toward window-all-closed), and the quit handler makes no
//      worker-count assumption of its own — it relies entirely on Electron's
//      real window count, which is why it generalizes to N with no code change.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { assembleSendFlows, assembleReceiveGroup } from '../src/transfer-channel-assembly.js';
import { createGroupRendezvous } from '@farsight/shared/transfer-group-rendezvous';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const workerModule = readFileSync(path.join(dir, '../src/transfer-worker.js'), 'utf8');

afterEach(() => { vi.useRealTimers(); });

function fakeWorker() {
  let stateCb = null;
  return {
    channel: { sendCtrl: vi.fn(), onCtrl: vi.fn(), sendBulk: vi.fn(), onBulk: vi.fn(), fail: vi.fn() },
    onSessionState: vi.fn((cb) => { stateCb = cb; }),
    startRendezvous: vi.fn(),
    close: vi.fn(async () => {}),
    __emit: (state) => stateCb && stateCb(state),
  };
}

// Models the REAL transfer-worker.js close() contract: a `closed` latch that
// makes a second invocation a no-op (win.destroy() called at most once), so a
// test built on this fixture proves "double bundle.close() is harmless"
// PROVIDED the real worker actually has that latch — which is pinned
// separately below (text guard on transfer-worker.js itself).
function idempotentFakeWorker() {
  let closed = false;
  let destroyCount = 0;
  return {
    channel: { sendCtrl: vi.fn(), onCtrl: vi.fn(), sendBulk: vi.fn(), onBulk: vi.fn(), fail: vi.fn() },
    onSessionState: vi.fn(),
    startRendezvous: vi.fn(),
    close: vi.fn(async () => { if (closed) return; closed = true; destroyCount += 1; }),
    get destroyCount() { return destroyCount; },
  };
}

function fakeHandle(flowIndex) {
  return { channel: { onBulk: vi.fn(), onCtrl: vi.fn(), sendCtrl: vi.fn() }, close: vi.fn(async () => {}), peerAuth: Promise.resolve({ tier: 'fleet' }), flowIndex };
}

// Resilient multi-flow (Task 7) rewrote assembleSendFlows onto the flow
// supervisor: workers are no longer all created synchronously up front — the
// supervisor STAGGERS the initial dial and RE-DIALS dead slots over time. To
// keep these teardown invariants deterministic (not clock-dependent), inject a
// fake supervisor that dials every slot synchronously on start() and lets the
// test drive onFlowDown. The invariants themselves are unchanged: every worker
// EVER handed out is swept by close(), regardless of connection outcome, and a
// double bundle.close() tears each real worker down only once.
function fakeSupervisorFactory() {
  let cfg = null;
  const factory = (config) => {
    cfg = config;
    return {
      start: () => { for (let i = 0; i < config.flowCount; i += 1) config.createWorker(i); },
      stop: vi.fn(), // no-op: the bundle's own close() sweep is what these tests assert
      liveCount: () => 0,
      onSlotStarved: vi.fn(),
      awaitFlow: vi.fn(() => new Promise(() => {})),
    };
  };
  factory.cfg = () => cfg;
  return factory;
}

describe('SEND (assembleSendFlows): close() closes every worker regardless of connection outcome', () => {
  test('a slot that went TERMINAL before ever connecting is still tracked and still closed by close()', async () => {
    const workers = [];
    const sup = fakeSupervisorFactory();
    const { close } = assembleSendFlows({
      flowCount: 5,
      createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
      makeParams: () => ({}),
      createSupervisor: sup,
    });
    // Slot 2's worker went terminal (onFlowDown) before ANY slot connected — it
    // was still handed out, so it must be in the close() sweep, not dropped
    // because it never became "alive".
    sup.cfg().onFlowDown(2);
    await close();
    expect(workers.length).toBe(5);
    workers.forEach((w) => expect(w.close).toHaveBeenCalledTimes(1));
  });

  test('close() called twice (settle path + cancel path, per transfer-service.js) destroys each real worker only ONCE', async () => {
    const workers = [];
    const sup = fakeSupervisorFactory();
    const { close } = assembleSendFlows({
      flowCount: 4,
      createWorker: () => { const w = idempotentFakeWorker(); workers.push(w); return w; },
      makeParams: () => ({}),
      createSupervisor: sup,
    });
    // transfer-service.js's cancel() calls the openChannel-returned close()
    // directly; runSend's own `finally` ALSO calls the same close() once its
    // (now-aborted) sender promise settles — see runSend's
    // `if (close) { try { await close(); } catch {} }`, which runs
    // unconditionally regardless of whether cancel() already fired. Model
    // that exact double call here.
    await close();
    await close();
    workers.forEach((w) => {
      expect(w.close).toHaveBeenCalledTimes(2); // the bundle's close() was invoked twice...
      expect(w.destroyCount).toBe(1); // ...but each worker's real teardown only happened once
    });
  });
});

describe('transfer-worker.js: the idempotency guard that makes a double close() harmless', () => {
  test('close() latches BEFORE destroying the window, so a second call is a no-op', () => {
    // Anchors on the exact shape: `closed = true;` assigned before `win.destroy()`
    // is reached, guarded by an early `if (closed) return;`. Mutation check: if
    // this guard were removed, the double-close test above (against a REAL
    // worker instead of the idempotent fake) would call win.destroy() twice —
    // Electron's BrowserWindow.destroy() on an already-destroyed window is a
    // documented no-op, but removeListener churn / repeated attempts to close a
    // torn-down window is exactly the class of bug this guard forecloses.
    const closeMethod = workerModule.slice(workerModule.indexOf('close() {'));
    expect(closeMethod).toMatch(/if\s*\(closed\)\s*return;/);
    expect(closeMethod).toMatch(/closed\s*=\s*true;/);
    // The guard must come BEFORE the destroy call, not after (an after-the-fact
    // latch wouldn't prevent the second win.destroy() from running).
    const guardIdx = closeMethod.indexOf('closed = true;');
    const destroyIdx = closeMethod.indexOf('win.destroy()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(destroyIdx).toBeGreaterThan(guardIdx);
  });
});

describe('RECEIVE (assembleReceiveGroup + createGroupRendezvous): partial-group teardown', () => {
  test('a PARTIAL group (K=2 of flowCount=4, join-window timeout) closes exactly its 2 opened handles', () => {
    vi.useFakeTimers();
    const handlesByFlow = new Map();
    let ready = null;
    const gr2 = createGroupRendezvous({
      openFlow: ({ flowIndex }) => { const h = fakeHandle(flowIndex); handlesByFlow.set(flowIndex, h); return h; },
      onGroupReady: (g) => { ready = g; },
    });
    gr2.offer({ sessionId: 's0', groupId: 'G', flowIndex: 0, flowCount: 4, linked: false });
    gr2.offer({ sessionId: 's1', groupId: 'G', flowIndex: 1, flowCount: 4, linked: false });
    expect(ready).toBeNull(); // only 2 of 4 have arrived — not ready yet
    vi.advanceTimersByTime(8001); // default joinWindowMs
    expect(ready).not.toBeNull();
    expect(ready.flows.length).toBe(2);

    const bundle = assembleReceiveGroup(ready.flows);
    return bundle.close().then(() => {
      expect(handlesByFlow.get(0).close).toHaveBeenCalledTimes(1);
      expect(handlesByFlow.get(1).close).toHaveBeenCalledTimes(1);

      // main.js's onGroupReady always finally-calls groupRendezvous.cancel(groupId)
      // after startReceive() settles (see openchannel-multiflow.test.js) — by then
      // the group has already fired, so cancel() must NOT re-close handles the
      // receiver was already handed (they may be mid-teardown from the close()
      // above, or in a real run, mid-transfer).
      gr2.cancel('G');
      expect(handlesByFlow.get(0).close).toHaveBeenCalledTimes(1); // still 1, not 2
      expect(handlesByFlow.get(1).close).toHaveBeenCalledTimes(1);
    });
  });

  test('cancel(groupId) called BEFORE the group ever fires closes the flows that DID open (no leak of the partial join)', () => {
    vi.useFakeTimers();
    const handlesByFlow = new Map();
    let ready = null;
    const gr = createGroupRendezvous({
      openFlow: ({ flowIndex }) => { const h = fakeHandle(flowIndex); handlesByFlow.set(flowIndex, h); return h; },
      onGroupReady: (g) => { ready = g; },
    });
    // Only 1 of 3 flows has arrived — nowhere near ready, and the join window
    // hasn't elapsed either.
    gr.offer({ sessionId: 's0', groupId: 'G2', flowIndex: 0, flowCount: 3, linked: false });
    expect(ready).toBeNull();
    expect(handlesByFlow.get(0).close).not.toHaveBeenCalled();

    gr.cancel('G2');
    expect(handlesByFlow.get(0).close).toHaveBeenCalledTimes(1); // the one opened flow IS closed

    // The join-window timer was cleared by cancel() — advancing past it must
    // not resurrect the group or fire onGroupReady for a canceled join.
    vi.advanceTimersByTime(10000);
    expect(ready).toBeNull();
    expect(handlesByFlow.get(0).close).toHaveBeenCalledTimes(1); // no extra close either
  });
});

describe('no app-alive leak: N workers are N real BrowserWindows, and the quit path makes no fixed-count assumption', () => {
  test('createTransferWorker() always constructs a fresh `new BrowserWindow(...)` (no pooling/reuse)', () => {
    // If a future change pooled/reused a single BrowserWindow across flows,
    // window-all-closed would fire long before all N logical flows actually
    // finished, and Electron's own window accounting (which the quit handler
    // relies on entirely — see below) would silently undercount live workers.
    expect(workerModule).toMatch(/const win = new BrowserWindow\(\{/);
    expect(workerModule).toMatch(/workerCounter \+= 1;/);
  });

  test('the window-all-closed quit handler is unconditioned on any specific worker/window reference', () => {
    const idx = main.indexOf("app.on('window-all-closed'");
    expect(idx).toBeGreaterThan(-1);
    const handler = main.slice(idx, idx + 160);
    // Exactly the lifecycle/platform gate — no worker array, no "if (workers.
    // every(...))"-style bookkeeping of its own. It generalizes to N because it
    // never counts workers itself; it trusts Electron's real open-window count.
    expect(handler).toMatch(/lifecycle\.isQuitting\(\)/);
    expect(handler).toMatch(/app\.quit\(\)/);
    expect(handler).not.toMatch(/worker/i);
  });

  test('the multi-flow SEND branch returns assembleSendFlows(...) directly (close is never stripped/rewrapped)', () => {
    // A regression here (destructuring {ctrl, flows} out and hand-building a
    // NEW return object that forgets `close`) would silently drop the
    // all-workers teardown this whole file is about, while every other test
    // still passed (nothing else observes `close` at the main.js call site).
    expect(main).toMatch(/return assembleSendFlows\(\{/);
  });
});
