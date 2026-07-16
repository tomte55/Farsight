import { describe, it, expect } from 'vitest';
import { nextResumeAction } from '../src/transfer-resume.js';

const fleetJob = { jobId: 'j1', jobState: 'interrupted', tier: 'fleet', peer: { deviceId: 'devA' } };
const onlineA = { deviceId: 'devA', online: true };

describe('nextResumeAction', () => {
  it('re-establishes an interrupted own-fleet job when its peer comes online', () => {
    expect(nextResumeAction(fleetJob, onlineA)).toEqual({ type: 'reestablish', jobId: 'j1', deviceId: 'devA' });
  });

  it('does nothing for a user-paused job (no silent un-pause)', () => {
    const r = nextResumeAction({ ...fleetJob, jobState: 'paused' }, onlineA);
    expect(r.type).toBe('noop');
  });

  it('does nothing for an ad-hoc job (no standing credential to reconnect)', () => {
    const r = nextResumeAction({ ...fleetJob, tier: 'adhoc' }, onlineA);
    expect(r.type).toBe('noop');
  });

  it('does nothing when the event is a different device', () => {
    const r = nextResumeAction(fleetJob, { deviceId: 'devB', online: true });
    expect(r.type).toBe('noop');
  });

  it('does nothing on an offline event', () => {
    expect(nextResumeAction(fleetJob, { deviceId: 'devA', online: false }).type).toBe('noop');
  });

  it('does nothing when the job is already re-establishing (single-flight)', () => {
    const r = nextResumeAction(fleetJob, onlineA, { inFlight: new Set(['j1']) });
    expect(r.type).toBe('noop');
    expect(r.reason).toBe('already_in_flight');
  });

  it('does nothing for terminal / active states', () => {
    for (const s of ['done', 'error', 'canceled', 'active']) {
      expect(nextResumeAction({ ...fleetJob, jobState: s }, onlineA).type).toBe('noop');
    }
  });

  it('re-establishes an interrupted CONTACT job when its peer comes online', () => {
    const contactJob = { jobId: 'jc', jobState: 'interrupted', tier: 'contact', peer: { deviceId: 'devC' } };
    expect(nextResumeAction(contactJob, { deviceId: 'devC', online: true }))
      .toEqual({ type: 'reestablish', jobId: 'jc', deviceId: 'devC' });
  });

  it('still does nothing for an ad-hoc job', () => {
    const adhoc = { jobId: 'j1', jobState: 'interrupted', tier: 'adhoc', peer: { deviceId: 'devA' } };
    expect(nextResumeAction(adhoc, { deviceId: 'devA', online: true }).type).toBe('noop');
  });
});
