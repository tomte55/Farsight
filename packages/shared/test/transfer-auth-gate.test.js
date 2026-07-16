import { describe, it, expect } from 'vitest';
import { createTransferAuthGate } from '../src/transfer-auth-gate.js';

describe('transfer-auth-gate', () => {
  it('ad-hoc (linked:false) is a transparent pass-through', () => {
    const g = createTransferAuthGate({ linked: false });
    expect(g.state).toBe('open');
    expect(g.canSendOutbound()).toBe(true);
    expect(g.inboundOffer({ t: 'offer' })).toEqual({ t: 'offer' });
  });

  it('linked initiator holds the outbound OFFER until auth ok', () => {
    const g = createTransferAuthGate({ linked: true });
    expect(g.state).toBe('pending');
    expect(g.canSendOutbound()).toBe(false); // held
    const r = g.resolve(true);
    expect(r.fail).toBe(false);
    expect(r.releaseOutbound).toBe(true); // the held request is released
    expect(g.state).toBe('open');
    expect(g.canSendOutbound()).toBe(true);
  });

  it('linked attacher buffers the inbound OFFER until auth ok, then releases it', () => {
    const g = createTransferAuthGate({ linked: true });
    expect(g.inboundOffer({ t: 'offer', jobId: 'j1' })).toBeUndefined(); // buffered
    const r = g.resolve(true);
    expect(r.releaseInbound).toEqual({ t: 'offer', jobId: 'j1' });
    expect(g.inboundOffer({ t: 'offer', jobId: 'j2' })).toEqual({ t: 'offer', jobId: 'j2' }); // now transparent
  });

  it('auth failure fails closed: nothing releases, ever', () => {
    const g = createTransferAuthGate({ linked: true });
    g.inboundOffer({ t: 'offer' });          // buffered
    g.canSendOutbound();                      // requested
    const r = g.resolve(false);
    expect(r.fail).toBe(true);
    expect(r.releaseInbound).toBeUndefined();
    expect(r.releaseOutbound).toBe(false);
    expect(g.state).toBe('failed');
    expect(g.inboundOffer({ t: 'offer' })).toBeUndefined();
    expect(g.canSendOutbound()).toBe(false);
  });

  it('resolve is idempotent (a late second result is a no-op)', () => {
    const g = createTransferAuthGate({ linked: true });
    g.resolve(true);
    const r = g.resolve(false);
    expect(r).toEqual({ releaseInbound: undefined, releaseOutbound: false, fail: false });
    expect(g.state).toBe('open');
  });
});
