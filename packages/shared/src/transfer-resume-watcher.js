// packages/shared/src/transfer-resume-watcher.js
// SP3 Phase 4 (auto-resume): while any interrupted own-fleet transfer exists, poll
// the account fleet and re-establish each job when its device is online — resolving
// the device's CURRENT (ephemeral) signalingId by its stable deviceId. Pure-ish:
// all IO (list/fleet/reestablish) and timers are injected, so it unit-tests with
// fakes. The eligibility decision is the pure transfer-resume.nextResumeAction.
import { nextResumeAction } from './transfer-resume.js';

export function createResumeWatcher({ listInterrupted, getFleet, reestablish, pollMs = 20000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const inFlight = new Set();
  let timer = null;
  let running = false;

  function arm() { if (running && !timer) timer = setTimer(() => { tick(); }, pollMs); }

  // awaitReestablish=true (sweep/tests) resolves only after the re-established
  // sends settle; the interval path leaves them fire-and-forget (single-flight via
  // inFlight so a poll during an in-progress resume never spawns a duplicate).
  async function tick(awaitReestablish = false) {
    timer = null;
    if (!running) return;
    let jobs = [];
    try { jobs = await listInterrupted(); } catch { jobs = []; }
    const started = [];
    if (jobs.length) {
      let fleet = [];
      try { fleet = await getFleet(); } catch { fleet = []; }
      const byDevice = new Map(fleet.map((d) => [d.deviceId, d]));
      for (const job of jobs) {
        const deviceId = job.peer && job.peer.deviceId;
        const d = byDevice.get(deviceId);
        const action = nextResumeAction(job, { deviceId, online: !!(d && d.online) }, { inFlight });
        if (action.type === 'reestablish' && d && d.signalingId) {
          inFlight.add(job.jobId);
          started.push(Promise.resolve(reestablish(job, d.signalingId)).catch(() => {}).finally(() => inFlight.delete(job.jobId)));
        }
      }
      arm(); // more work remains → keep polling
    }
    // jobs empty → don't re-arm (idle; notify() re-arms when a new drop happens)
    if (awaitReestablish) await Promise.all(started);
  }

  return {
    start() { running = true; arm(); },
    stop() { running = false; if (timer) { clearTimer(timer); timer = null; } },
    // A job just became interrupted — make sure a poll is scheduled (re-arms an
    // idle watcher so it picks the job up within pollMs).
    notify() { arm(); },
    // Run one sweep immediately and resolve after the re-established sends settle
    // (an eager first retry / test hook). Requires start().
    sweep() { return running ? tick(true) : Promise.resolve(); },
  };
}
