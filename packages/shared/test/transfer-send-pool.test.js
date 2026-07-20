// packages/shared/test/transfer-send-pool.test.js
import { describe, it, expect } from 'vitest';
import { createSendPool } from '../src/transfer-send-pool.js';
import { decodeBulkFrame } from '../src/transfer-chunk.js';

// Fake flow that records frames and resolves immediately.
function fakeFlow({ alive = true } = {}) {
  const sent = [];
  let live = alive;
  return {
    sent,
    kill() { live = false; },
    isAlive: () => live,
    sendBulk: (buf) => { if (!live) return Promise.reject(new Error('dead')); sent.push(decodeBulkFrame(buf)); return Promise.resolve(); },
  };
}

async function* chunks(n) {
  for (let i = 0; i < n; i++) yield { fileId: 0, offset: i * 4, length: 4, payload: new Uint8Array([i, i, i, i]) };
}

describe('transfer-send-pool', () => {
  it('delivers every chunk exactly once across flows', async () => {
    const flows = [fakeFlow(), fakeFlow(), fakeFlow()];
    await createSendPool({ flows }).run(chunks(30));
    const all = flows.flatMap((f) => f.sent).map((c) => c.offset).sort((a, b) => a - b);
    expect(all).toEqual([...Array(30)].map((_, i) => i * 4));
  });

  it('spreads concurrent sends across all live flows (not just the first)', async () => {
    // Flows that stay BUSY until released, so the pool must use other flows for
    // the next chunks — this pins real distribution, which immediate-resolve fakes cannot.
    const releasers = [];
    const flows = [0, 1, 2].map(() => {
      const sent = [];
      return {
        sent,
        isAlive: () => true,
        sendBulk: (buf) => new Promise((res) => { sent.push(decodeBulkFrame(buf)); releasers.push(res); }),
      };
    });
    const pool = createSendPool({ flows });
    const runP = pool.run(chunks(3)); // 3 chunks, 3 flows
    await new Promise((r) => setTimeout(r, 0)); // let dispatch settle
    expect(flows.map((f) => f.sent.length)).toEqual([1, 1, 1]); // each flow got exactly one, concurrently
    releasers.forEach((r) => r());
    await runP;
  });

  it('requeues a dead flow\'s chunk onto a live flow', async () => {
    const good = fakeFlow();
    const bad = fakeFlow();
    bad.kill(); // rejects every send
    await createSendPool({ flows: [good, bad] }).run(chunks(10));
    expect(good.sent.map((c) => c.offset).sort((a, b) => a - b)).toEqual([...Array(10)].map((_, i) => i * 4));
  });

  it('throws no_live_flows when all flows die with chunks remaining', async () => {
    const a = fakeFlow(); const b = fakeFlow();
    a.kill(); b.kill();
    await expect(createSendPool({ flows: [a, b] }).run(chunks(5))).rejects.toThrow('no_live_flows');
  });

  // C1 (THE deadlock test): the real bug this fix closes. Before the fix,
  // transfer-channel.js's sendBulk only settled on an 'ft-bulk-credit' event —
  // never on flow death — so a chunk in flight on a dying flow left its
  // sendBulk promise pending FOREVER. The pool's run() loop then blocks on
  // Promise.race(inflight) with an entry that never settles: inflight.size
  // never reaches 0, and the never-settling promise is also never removed
  // from `inflight`, so run() hangs permanently. The fix (transfer-channel.js
  // fail() + assembleSendFlows calling it on a terminal session state) makes
  // sendBulk REJECT on flow death instead of hanging — this test simulates
  // that externally: `dying`'s sendBulk returns a promise that this test
  // controls directly (no internal timer/resolution), and only reject()ing it
  // (never resolving it) frees the pool.
  //
  // Mutation check performed by hand: commenting out the `reject(...)` call
  // below (so the dying flow's promise is NEVER settled, matching the
  // pre-fix bug) makes this test hang / time out — confirming the assertion
  // is actually exercising the fix, not passing for an unrelated reason.
  it('does not hang when a flow dies mid-send (rejects instead of hanging) — pool retires it and requeues onto a survivor', async () => {
    const good = fakeFlow();
    let rejectDying = null;
    const dying = {
      sent: [],
      isAlive: () => true, // still "alive" per aliveness tracking — only its sendBulk has stalled/rejected
      sendBulk: (buf) => new Promise((_resolve, reject) => { rejectDying = reject; }),
    };

    const pool = createSendPool({ flows: [dying, good] });
    const runP = pool.run(chunks(5));

    // Let the pool dispatch: dying takes chunk 0 (first idle flow), good is
    // still idle so it keeps taking subsequent chunks while dying is stuck.
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof rejectDying).toBe('function'); // dying's sendBulk was actually called and is pending

    // Simulate the flow dying: something (assembleSendFlows' onSessionState
    // handler, in production) calls channel.fail(), which rejects this
    // pending sendBulk. Without this reject, `runP` never resolves.
    rejectDying(new Error('flow_dead'));

    await runP; // must complete — this is what hangs/times out pre-fix

    const allOffsets = [...good.sent].map((c) => c.offset).sort((a, b) => a - b);
    expect(allOffsets).toEqual([...Array(5)].map((_, i) => i * 4)); // every chunk delivered exactly once, all via the survivor
  });

  // Task 2: starvation (chunk pending, no usable flow, nothing inflight) should
  // WAIT for a resupplied flow via the injected awaitFlow, not throw immediately.
  it('awaitFlow resolves after a live flow is pushed -> held chunk dispatches, run() resolves', async () => {
    const dead = fakeFlow();
    dead.kill();
    const flows = [dead];
    let resolveAwait = null;
    const awaitFlow = () => new Promise((res) => { resolveAwait = res; });

    const pool = createSendPool({ flows, awaitFlow });
    const runP = pool.run(chunks(1));

    // Let the pool try to dispatch onto the dead flow, fail, and call awaitFlow.
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof resolveAwait).toBe('function'); // pool is waiting on awaitFlow, not throwing

    const live = fakeFlow();
    flows.push(live); // supervisor resupplies a live flow
    resolveAwait();

    await runP; // must resolve, not throw
    expect(live.sent.map((c) => c.offset)).toEqual([0]);
  });

  it('awaitFlow rejects -> run() rejects with no_live_flows', async () => {
    const dead = fakeFlow();
    dead.kill();
    const awaitFlow = () => Promise.reject(new Error('gave_up'));

    await expect(createSendPool({ flows: [dead], awaitFlow }).run(chunks(1)))
      .rejects.toThrow('no_live_flows');
  });

  it('no awaitFlow provided -> still throws no_live_flows immediately (regression)', async () => {
    const dead = fakeFlow();
    dead.kill();

    await expect(createSendPool({ flows: [dead] }).run(chunks(1)))
      .rejects.toThrow('no_live_flows');
  });

  // Plan 3 Task 6: an injected fake limiter's take(n) is awaited, on the ENCODED
  // frame's byte length (16-byte header + 4-byte payload = 20), BEFORE each
  // flow's sendBulk -- the one choke point every flow's dispatch passes
  // through, so ONE shared limiter instance paces the whole pool's aggregate
  // output regardless of which flow a chunk lands on.
  it('paces every flow through one injected limiter, take() called with the encoded frame length before sendBulk', async () => {
    const takenCalls = [];
    const limiter = { take: (n) => { takenCalls.push(n); return Promise.resolve(); } };
    const flows = [fakeFlow(), fakeFlow(), fakeFlow()];
    await createSendPool({ flows, limiter }).run(chunks(9));
    expect(takenCalls).toEqual(Array(9).fill(20)); // 16-byte header + 4-byte payload
    // Distributed across all 3 flows (not just flow 0) -- proves it's ONE shared
    // limiter pacing every flow's dispatch, not a per-flow gate.
    const perFlowCounts = flows.map((f) => f.sent.length);
    expect(perFlowCounts.every((c) => c > 0)).toBe(true);
    expect(perFlowCounts.reduce((a, b) => a + b, 0)).toBe(9);
  });

  // Byte-identical-when-unset: no limiter -> take() is never invoked and dispatch
  // is unaffected (same assertions as the very first test above, restated here to
  // pin the "absent limiter" contract explicitly against a limiter-aware pool).
  it('no limiter -> no pacing calls, delivery unaffected', async () => {
    const flows = [fakeFlow(), fakeFlow(), fakeFlow()];
    await createSendPool({ flows }).run(chunks(12));
    const all = flows.flatMap((f) => f.sent).map((c) => c.offset).sort((a, b) => a - b);
    expect(all).toEqual([...Array(12)].map((_, i) => i * 4));
  });

  // Task 3 (F-B11 defense-in-depth): a dispatched chunk whose sendBulk promise
  // NEVER settles (a 'connected'-but-wedged flow, a lost credit, any future
  // cause) must not block run() forever. A per-chunk stall timer (chunkStallMs)
  // is a backstop independent of WHY the promise is stuck -- it treats a timeout
  // exactly like a sendBulk rejection: the flow is retired for the run and the
  // chunk requeues onto a survivor.
  it('a dispatched chunk that never settles is reassigned after chunkStallMs; run() completes (F-B11 backstop)', async () => {
    let now = 0; const timers = [];
    const setTimer = (fn, ms) => { const id = { fn, at: now + ms }; timers.push(id); return id; };
    const clearTimer = (id) => { const i = timers.indexOf(id); if (i !== -1) timers.splice(i, 1); };
    const advance = (ms) => { now += ms; for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { clearTimer(t); t.fn(); } };

    const stuck = { isAlive: () => true, sendBulk: () => new Promise(() => {}) }; // never settles
    const good = { isAlive: () => true, sendBulk: () => Promise.resolve() };
    const pool = createSendPool({ flows: [stuck, good], encodeFrame: (c) => c, chunkStallMs: 10000, setTimer, clearTimer });
    const run = pool.run((async function* () { yield 'c0'; yield 'c1'; })());
    // Let dispatch happen (same convention as this file's other tests: a real
    // setTimeout(0) macrotask flushes every pending microtask first, which a
    // bare `await Promise.resolve()` does not reliably do for an async
    // generator's multi-tick next() resolution), then trip the stall timer.
    await new Promise((r) => setTimeout(r, 0));
    advance(10000);
    await expect(run).resolves.toBeUndefined(); // completes -- the stuck flow's chunk went to `good`
  });
});
