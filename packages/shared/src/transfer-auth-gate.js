// packages/shared/src/transfer-auth-gate.js
// SP3 Phase 4 (spec §4.3 / §6): a tiny pure sequencer that holds the manifest
// OFFER until the own-fleet device-keypair handshake (shared/connection-auth.js)
// resolves. On the ad-hoc path (linked:false) it is a transparent pass-through so
// the shipped password-gated flow is byte-identical. Fails closed on auth failure.
export function createTransferAuthGate({ linked = false } = {}) {
  let state = linked ? 'pending' : 'open'; // 'open' | 'pending' | 'failed'
  let heldInbound; // buffered inbound OFFER frame (attacher)
  let outboundRequested = false; // initiator asked to send while pending

  return {
    get state() { return state; },

    resolve(ok) {
      if (state !== 'pending') return { releaseInbound: undefined, releaseOutbound: false, fail: false };
      if (!ok) {
        state = 'failed';
        heldInbound = undefined; outboundRequested = false;
        return { releaseInbound: undefined, releaseOutbound: false, fail: true };
      }
      state = 'open';
      const releaseInbound = heldInbound; heldInbound = undefined;
      const releaseOutbound = outboundRequested; outboundRequested = false;
      return { releaseInbound, releaseOutbound, fail: false };
    },

    inboundOffer(frame) {
      if (state === 'open') return frame;
      if (state === 'failed') return undefined;
      heldInbound = frame;
      return undefined;
    },

    canSendOutbound() {
      if (state === 'open') return true;
      if (state === 'failed') return false;
      outboundRequested = true;
      return false;
    },
  };
}
