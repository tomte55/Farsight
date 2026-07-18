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
});
