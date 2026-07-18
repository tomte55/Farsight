// packages/shared/test/transfer-group-rendezvous.test.js
import { describe, it, expect, vi } from 'vitest';
import { createGroupRendezvous } from '../src/transfer-group-rendezvous.js';

function fakeClock() {
  let seq = 1; const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = seq++; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
    fireAll: () => { const cur = [...timers.values()]; timers.clear(); cur.forEach((fn) => fn()); },
  };
}
const GROUP = 'g'.repeat(32);

describe('createGroupRendezvous', () => {
  it('fires onGroupReady once, with all flows, when flowCount requests arrive', () => {
    const opened = [];
    const ready = [];
    const gr = createGroupRendezvous({ openFlow: (r) => { opened.push(r.flowIndex); return { flowIndex: r.flowIndex, close: () => {} }; }, onGroupReady: (g) => ready.push(g) });
    for (let i = 0; i < 3; i++) gr.offer({ sessionId: `s${i}`, groupId: GROUP, flowIndex: i, flowCount: 3, linked: true });
    expect(ready.length).toBe(1);
    expect(ready[0].flowCount).toBe(3);
    expect(ready[0].flows.map((f) => f.flowIndex).sort()).toEqual([0, 1, 2]);
    expect(opened.sort()).toEqual([0, 1, 2]);
  });

  it('proceeds with a partial group when the join window elapses', () => {
    const clock = fakeClock();
    const ready = [];
    const gr = createGroupRendezvous({ openFlow: (r) => ({ flowIndex: r.flowIndex, close: () => {} }), onGroupReady: (g) => ready.push(g), joinWindowMs: 5000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    gr.offer({ sessionId: 's0', groupId: GROUP, flowIndex: 0, flowCount: 3, linked: true }); // only 1 of 3 arrives
    expect(ready.length).toBe(0);
    clock.fireAll(); // join window elapses
    expect(ready.length).toBe(1);
    expect(ready[0].flows.length).toBe(1); // proceed with the one that connected
  });

  it('treats a legacy request (no groupId/flowCount) as a single-flow group immediately', () => {
    const ready = [];
    const gr = createGroupRendezvous({ openFlow: (r) => ({ flowIndex: 0, close: () => {} }), onGroupReady: (g) => ready.push(g) });
    gr.offer({ sessionId: 's0' }); // no group fields
    expect(ready.length).toBe(1);
    expect(ready[0].flowCount).toBe(1);
  });

  it('ignores a duplicate (groupId, flowIndex)', () => {
    const opened = [];
    const gr = createGroupRendezvous({ openFlow: (r) => { opened.push(r.flowIndex); return { flowIndex: r.flowIndex, close: () => {} }; }, onGroupReady: () => {} });
    gr.offer({ sessionId: 's0', groupId: GROUP, flowIndex: 0, flowCount: 3 });
    gr.offer({ sessionId: 's0b', groupId: GROUP, flowIndex: 0, flowCount: 3 }); // dup index
    expect(opened).toEqual([0]);
  });

  it('does not re-fire onGroupReady when the stale join-timer callback still runs after the count-path already fired the group', () => {
    // A plain fakeClock's clearTimer deletes the timer from its map, so a
    // *cleared* timer can never be re-invoked via fireAll() — that would only
    // prove clearTimer works, not that fireReady's own `fired` guard holds.
    // Capture the timer callback directly (bypassing clearTimer's removal) to
    // simulate the real race this guard defends against: the join-timer
    // callback still runs even though the group already resolved via the
    // count path.
    let timerFn;
    const setTimer = (fn) => { timerFn = fn; return 1; };
    const clearTimer = () => {};
    const ready = [];
    const gr = createGroupRendezvous({ openFlow: (r) => ({ flowIndex: r.flowIndex, close: () => {} }), onGroupReady: (g) => ready.push(g), joinWindowMs: 5000, setTimer, clearTimer });
    for (let i = 0; i < 3; i++) gr.offer({ sessionId: `s${i}`, groupId: GROUP, flowIndex: i, flowCount: 3, linked: true });
    expect(ready.length).toBe(1); // count-path fired already
    timerFn(); // stale timer callback still runs; fireReady's `fired` guard must no-op
    expect(ready.length).toBe(1);
  });

  it('does not re-fire onGroupReady when late offers arrive after a partial-timeout fire', () => {
    const clock = fakeClock();
    const ready = [];
    const gr = createGroupRendezvous({ openFlow: (r) => ({ flowIndex: r.flowIndex, close: () => {} }), onGroupReady: (g) => ready.push(g), joinWindowMs: 5000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    gr.offer({ sessionId: 's0', groupId: GROUP, flowIndex: 0, flowCount: 3, linked: true }); // 1 of 3
    clock.fireAll(); // partial-timeout fire with 1 flow
    expect(ready.length).toBe(1);
    gr.offer({ sessionId: 's1', groupId: GROUP, flowIndex: 1, flowCount: 3, linked: true }); // late
    gr.offer({ sessionId: 's2', groupId: GROUP, flowIndex: 2, flowCount: 3, linked: true }); // late
    expect(ready.length).toBe(1); // still exactly one ready
  });

  it('cancel() after the group has fired does NOT close the live flow handles', () => {
    let closed = 0;
    const gr = createGroupRendezvous({ openFlow: (r) => ({ flowIndex: r.flowIndex, close: () => { closed++; } }), onGroupReady: () => {} });
    for (let i = 0; i < 3; i++) gr.offer({ sessionId: `s${i}`, groupId: GROUP, flowIndex: i, flowCount: 3, linked: true });
    gr.cancel(GROUP);
    expect(closed).toBe(0);
  });

  it('cancel() before the group has fired DOES close the opened flow handles', () => {
    let closed = 0;
    const gr = createGroupRendezvous({ openFlow: (r) => ({ flowIndex: r.flowIndex, close: () => { closed++; } }), onGroupReady: () => {} });
    gr.offer({ sessionId: 's0', groupId: GROUP, flowIndex: 0, flowCount: 3, linked: true }); // 1 of 3, not ready
    gr.cancel(GROUP);
    expect(closed).toBe(1);
  });
});
