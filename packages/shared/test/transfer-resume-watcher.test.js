import { describe, it, expect } from 'vitest';
import { createResumeWatcher } from '../src/transfer-resume-watcher.js';

// Deterministic fake timer: setTimer records a pending callback; tick() fires all
// currently-pending callbacks (a "poll interval elapsed").
function fakeTimers() {
  let pending = [];
  return {
    setTimer: (fn) => { const h = { fn }; pending.push(h); return h; },
    clearTimer: (h) => { pending = pending.filter((x) => x !== h); },
    tick: async () => { const p = pending; pending = []; for (const h of p) await h.fn(); },
    pendingCount: () => pending.length,
  };
}

describe('transfer-resume-watcher', () => {
  it('re-establishes an interrupted own-fleet job only when its device is online, resolving the current signalingId, single-flight', async () => {
    const jobs = [{ jobId: 'j1', jobState: 'interrupted', tier: 'fleet', peer: { deviceId: 'devA' } }];
    let fleet = [{ deviceId: 'devA', signalingId: 'sigA', online: false }];
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const t = fakeTimers();
    const w = createResumeWatcher({
      listInterrupted: async () => jobs,
      getFleet: async () => fleet,
      reestablish: async (job, sigId) => { calls.push([job.jobId, sigId]); await gate; }, // stays in-flight until released
      pollMs: 100, setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.start();
    await t.tick();                       // offline → noop
    expect(calls).toEqual([]);
    fleet = [{ deviceId: 'devA', signalingId: 'sigA2', online: true }]; // online, NEW signalingId
    await t.tick();
    expect(calls).toEqual([['j1', 'sigA2']]);
    await t.tick();                       // still in-flight → no duplicate
    expect(calls.length).toBe(1);
    release();
    w.stop();
  });

  it('ignores ad-hoc and user-paused jobs, and stops polling when nothing is interrupted', async () => {
    let jobs = [
      { jobId: 'adhoc', jobState: 'interrupted', tier: 'adhoc', peer: { deviceId: 'd' } },
      { jobId: 'paused', jobState: 'paused', tier: 'fleet', peer: { deviceId: 'd' } },
    ];
    const calls = [];
    const t = fakeTimers();
    const w = createResumeWatcher({
      listInterrupted: async () => jobs,
      getFleet: async () => [{ deviceId: 'd', signalingId: 's', online: true }],
      reestablish: async (job) => { calls.push(job.jobId); },
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.start();
    await t.tick();
    expect(calls).toEqual([]);            // neither is an eligible own-fleet interrupted job
    jobs = [];                            // all resolved
    await t.tick();
    expect(t.pendingCount()).toBe(0);     // no more polling scheduled
    w.stop();
  });
});
