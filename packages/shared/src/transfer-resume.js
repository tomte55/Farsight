// packages/shared/src/transfer-resume.js
// SP3 Phase 4 (spec §5): pure decision — given a durable job record and a presence
// transition, should main re-establish the (own-fleet) transfer connection and
// resume from the .part offset? Own-fleet + interrupted + peer-online + not
// already in flight. User-paused stays paused; ad-hoc never auto-resumes.
export function nextResumeAction(job, event, { inFlight = new Set() } = {}) {
  if (!job || !event) return { type: 'noop', reason: 'no_input' };
  if (event.online !== true) return { type: 'noop', reason: 'peer_not_online' };
  if (job.tier !== 'fleet' && job.tier !== 'contact') return { type: 'noop', reason: 'not_resumable_tier' };
  if (job.jobState !== 'interrupted') return { type: 'noop', reason: `state_${job.jobState}` };
  const deviceId = job.peer && job.peer.deviceId;
  if (!deviceId || deviceId !== event.deviceId) return { type: 'noop', reason: 'peer_mismatch' };
  if (inFlight.has(job.jobId)) return { type: 'noop', reason: 'already_in_flight' };
  return { type: 'reestablish', jobId: job.jobId, deviceId };
}
