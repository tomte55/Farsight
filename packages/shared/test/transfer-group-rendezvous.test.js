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
});
